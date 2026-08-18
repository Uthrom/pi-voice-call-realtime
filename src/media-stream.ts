// Adapted from openclaw-voice-call-realtime (MIT) — https://github.com/TristanBrotherton/openclaw-voice-call-realtime

/**
 * Twilio bidirectional media-stream bridge.
 *
 * Wraps a single already-upgraded `ws` WebSocket carrying Twilio's
 * <Connect><Stream> wire protocol. Passthrough only: inbound `media`
 * payloads are base64-decoded straight to a Buffer for the caller, and
 * outbound Buffers are base64-encoded straight back into Twilio's frame
 * format — never transcoded.
 *
 * Upgrade handling (accepting the WS connection, routing it here) is a
 * later task's wiring; this module only consumes an already-connected
 * socket.
 */

import type { WebSocket } from "ws";

export interface MediaStreamHandlers {
  onStart(info: { streamSid: string }): void;
  onAudio(mulaw: Buffer): void; // caller -> AI
  onStop(): void;
}

// Twilio's inbound media-stream frame shapes (only the fields this bridge
// reads; Twilio sends additional fields — e.g. sequenceNumber — that are
// ignored).
interface TwilioInboundFrame {
  event?: string;
  start?: { streamSid?: string };
  media?: { payload?: string };
  mark?: { name?: string };
}

const DEFAULT_DRAIN_TIMEOUT_MS = 10_000;

/**
 * One media-stream connection to Twilio: decodes inbound frames into
 * handler callbacks, and encodes outbound audio/clear/mark frames.
 */
export class MediaStreamConnection {
  private readonly socket: WebSocket;
  private readonly handlers: MediaStreamHandlers;
  private _streamSid: string | undefined;
  // Pending waitForPlayoutDrained() calls, keyed by the mark name Twilio is
  // expected to echo back once playback reaches it.
  private readonly markWaiters = new Map<string, () => void>();
  // Guards onStop so it fires exactly once, however the connection ends: a
  // `stop` frame, a clean `close`, or an `error`. Twilio doesn't always
  // send `stop` before the socket goes away, and a `stop` frame is
  // typically followed moments later by the socket actually closing — both
  // must not fire onStop twice for the same call.
  private stopped = false;

  constructor(socket: WebSocket, handlers: MediaStreamHandlers) {
    this.socket = socket;
    this.handlers = handlers;
    this.socket.on("message", (data: Buffer) => this.handleMessage(data));
    // A socket-level failure or abrupt disconnect (ECONNRESET, the
    // callee's network dying mid-call, etc.) can arrive as 'close',
    // 'error', or both — Twilio doesn't guarantee a `stop` frame first.
    // Without an 'error' listener, Node's EventEmitter treats an
    // unlistened 'error' as a special case: it throws synchronously and
    // takes the whole process down. Without a 'close' listener, a drain
    // already in progress would ride out its full timeout waiting for an
    // echo that a dead socket can never deliver, and the controller would
    // never learn the call ended.
    this.socket.on("close", () => this.handleTermination());
    this.socket.on("error", () => this.handleTermination());
  }

  get streamSid(): string | undefined {
    return this._streamSid;
  }

  /** AI -> caller: send a decoded mu-law Buffer as a Twilio media frame. */
  sendAudio(mulaw: Buffer): void {
    if (!this.canSend()) return;
    this.sendFrame({
      event: "media",
      streamSid: this._streamSid,
      media: { payload: mulaw.toString("base64") }
    });
  }

  /** Flush Twilio's playback buffer (barge-in). */
  sendClear(): void {
    if (!this.canSend()) return;
    this.sendFrame({ event: "clear", streamSid: this._streamSid });
  }

  /**
   * Wait until all audio already sent to this stream has finished playing
   * out. Sends a uniquely-named Twilio mark and resolves once Twilio
   * echoes that same mark name back in a `mark` event. If the echo never
   * arrives within timeoutMs (default 10s), resolves anyway — never
   * rejects — so a hangup path waiting on this can never wedge. Resolves
   * immediately, without sending anything, before a `start` frame has set
   * streamSid or after the connection has already ended — there is no one
   * left to ever echo a mark back.
   */
  async waitForPlayoutDrained(timeoutMs = DEFAULT_DRAIN_TIMEOUT_MS): Promise<void> {
    if (!this.canSend()) return;
    const name = `drain-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.markWaiters.delete(name);
        resolve();
      }, timeoutMs);
      timer.unref?.();

      this.markWaiters.set(name, () => {
        clearTimeout(timer);
        resolve();
      });

      this.sendFrame({ event: "mark", streamSid: this._streamSid, mark: { name } });
    });
  }

  close(): void {
    this.socket.close();
  }

  /**
   * Before Twilio's `start` frame arrives there is no streamSid to stamp
   * outgoing frames with — JSON.stringify would silently drop the key,
   * producing a frame Twilio can't route (audio would vanish, a drain
   * would degrade into a full timeout). Once the connection has already
   * ended (handleTermination ran), there's equally no peer left to receive
   * anything or ever echo a mark back.
   */
  private canSend(): boolean {
    return this._streamSid !== undefined && !this.stopped;
  }

  private handleMessage(data: Buffer): void {
    let frame: TwilioInboundFrame;
    try {
      frame = JSON.parse(data.toString());
    } catch {
      return;
    }

    switch (frame.event) {
      case "start":
        if (frame.start?.streamSid) {
          this._streamSid = frame.start.streamSid;
          this.handlers.onStart({ streamSid: this._streamSid });
        }
        break;
      case "media":
        if (frame.media?.payload) {
          this.handlers.onAudio(Buffer.from(frame.media.payload, "base64"));
        }
        break;
      case "mark":
        if (frame.mark?.name) {
          this.resolveMarkWaiter(frame.mark.name);
        }
        break;
      case "stop":
        this.fireStopOnce();
        break;
      // "connected" and anything else Twilio might send: no-op.
    }
  }

  /**
   * Runs on the socket's 'close' or 'error' event: unblocks any pending
   * waitForPlayoutDrained() calls immediately rather than letting them
   * ride out their timeout against a socket that can never deliver the
   * echo, and reports call termination via onStop.
   */
  private handleTermination(): void {
    for (const waiter of this.markWaiters.values()) {
      waiter();
    }
    this.markWaiters.clear();
    this.fireStopOnce();
  }

  private fireStopOnce(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.handlers.onStop();
  }

  private resolveMarkWaiter(name: string): void {
    const waiter = this.markWaiters.get(name);
    if (!waiter) return;
    this.markWaiters.delete(name);
    waiter();
  }

  private sendFrame(message: unknown): void {
    this.socket.send(JSON.stringify(message));
  }
}
