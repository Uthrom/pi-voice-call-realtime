// Adapted from openclaw-voice-call-realtime (MIT) — https://github.com/TristanBrotherton/openclaw-voice-call-realtime

/**
 * Managed wrapper around RealtimeSession: same public surface, plus
 * automatic reconnect (5 attempts, exponential backoff starting at 500ms),
 * an idle timeout (120s of no session activity), and a max session cap
 * (2h wall clock from the first successful connect).
 *
 * `connect()` itself retries through the backoff schedule — a call that
 * fails once (a transient refusal, a cold API) still resolves once a later
 * attempt succeeds, up to the attempt budget. A mid-call disconnect after a
 * successful connect is reconnected transparently in the background: the
 * caller only ever observes `onClosed` if every attempt in that episode's
 * budget is exhausted, or if the session ends deliberately (close(), the
 * idle timeout, or the max-session cap).
 */

import { RealtimeSession } from "./realtime.js";
import type { RealtimeCallbacks, RealtimeToolDef } from "./realtime.js";

interface ManagedRealtimeSessionOpts {
  apiKey: string;
  model: string;
  voice: string;
  instructions: string;
  tools: RealtimeToolDef[];
  callbacks: RealtimeCallbacks;
  urlOverride?: string;
  // Forwarded to the inner RealtimeSession via the `{ ...opts }` spread in
  // the constructor below (RealtimeSessionOpts already accepts it) — not
  // read by this class itself. Task-9's report flagged this as missing:
  // without it, a caller has no way to bound the managed wrapper's
  // worst-case connect wall time (~65s with every default: 5 reconnect
  // attempts x the 10s per-attempt ack timeout, plus backoff) to something
  // a live phone call can actually wait through. Task 12's server.ts
  // factory sets this to 5000.
  connectTimeoutMs?: number;
  // Testability hooks — real callers never need these, defaults match the
  // brief exactly. Kept optional so `ConstructorParameters<typeof
  // RealtimeSession>[0]` remains structurally assignable to this type.
  reconnectBaseDelayMs?: number;
  maxReconnectAttempts?: number;
  idleTimeoutMs?: number;
  maxSessionMs?: number;
}

const DEFAULT_RECONNECT_BASE_DELAY_MS = 500;
const DEFAULT_MAX_RECONNECT_ATTEMPTS = 5;
const DEFAULT_IDLE_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_SESSION_MS = 2 * 60 * 60 * 1000;

type ManagedState = "idle" | "connecting" | "active" | "closed";

export class ManagedRealtimeSession {
  private readonly inner: RealtimeSession;
  private readonly outerCallbacks: RealtimeCallbacks;
  private readonly reconnectBaseDelayMs: number;
  private readonly maxReconnectAttempts: number;
  private readonly idleTimeoutMs: number;
  private readonly maxSessionMs: number;

  private state: ManagedState = "idle";
  // Public-facing "is this session over" flag, set synchronously wherever
  // the session becomes permanently done (close(), exhausting the
  // reconnect budget). Deliberately separate from `state`: `state` also
  // transiently reads "closed"/"connecting" for internal reconnect-routing
  // purposes ahead of the underlying socket's own async close event, but
  // callers polling `ended` right after close() must see `true`
  // immediately, not once the WebSocket teardown round-trip completes.
  private _ended = false;
  private reconnectAttempts = 0;
  // True once this session is meant to end for good: an explicit close(),
  // the idle timeout, or the max-session cap firing. Distinguishes a
  // deliberate shutdown's resulting socket-close from one that should be
  // reconnected.
  private shuttingDown = false;
  // Set just before a deliberate shutdown closes the inner session, so the
  // onClosed reason reported to the caller is meaningful ("idle_timeout",
  // "max_session_reached", "manual_close") rather than a raw WebSocket
  // close code.
  private shutdownReason: string | undefined;
  private timersArmed = false;
  private lastActivityAt = 0;
  private idleTimer: NodeJS.Timeout | undefined;
  private maxTimer: NodeJS.Timeout | undefined;

  constructor(opts: ManagedRealtimeSessionOpts) {
    this.outerCallbacks = opts.callbacks;
    this.reconnectBaseDelayMs = opts.reconnectBaseDelayMs ?? DEFAULT_RECONNECT_BASE_DELAY_MS;
    this.maxReconnectAttempts = opts.maxReconnectAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS;
    this.idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.maxSessionMs = opts.maxSessionMs ?? DEFAULT_MAX_SESSION_MS;

    const wrappedCallbacks: RealtimeCallbacks = {
      // Each outer callback dispatch is wrapped defensively (see
      // safeInvoke): Task 12's onAudioDelta writes to a Twilio socket and
      // onToolCall dispatches into the pi SDK, either of which can throw.
      // RealtimeSession's own dispatch is already exception-safe, but this
      // wrapper doesn't rely on that — it protects itself regardless of
      // what session implementation it's wrapping.
      onAudioDelta: (b) => {
        this.noteActivity();
        this.safeInvoke(() => this.outerCallbacks.onAudioDelta(b));
      },
      onSpeechStarted: () => {
        this.noteActivity();
        this.safeInvoke(() => this.outerCallbacks.onSpeechStarted());
      },
      onTranscript: (e) => {
        this.noteActivity();
        this.safeInvoke(() => this.outerCallbacks.onTranscript(e));
      },
      onToolCall: (e) => {
        this.noteActivity();
        this.safeInvoke(() => this.outerCallbacks.onToolCall(e));
      },
      onClosed: (reason) => this.handleInnerClosed(reason)
    };

    this.inner = new RealtimeSession({ ...opts, callbacks: wrappedCallbacks });
  }

  get ended(): boolean {
    return this._ended;
  }

  /** Delegates to the current inner session — correctly reflects "not open"
   * during the initial connect, a mid-call reconnect gap, or after close(),
   * regardless of what this wrapper's own (internal-bookkeeping) `state`
   * currently reads. See RealtimeSession.isOpen's doc comment. */
  get isOpen(): boolean {
    return this.inner.isOpen;
  }

  async connect(): Promise<void> {
    this.shuttingDown = false;
    this.reconnectAttempts = 0;
    this.state = "connecting";
    await this.attemptConnect();
  }

  appendAudio(mulaw: Buffer): void {
    this.noteActivity();
    this.inner.appendAudio(mulaw);
  }

  createResponse(): void {
    this.noteActivity();
    this.inner.createResponse();
  }

  cancelResponse(): void {
    this.noteActivity();
    this.inner.cancelResponse();
  }

  sendToolResult(callId: string, output: string, respond?: boolean): void {
    this.noteActivity();
    this.inner.sendToolResult(callId, output, respond);
  }

  updateInstructions(text: string): void {
    this.noteActivity();
    this.inner.updateInstructions(text);
  }

  close(): void {
    if (this._ended) return;
    this._ended = true;
    this.shuttingDown = true;
    if (this.shutdownReason === undefined) {
      this.shutdownReason = "manual_close";
    }
    this.clearTimers();
    if (this.state === "idle") {
      // Never even attempted a connection — nothing for the inner session's
      // onClosed to fire from, so there's nothing to wait on.
      this.state = "closed";
      return;
    }
    this.inner.close();
    // inner.close() synchronously closes its (possibly not-yet-open)
    // WebSocket; the resulting close event drives handleInnerClosed(),
    // which — because shuttingDown is now true — forwards onClosed and
    // finalizes internal state to "closed". `ended` above already reads
    // true regardless of when (or whether) that round-trip completes.
  }

  private async attemptConnect(): Promise<void> {
    try {
      await this.inner.connect();
      this.state = "active";
      this.reconnectAttempts = 0;
      if (!this.timersArmed) {
        this.timersArmed = true;
        this.noteActivity();
        this.armTimers();
      }
    } catch (err) {
      if (this.shuttingDown || this.reconnectAttempts >= this.maxReconnectAttempts) {
        this.state = "closed";
        this._ended = true;
        throw err;
      }
      this.reconnectAttempts++;
      await sleep(this.reconnectBaseDelayMs * 2 ** (this.reconnectAttempts - 1));
      if (this.shuttingDown) {
        this.state = "closed";
        this._ended = true;
        throw err;
      }
      return this.attemptConnect();
    }
  }

  // Routes every close of the underlying RealtimeSession. Ignored while a
  // connect attempt is already in flight (state !== "active") — that case
  // is already being handled by attemptConnect()'s own catch block, and
  // handling it here too would double up on reconnect bookkeeping.
  private handleInnerClosed(reason: string): void {
    if (this.state !== "active") return;

    if (this.shuttingDown) {
      this.state = "closed";
      this.safeInvoke(() => this.outerCallbacks.onClosed(this.shutdownReason ?? reason));
      return;
    }

    // Unexpected mid-call disconnect: reconnect in the background, giving
    // this disconnect episode its own fresh attempt budget.
    this.state = "connecting";
    this.reconnectAttempts = 0;
    void this.attemptConnect().catch(() => {
      this.state = "closed";
      this.safeInvoke(() => this.outerCallbacks.onClosed(reason));
    });
  }

  // Never let a throwing caller-supplied callback escape into internal
  // dispatch code and crash the process (task-9 review issue 3).
  private safeInvoke(fn: () => void): void {
    try {
      fn();
    } catch (err) {
      console.warn("[managed-realtime] callback error:", err);
    }
  }

  private shutdown(reason: string): void {
    this.shutdownReason = reason;
    this.close();
  }

  private noteActivity(): void {
    // Only record the timestamp; the idle timer re-checks lastActivityAt
    // when it fires and re-arms itself rather than being reset on every
    // single audio frame (~50/sec), which would churn a timer far more than
    // necessary.
    this.lastActivityAt = Date.now();
  }

  private armTimers(): void {
    this.rearmIdleTimer();
    if (this.maxSessionMs > 0) {
      this.maxTimer = setTimeout(() => this.shutdown("max_session_reached"), this.maxSessionMs);
      this.maxTimer.unref?.();
    }
  }

  private rearmIdleTimer(): void {
    if (this.idleTimeoutMs <= 0) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      const idleForMs = Date.now() - this.lastActivityAt;
      if (idleForMs < this.idleTimeoutMs) {
        this.rearmIdleTimer();
        return;
      }
      this.shutdown("idle_timeout");
    }, this.idleTimeoutMs);
    this.idleTimer.unref?.();
  }

  private clearTimers(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
    if (this.maxTimer) {
      clearTimeout(this.maxTimer);
      this.maxTimer = undefined;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
