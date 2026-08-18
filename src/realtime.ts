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
}

const DEFAULT_URL_BASE = "wss://api.openai.com/v1/realtime";

// Fixed per the GA session config this bridge sends: server-side VAD only,
// tuned for phone-call turn-taking (not configurable in this MVP).
const VAD_THRESHOLD = 0.5;
const VAD_SILENCE_DURATION_MS = 800;

/** Shape of an OpenAI Realtime event this module reads; other fields (and
 * other event types entirely) are ignored. */
interface RealtimeEvent {
  type?: string;
  delta?: string;
  transcript?: string;
  item?: { type?: string; name?: string; call_id?: string; arguments?: string };
}

export class RealtimeSession {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly voice: string;
  private readonly tools: RealtimeToolDef[];
  private readonly callbacks: RealtimeCallbacks;
  private readonly url: string;

  // Mutated by updateInstructions(); re-sent as the session config on every
  // connect() so a caller-driven reconnect (ManagedRealtimeSession) doesn't
  // silently revert an in-call instructions swap (e.g. the AMD voicemail
  // switch) back to the original prompt.
  private instructions: string;

  private ws: WebSocket | undefined;
  private _ended = false;

  constructor(opts: RealtimeSessionOpts) {
    this.apiKey = opts.apiKey;
    this.model = opts.model;
    this.voice = opts.voice;
    this.instructions = opts.instructions;
    this.tools = opts.tools;
    this.callbacks = opts.callbacks;
    this.url = opts.urlOverride ?? `${DEFAULT_URL_BASE}?model=${encodeURIComponent(opts.model)}`;
  }

  get ended(): boolean {
    return this._ended;
  }

  /** Opens the WebSocket, sends the session config, and resolves once the
   * API acknowledges it with `session.updated` — never on the socket merely
   * opening. Rejects if the socket errors or closes first. */
  async connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      this._ended = false;

      const ws = new WebSocket(this.url, {
        headers: { Authorization: `Bearer ${this.apiKey}` }
      });
      this.ws = ws;

      ws.on("open", () => {
        this.send({ type: "session.update", session: this.buildSessionConfig() });
      });

      ws.on("message", (data: Buffer) => {
        let event: RealtimeEvent;
        try {
          event = JSON.parse(data.toString()) as RealtimeEvent;
        } catch {
          // Malformed frame from the API — never log the raw payload, it
          // can carry caller speech content. Drop it silently.
          return;
        }
        if (!settled && event.type === "session.updated") {
          settled = true;
          resolve();
        }
        this.handleEvent(event);
      });

      // A generic connection-level failure (DNS, TLS, refused handshake).
      // The close event that always follows is what actually settles
      // rejection/onClosed bookkeeping, to avoid firing onClosed twice for
      // one failure.
      ws.on("error", () => {
        if (!settled) {
          settled = true;
          reject(new Error("OpenAI Realtime connection failed"));
        }
      });

      ws.on("close", (code: number, reasonBuf: Buffer) => {
        const reason = describeClose(code, reasonBuf);
        if (!settled) {
          settled = true;
          reject(new Error(`OpenAI Realtime connection closed before session.updated (${reason})`));
        }
        this._ended = true;
        this.callbacks.onClosed(reason);
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

  private handleEvent(event: RealtimeEvent): void {
    switch (event.type) {
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
