// Adapted from openclaw-voice-call-realtime (MIT) — https://github.com/TristanBrotherton/openclaw-voice-call-realtime

/**
 * OpenAI Realtime session: one WebSocket connection to the GA Realtime API
 * carrying a single phone call's audio, transcripts, and tool calls.
 *
 * Audio passthrough only: inbound mu-law Buffers are base64-encoded
 * straight into `input_audio_buffer.append`, and inbound audio deltas are
 * base64-decoded straight back into a Buffer — never transcoded, never
 * resampled.
 *
 * Uses the GA event shapes (`session.update` with `type: "realtime"`,
 * nested `audio.input`/`audio.output` format objects). Event handlers
 * accept both the GA event names and the legacy (beta) names OpenAI
 * retired, so a still-in-flight beta rollout can't silently drop audio or
 * transcripts.
 *
 * The API key is used only in the `Authorization` header of the outbound
 * connection — it is never included in the session config, logged, or
 * echoed into an error message.
 *
 * connect() cannot hang: it settles on session.updated, a pre-ack `error`
 * event (socket left open — the real API's response to a rejected
 * session.update), a socket error/close, or a bounded ack timeout,
 * whichever comes first. Every callback dispatch is exception-safe — a
 * throwing onAudioDelta/onToolCall/etc. (e.g. a dead Twilio socket, a pi
 * SDK dispatch failure) is caught and warned, never left to crash the
 * process. A socket that loses the race to settle connect() (a stale
 * attempt superseded by a reconnect, or one torn down on rejection) can
 * never mutate live-session state afterward — every handler is bound to
 * its own socket instance and a rejection tears that socket down.
 */

import { WebSocket } from "ws";

/** Function tool exposed to the realtime model during a call. */
export interface RealtimeToolDef {
  name: string;
  description: string;
  parameters: object;
}

export interface RealtimeCallbacks {
  onAudioDelta(mulaw: Buffer): void;
  onSpeechStarted(): void; // caller barge-in signal
  onTranscript(e: { role: "assistant" | "caller"; text: string }): void;
  onToolCall(e: { name: string; callId: string; args: Record<string, unknown> }): void;
  onClosed(reason: string): void;
}

interface RealtimeSessionOpts {
  apiKey: string;
  model: string;
  voice: string;
  instructions: string;
  tools: RealtimeToolDef[];
  callbacks: RealtimeCallbacks;
  urlOverride?: string;
  // Testability hook — real callers never need this; default matches the
  // reference's CONNECT_TIMEOUT_MS. Bounds how long connect() waits for
  // session.updated before giving up, so a malformed session.update that
  // the API silently ignores (no ack, no error, socket left open) can't
  // hang connect() — and the caller — forever.
  connectTimeoutMs?: number;
}

const DEFAULT_URL_BASE = "wss://api.openai.com/v1/realtime";
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;

// Fixed per the GA session config this bridge sends: server-side VAD only,
// tuned for phone-call turn-taking (not configurable in this MVP).
const VAD_THRESHOLD = 0.5;
const VAD_SILENCE_DURATION_MS = 800;

// Ruled by the task-9 review (supersedes the brief's literal session-config
// JSON, which omitted this): without requesting input transcription, the
// real API never emits conversation.item.input_audio_transcription.completed,
// so the caller-transcript branch below would be unreachable in production.
const INPUT_TRANSCRIPTION_MODEL = "gpt-4o-transcribe";

/** Shape of an OpenAI Realtime event this module reads; other fields (and
 * other event types entirely) are ignored. */
interface RealtimeEvent {
  type?: string;
  delta?: string;
  transcript?: string;
  item?: { type?: string; name?: string; call_id?: string; arguments?: string };
  error?: { code?: string; message?: string };
}

export class RealtimeSession {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly voice: string;
  private readonly tools: RealtimeToolDef[];
  private readonly callbacks: RealtimeCallbacks;
  private readonly url: string;
  private readonly connectTimeoutMs: number;

  // Mutated by updateInstructions(); re-sent as the session config on every
  // connect() so a caller-driven reconnect (ManagedRealtimeSession) doesn't
  // silently revert an in-call instructions swap (e.g. the AMD voicemail
  // switch) back to the original prompt.
  private instructions: string;

  private ws: WebSocket | undefined;
  private _ended = false;

  // The in-flight connect() promise's settlers, live only between connect()
  // being called and it settling. handleEvent() reaches into these (via
  // resolveConnect/rejectConnect) so a session.updated or a pre-ack error
  // event — arriving through the same JSON message path as everything else
  // — can settle connect() without duplicating event-parsing logic.
  private connectResolve: (() => void) | undefined;
  private connectReject: ((err: Error) => void) | undefined;
  private connectTimer: NodeJS.Timeout | undefined;

  constructor(opts: RealtimeSessionOpts) {
    this.apiKey = opts.apiKey;
    this.model = opts.model;
    this.voice = opts.voice;
    this.instructions = opts.instructions;
    this.tools = opts.tools;
    this.callbacks = opts.callbacks;
    this.url = opts.urlOverride ?? `${DEFAULT_URL_BASE}?model=${encodeURIComponent(opts.model)}`;
    this.connectTimeoutMs = opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  }

  get ended(): boolean {
    return this._ended;
  }

  /**
   * True only once the socket is actually OPEN (post session.updated ack).
   * `send()` below silently no-ops on any other readyState (CONNECTING, or
   * gone during a reconnect gap) — callers that need to know whether a call
   * like `updateInstructions()` actually reached the API, rather than
   * having been dropped on the floor, should check this first (added for
   * Task 12's AMD voicemail-switch, which must not claim a voicemail was
   * delivered when the send silently did nothing).
   */
  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /** Opens the WebSocket, sends the session config, and resolves once the
   * API acknowledges it with `session.updated` — never on the socket merely
   * opening. Rejects if the socket errors or closes first, if the API
   * responds with an `error` event instead of an ack (socket left open),
   * or if session.updated never arrives within connectTimeoutMs.
   *
   * Every handler below is bound to one specific socket instance (`ws`,
   * captured per call) and starts with `if (this.ws !== ws) return;` — once
   * a later connect() call (a reconnect) replaces `this.ws`, this socket is
   * stale and none of its events may touch live-session state again,
   * regardless of what order things settle in. Rejection additionally tears
   * the stale socket down (removeAllListeners + terminate) so it can't keep
   * dispatching events at all, rather than relying solely on the guard. See
   * task-9 review round 2: a rejected-but-not-torn-down socket could keep
   * delivering audio deltas, or later fire a close event that clobbered a
   * subsequently-succeeded reconnect's state. */
  async connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this._ended = false;
      this.connectResolve = resolve;
      this.connectReject = reject;

      const ws = new WebSocket(this.url, {
        headers: { Authorization: `Bearer ${this.apiKey}` }
      });
      this.ws = ws;

      this.connectTimer = setTimeout(() => {
        if (this.ws !== ws) return;
        this.rejectConnect(
          new Error(`OpenAI Realtime connection timed out waiting for session.updated (${this.connectTimeoutMs}ms)`),
          ws
        );
      }, this.connectTimeoutMs);
      this.connectTimer.unref?.();

      ws.on("open", () => {
        if (this.ws !== ws) return;
        this.send({ type: "session.update", session: this.buildSessionConfig() });
      });

      ws.on("message", (data: Buffer) => {
        if (this.ws !== ws) return;
        let event: RealtimeEvent;
        try {
          event = JSON.parse(data.toString()) as RealtimeEvent;
        } catch {
          // Malformed frame from the API — never log the raw payload, it
          // can carry caller speech content. Drop it silently.
          return;
        }
        this.safeHandleEvent(event, ws);
      });

      // A generic connection-level failure (DNS, TLS, refused handshake).
      // The close event that always follows is what actually settles
      // onClosed bookkeeping, to avoid firing onClosed twice for one
      // failure.
      ws.on("error", () => {
        if (this.ws !== ws) return;
        this.rejectConnect(new Error("OpenAI Realtime connection failed"), ws);
      });

      ws.on("close", (code: number, reasonBuf: Buffer) => {
        if (this.ws !== ws) return;
        const reason = describeClose(code, reasonBuf);
        this.rejectConnect(new Error(`OpenAI Realtime connection closed before session.updated (${reason})`), ws);
        this._ended = true;
        this.safeOnClosed(reason);
      });
    });
  }

  /** caller -> AI: append raw mu-law audio to the input buffer. */
  appendAudio(mulaw: Buffer): void {
    this.send({ type: "input_audio_buffer.append", audio: mulaw.toString("base64") });
  }

  /** Kick off a model response (e.g. the opening greeting, or continuing
   * after a tool result when respond !== false already triggered one). */
  createResponse(): void {
    this.send({ type: "response.create" });
  }

  /** Stop an in-flight response (barge-in). */
  cancelResponse(): void {
    this.send({ type: "response.cancel" });
  }

  /** Deliver a function tool's result back to the model. Unless
   * `respond === false`, also kicks off the model's next response (e.g.
   * `end_call` passes false — there is no one left to hear it). */
  sendToolResult(callId: string, output: string, respond?: boolean): void {
    this.send({
      type: "conversation.item.create",
      item: { type: "function_call_output", call_id: callId, output }
    });
    if (respond !== false) {
      this.send({ type: "response.create" });
    }
  }

  /** Update the session instructions mid-call (the AMD voicemail switch). */
  updateInstructions(text: string): void {
    this.instructions = text;
    this.send({ type: "session.update", session: { type: "realtime", instructions: text } });
  }

  close(): void {
    if (this._ended) return;
    this._ended = true;
    this.ws?.close();
  }

  private buildSessionConfig(): Record<string, unknown> {
    return {
      type: "realtime",
      output_modalities: ["audio"],
      audio: {
        input: {
          format: { type: "audio/pcmu" },
          transcription: { model: INPUT_TRANSCRIPTION_MODEL },
          turn_detection: {
            type: "server_vad",
            threshold: VAD_THRESHOLD,
            silence_duration_ms: VAD_SILENCE_DURATION_MS
          }
        },
        output: {
          format: { type: "audio/pcmu" },
          voice: this.voice
        }
      },
      instructions: this.instructions,
      tools: this.tools.map((tool) => ({
        type: "function",
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters
      }))
    };
  }

  // Wraps handleEvent so a throwing callback (onAudioDelta writing to a
  // socket, onToolCall dispatching into the pi SDK, etc.) can never escape
  // into the `ws` message emitter and crash the process — see task-9
  // review issue 3. A caught throw is warned (never logs the raw event,
  // which can carry caller speech content or a payload the API echoed).
  private safeHandleEvent(event: RealtimeEvent, ws: WebSocket): void {
    try {
      this.handleEvent(event, ws);
    } catch (err) {
      console.warn("[realtime] callback error:", err);
    }
  }

  private safeOnClosed(reason: string): void {
    try {
      this.callbacks.onClosed(reason);
    } catch (err) {
      console.warn("[realtime] onClosed callback error:", err);
    }
  }

  private handleEvent(event: RealtimeEvent, ws: WebSocket): void {
    switch (event.type) {
      case "session.updated":
        this.resolveConnect();
        break;

      // The API responded to session.update with an error instead of an
      // ack (socket stays open — no close/error transport event follows).
      // Pre-ack, this is why connect() would otherwise hang: settle it
      // with a sanitized message (only the API's own `code`/`message`
      // fields, never the API key, which never appears in event payloads
      // to begin with). Post-ack, OpenAI can emit non-fatal `error` events
      // during a call (e.g. response.cancel with nothing active) — this
      // session has no error-reporting callback to forward those to, so
      // they're ignored.
      case "error":
        if (this.connectReject) {
          this.rejectConnect(new Error(describeApiError(event)), ws);
        }
        break;

      // GA name first, legacy (beta) name kept as a fallback alias.
      case "response.output_audio.delta":
      case "response.audio.delta":
        if (typeof event.delta === "string") {
          this.callbacks.onAudioDelta(Buffer.from(event.delta, "base64"));
        }
        break;

      case "input_audio_buffer.speech_started":
        this.callbacks.onSpeechStarted();
        break;

      case "response.output_item.done": {
        const item = event.item;
        if (item?.type === "function_call" && item.name && item.call_id) {
          this.callbacks.onToolCall({
            name: item.name,
            callId: item.call_id,
            args: parseToolArgs(item.arguments)
          });
        }
        break;
      }

      case "conversation.item.input_audio_transcription.completed":
        if (typeof event.transcript === "string") {
          this.callbacks.onTranscript({ role: "caller", text: event.transcript });
        }
        break;

      case "response.output_audio_transcript.done":
      case "response.audio_transcript.done":
        if (typeof event.transcript === "string") {
          this.callbacks.onTranscript({ role: "assistant", text: event.transcript });
        }
        break;
    }
  }

  private resolveConnect(): void {
    if (!this.connectResolve) return;
    const resolve = this.connectResolve;
    this.clearConnectSettlers();
    resolve();
  }

  // Rejects the in-flight connect() promise (if one is still pending) and
  // tears the rejected socket down so it can never dispatch another event
  // or fire a close that mutates a since-superseded live session (task-9
  // review round 2). Safe to call from a handler whose socket has already
  // naturally closed (removeAllListeners/terminate on an already-closed
  // socket is a harmless no-op) and safe to call post-connect (the
  // `!this.connectReject` guard makes it a no-op — an active connection's
  // own eventual close must not be torn down here, only reported via
  // safeOnClosed by the caller).
  private rejectConnect(err: Error, ws: WebSocket): void {
    if (!this.connectReject) return;
    const reject = this.connectReject;
    this.clearConnectSettlers();
    this.teardownSocket(ws);
    reject(err);
  }

  private clearConnectSettlers(): void {
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = undefined;
    }
    this.connectResolve = undefined;
    this.connectReject = undefined;
  }

  private teardownSocket(ws: WebSocket): void {
    ws.removeAllListeners();
    // terminate() on a still-CONNECTING socket calls abortHandshake, which
    // schedules an 'error' emission on process.nextTick — after the
    // removeAllListeners() above has stripped every listener, an unhandled
    // 'error' event throws and crashes the process. Retain a no-op error
    // listener so that deferred emission has somewhere to land.
    ws.on("error", () => {});
    ws.terminate();
  }

  private send(payload: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
  }
}

// A malformed/missing function_call arguments string must not crash the
// session (the model producing bad JSON is a real-world possibility, not a
// bug in this bridge) — fall back to an empty args object.
function parseToolArgs(raw: string | undefined): Record<string, unknown> {
  try {
    return JSON.parse(raw ?? "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
}

function describeClose(code: number, reasonBuf: Buffer | undefined): string {
  const reasonText = reasonBuf && reasonBuf.length > 0 ? reasonBuf.toString() : "";
  return reasonText ? `${code}: ${reasonText}` : `${code}`;
}

// Only ever reads the API's own whitelisted `code`/`message` fields off an
// `error` event — never the rest of the payload — so this can never echo
// anything unexpected (and the API key never appears in event payloads to
// begin with).
function describeApiError(event: RealtimeEvent): string {
  const code = event.error?.code;
  const message = event.error?.message;
  const detail = [code, message].filter((v): v is string => typeof v === "string" && v.length > 0).join(": ");
  return detail ? `OpenAI Realtime API error (${detail})` : "OpenAI Realtime API error";
}
