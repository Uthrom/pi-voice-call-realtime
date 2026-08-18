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

  constructor(socket: WebSocket, handlers: MediaStreamHandlers) {
    this.socket = socket;
    this.handlers = handlers;
    this.socket.on("message", (data: Buffer) => this.handleMessage(data));
  }

  get streamSid(): string | undefined {
    return this._streamSid;
  }

  /** AI -> caller: send a decoded mu-law Buffer as a Twilio media frame. */
  sendAudio(mulaw: Buffer): void {
    this.sendFrame({
      event: "media",
      streamSid: this._streamSid,
      media: { payload: mulaw.toString("base64") }
    });
  }

  /** Flush Twilio's playback buffer (barge-in). */
  sendClear(): void {
    this.sendFrame({ event: "clear", streamSid: this._streamSid });
  }

  /**
   * Wait until all audio already sent to this stream has finished playing
   * out. Sends a uniquely-named Twilio mark and resolves once Twilio
   * echoes that same mark name back in a `mark` event. If the echo never
   * arrives within timeoutMs (default 10s), resolves anyway — never
   * rejects — so a hangup path waiting on this can never wedge.
   */
  async waitForPlayoutDrained(timeoutMs = DEFAULT_DRAIN_TIMEOUT_MS): Promise<void> {
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
        this.handlers.onStop();
        break;
      // "connected" and anything else Twilio might send: no-op.
    }
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
