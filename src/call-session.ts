/**
 * CallSession: one instance per answered call — the composition root of the
 * audio path. Wires MediaStreamConnection (Twilio) <-> RealtimeSession
 * (OpenAI) <-> call-brain (tool dispatch) <-> transcript/summary together
 * for exactly one call, and owns that call's teardown.
 *
 * `media` and `realtimeFactory`'s product are both already-constructed (or
 * factory-constructible) collaborators passed in — this class only wires
 * their handler graph together; it never opens sockets itself except the
 * realtime connection via `realtimeFactory(...).connect()`.
 */

import type { CallManager } from "./manager.js";
import type { MediaStreamConnection } from "./media-stream.js";
import { RealtimeSession } from "./realtime.js";
import type { ManagedRealtimeSession } from "./managed-realtime.js";
import type { Config } from "./config.js";
import type { CallOutcome, CallRecord } from "./types.js";
import { buildInstructions, inCallTools, handleToolCall } from "./call-brain.js";
import type { ToolActions } from "./call-brain.js";
import { generateDtmfMulaw } from "./dtmf.js";
import { TranscriptWriter } from "./transcript.js";
import type { summarizeCall } from "./summary.js";
import { CallStore } from "./store.js";

type RealtimeLike = ManagedRealtimeSession | RealtimeSession;

export class CallSession {
  private readonly record: CallRecord;
  private readonly manager: CallManager;
  private readonly media: MediaStreamConnection;
  private readonly realtimeFactory: (opts: ConstructorParameters<typeof RealtimeSession>[0]) => RealtimeLike;
  private readonly config: Config;
  private readonly summarize: typeof summarizeCall;
  private readonly store: CallStore;
  private readonly transcript: TranscriptWriter;

  private rt: RealtimeLike | undefined;
  // True once the end_call tool action has started ending the call — from
  // this point a caller's trailing audio triggering VAD must not
  // cancel/clear the goodbye that's already playing out.
  private ending = false;
  // Set only once the voicemail prompt swap is actually delivered to an
  // OPEN realtime socket (never when switchToVoicemail's send silently
  // no-op'd) — read by teardown (controller ruling 1) to default the
  // outcome when the model, which structurally can't call note_outcome in
  // that variant, never noted one. A false positive here would persist
  // "voicemail delivered" for a voicemail that was never actually spoken.
  private voicemailTriggered = false;
  // True once AMD leave-message has been requested but the realtime socket
  // wasn't OPEN yet to receive it (still connecting, or a reconnect gap —
  // includes the case where no CallSession existed at all when AMD fired;
  // server.ts stashes that case and replays it as switchToVoicemail() right
  // after this session is constructed, which lands here too). Applied the
  // moment the *initial* connect() succeeds; not re-checked on a later
  // mid-call reconnect (out of scope — see task-12 fix-round report).
  private pendingVoicemail = false;
  private teardownStarted = false;
  private finishRun: (() => void) | undefined;

  constructor(deps: {
    record: CallRecord;
    manager: CallManager;
    media: MediaStreamConnection;
    realtimeFactory: (opts: ConstructorParameters<typeof RealtimeSession>[0]) => RealtimeLike;
    config: Config;
    summarize: typeof summarizeCall;
  }) {
    // A local clone — deps.record may be the exact object CallManager holds
    // as its live `active` record (getByStreamToken returns it directly,
    // uncopied). Mutating that object in place (e.g. noteOutcome below)
    // would silently leak into CallManager's own state outside its own
    // persistence pipeline; this class only ever mutates its own copy.
    this.record = { ...deps.record };
    this.manager = deps.manager;
    this.media = deps.media;
    this.realtimeFactory = deps.realtimeFactory;
    this.config = deps.config;
    this.summarize = deps.summarize;
    this.store = new CallStore(deps.config.home);
    this.transcript = new TranscriptWriter(deps.config.home, this.record.id, {
      to: this.record.params.to,
      objective: this.record.params.objective
    });
  }

  get id(): string {
    return this.record.id;
  }

  /**
   * Resolves once the call is fully finalized (record persisted with its
   * terminal status, outcome, summary, and transcript path). Never rejects
   * — every failure path below is caught and logged, and teardown still
   * runs to completion regardless.
   */
  async run(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.finishRun = resolve;
      this.start().catch((err: unknown) => {
        console.error("[call-session] unexpected error starting the call:", err);
        void this.teardown();
      });
    });
  }

  /**
   * media.onAudio -> rt.appendAudio (caller speech into the model). Public
   * because MediaStreamConnection's handlers must be supplied at its own
   * construction — necessarily before this CallSession exists — so the
   * caller (server.ts) wires a forwarding closure into this method instead.
   */
  onCallerAudio(mulaw: Buffer): void {
    this.rt?.appendAudio(mulaw);
  }

  /** media.onStop -> one of the three teardown triggers (media-stream side). */
  onMediaStop(): void {
    void this.teardown();
  }

  /**
   * External abort — used by server.ts when a step it owns outside this
   * class's control fails in a way that leaves the call unable to proceed
   * (e.g. manager.markStreaming() rejecting: the record can never reach
   * in-progress, so the duration-cap timer never arms and this session
   * would otherwise run uncapped). Tears the session down exactly like any
   * other teardown trigger — idempotent, finalizes as "interrupted" if
   * nothing else already finalized the record.
   */
  abort(): void {
    void this.teardown();
  }

  /**
   * AMD machine + leave-message policy. Server.ts owns AMD routing (a
   * machine+hangup event can arrive before any media stream, and therefore
   * any CallSession, ever connects — see server.ts), and calls this once it
   * knows a leave-message policy applies and this session is the active
   * one (server.ts replays a pre-stream AMD event through this same method
   * right after constructing the session, so "no session yet" and "session
   * exists but isn't connected yet" both funnel through the pending path
   * below).
   *
   * If the realtime socket is OPEN, applies immediately. Otherwise — still
   * connecting, or a reconnect gap — updateInstructions()/createResponse()
   * would silently no-op (RealtimeSession.send() drops frames when the
   * socket isn't OPEN), so this stashes the request instead of falsely
   * marking it delivered; `start()` applies it once the initial connect()
   * succeeds.
   */
  switchToVoicemail(): void {
    if (this.rt?.isOpen) {
      this.applyVoicemail();
    } else {
      this.pendingVoicemail = true;
    }
  }

  private applyVoicemail(): void {
    this.voicemailTriggered = true;
    this.rt?.updateInstructions(buildInstructions(this.record.params, { voicemail: true }));
    this.rt?.createResponse();
  }

  private async start(): Promise<void> {
    this.manager.on("ended", this.handleManagerEnded);

    const opts: ConstructorParameters<typeof RealtimeSession>[0] = {
      apiKey: this.config.openai.apiKey,
      model: this.config.openai.realtimeModel,
      voice: this.record.params.voice ?? this.config.openai.voice,
      instructions: buildInstructions(this.record.params),
      tools: inCallTools(),
      callbacks: {
        onAudioDelta: (mulaw) => this.media.sendAudio(mulaw),
        onSpeechStarted: () => {
          // Suppressed once end_call has started ending the call — see
          // `ending`'s doc comment.
          if (this.ending) return;
          this.rt?.cancelResponse();
          this.media.sendClear();
        },
        onTranscript: (e) => this.transcript.add(e.role, e.text),
        onToolCall: (e) => {
          void this.dispatchToolCall(e);
        },
        onClosed: () => {
          void this.teardown();
        }
      }
    };

    // connectTimeoutMs/maxReconnectAttempts are deliberately NOT set here —
    // that's the realtimeFactory's job (server.ts's default factory sets
    // connectTimeoutMs: 5000, maxReconnectAttempts: 2 per the task-12
    // brief: the managed wrapper's worst-case connect wall time with
    // defaults is ~65s, far beyond what a live phone call can wait
    // through). During a reconnect gap inside ManagedRealtimeSession,
    // frames sent via appendAudio/sendToolResult below are silently
    // dropped and the model loses conversation history once it reconnects
    // — accepted for MVP (task-9 note).
    this.rt = this.realtimeFactory(opts);

    try {
      await this.rt.connect();
    } catch (err) {
      console.warn("[call-session] realtime connect failed:", err instanceof Error ? err.message : String(err));
      await this.teardown();
      return;
    }

    if (this.pendingVoicemail) {
      // AMD leave-message arrived before this session had a live socket to
      // apply it to (pre-stream, or during the initial connect) — apply it
      // now instead of the normal greet-first response, which would
      // otherwise race/duplicate it.
      this.pendingVoicemail = false;
      this.applyVoicemail();
      return;
    }

    this.rt.createResponse(); // the AI greets first
  }

  private handleManagerEnded = (rec: CallRecord): void => {
    if (rec.id !== this.record.id) return;
    void this.teardown(rec);
  };

  private async dispatchToolCall(e: { name: string; callId: string; args: Record<string, unknown> }): Promise<void> {
    const actions: ToolActions = {
      endCall: async (reason) => {
        this.ending = true;
        await this.media.waitForPlayoutDrained();
        await this.manager.endCall(this.record.id, reason);
      },
      sendDtmf: (digits) => {
        // Ruling: generateDtmfMulaw's output is not pre-chunked into
        // 20ms/160-byte Twilio frames — Twilio buffers arbitrary media
        // payload sizes, so the whole tone sequence is sent as a single
        // media event rather than paced/chunked.
        this.media.sendAudio(generateDtmfMulaw(digits));
      },
      noteOutcome: (outcome: CallOutcome) => {
        this.record.outcome = outcome;
      }
    };

    const result = await handleToolCall(e, actions);
    this.rt?.sendToolResult(e.callId, result.output, result.respond);
  }

  /**
   * Idempotency guard (controller ruling 3): media.onStop, rt.onClosed, and
   * manager "ended" can each independently fire for the same call, in any
   * order — this runs the finalize/flush/summarize/save sequence exactly
   * once no matter which trigger (or triggers) arrive, and never throws:
   * every step below is individually guarded so a failure in one doesn't
   * skip the rest.
   */
  private async teardown(finalRecord?: CallRecord): Promise<void> {
    if (this.teardownStarted) return;
    this.teardownStarted = true;

    this.manager.off("ended", this.handleManagerEnded);

    // Both are safe/idempotent no-ops on an already-closed connection, so
    // it's correct to call both regardless of which side triggered
    // teardown.
    try {
      this.media.close();
    } catch (err) {
      console.warn("[call-session] media.close() failed during teardown:", err);
    }
    try {
      this.rt?.close();
    } catch (err) {
      console.warn("[call-session] realtime.close() failed during teardown:", err);
    }

    // If nothing already finalized the record (the stream or realtime
    // session died with no terminal callback from the manager), finalize
    // now. finalize() is idempotent — a no-op warn if already terminal.
    // Controller ruling 2: finalize() cannot carry an endReason, so this
    // path leaves endReason unset; accepted.
    if (!finalRecord) {
      try {
        await this.manager.finalize(this.record.id, "interrupted");
      } catch (err) {
        console.warn("[call-session] finalize(interrupted) failed:", err);
      }
    }

    // Controller ruling 1: the AMD leave-message branch triggered and the
    // call ended with no noted outcome (the voicemail prompt variant
    // structurally can't call note_outcome) — default it before
    // summarization so summarizeCall receives it as notedOutcome.
    if (this.voicemailTriggered && this.record.outcome === undefined) {
      this.record.outcome = {
        outcome: "voicemail-left",
        details: "answering machine detected; voicemail delivered"
      };
    }

    let transcriptPath: string | undefined;
    try {
      transcriptPath = await this.transcript.flush();
    } catch (err) {
      console.warn("[call-session] transcript flush failed:", err);
    }

    const transcriptText = this.transcript.entries.map((entry) => `${entry.role}: ${entry.text}`).join("\n");
    // summarizeCall never throws (falls back to notedOutcome/"unknown" +
    // an explanatory summary string on any failure) — no try/catch needed.
    const summary = await this.summarize({
      apiKey: this.config.openai.apiKey,
      model: this.config.summaryModel,
      objective: this.record.params.objective,
      transcript: transcriptText,
      notedOutcome: this.record.outcome
    });

    try {
      // Prefer the manager's own authoritative final record (from the
      // "ended" event) when we have one; otherwise re-read what finalize()
      // just persisted above, so the terminal status/endedAt/endReason it
      // set aren't clobbered by this class's own stale constructor-time
      // snapshot.
      const base = finalRecord ?? (await this.store.get(this.record.id)) ?? this.record;
      const updated: CallRecord = {
        ...base,
        // The in-call noted outcome (note_outcome, or ruling 1's
        // voicemail-left default) always wins when present — it was set
        // with full in-call context. Otherwise, fall back to the
        // summarizer's own derived outcome rather than persisting no
        // outcome at all: every call that ends without note_outcome ever
        // firing (caller hangup, duration cap, an interrupted stream) would
        // otherwise silently lose the outcome summarizeCall already
        // computed (it always returns one — "unknown" is its own failure
        // fallback, still an outcome). summarizeCall is passed
        // this.record.outcome as notedOutcome above, so when that *is*
        // present its own `outcome` field typically just echoes it back.
        outcome: this.record.outcome ?? { outcome: summary.outcome },
        summary: summary.summary,
        ...(transcriptPath !== undefined ? { transcriptPath } : {})
      };
      await this.store.save(updated);
    } catch (err) {
      console.warn("[call-session] saving call summary/outcome failed:", err);
    }

    this.finishRun?.();
  }
}
