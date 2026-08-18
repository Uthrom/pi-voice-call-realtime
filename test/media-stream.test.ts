import { describe, it, expect, afterEach, vi } from "vitest";
import { WebSocketServer, WebSocket } from "ws";
import type { AddressInfo } from "node:net";
import { MediaStreamConnection } from "../src/media-stream.js";
import type { MediaStreamHandlers } from "../src/media-stream.js";

// Deferred-resolution helper: turns a one-shot handler callback into an
// awaitable promise, so tests can `await` a specific handler firing instead
// of polling.
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => (resolve = res));
  return { promise, resolve };
}

function connectClient(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const client = new WebSocket(url);
    client.once("open", () => resolve(client));
    client.once("error", reject);
  });
}

function nextMessage(client: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    client.once("message", (data: Buffer) => resolve(JSON.parse(data.toString())));
  });
}

function sendFrame(client: WebSocket, message: unknown): void {
  client.send(JSON.stringify(message));
}

const NOOP_HANDLERS: MediaStreamHandlers = {
  onStart: () => {},
  onAudio: () => {},
  onStop: () => {}
};

describe("MediaStreamConnection", () => {
  let wss: WebSocketServer | undefined;
  let client: WebSocket | undefined;

  afterEach(async () => {
    client?.close();
    client = undefined;
    if (wss) {
      const server = wss;
      wss = undefined;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  // Spins up a real, in-process `ws` WebSocketServer on an ephemeral port
  // and connects a real `ws` client to it (the test client plays the
  // Twilio side of the wire protocol), then constructs the
  // MediaStreamConnection under test around the server-side socket.
  async function setup(
    handlers: Partial<MediaStreamHandlers> = {}
  ): Promise<{ conn: MediaStreamConnection; client: WebSocket; socket: WebSocket }> {
    const fullHandlers: MediaStreamHandlers = { ...NOOP_HANDLERS, ...handlers };

    const { server, url } = await new Promise<{ server: WebSocketServer; url: string }>((resolve) => {
      const s = new WebSocketServer({ port: 0 }, () => {
        const port = (s.address() as AddressInfo).port;
        resolve({ server: s, url: `ws://127.0.0.1:${port}` });
      });
    });
    wss = server;

    // Exposes the raw server-side socket (the same instance
    // MediaStreamConnection wraps) alongside conn, so tests can drive
    // socket-level lifecycle events (terminate/error) directly.
    const connReady = new Promise<{ conn: MediaStreamConnection; socket: WebSocket }>((resolve) => {
      server.once("connection", (socket: WebSocket) => {
        resolve({ conn: new MediaStreamConnection(socket, fullHandlers), socket });
      });
    });

    const [c, { conn, socket }] = await Promise.all([connectClient(url), connReady]);
    client = c;
    return { conn, client: c, socket };
  }

  it("surfaces streamSid and fires onStart when a start frame arrives", async () => {
    const started = deferred<{ streamSid: string }>();
    const { conn, client: c } = await setup({ onStart: started.resolve });

    sendFrame(c, { event: "connected" });
    sendFrame(c, { event: "start", start: { streamSid: "MZ_start_123" } });

    expect(await started.promise).toEqual({ streamSid: "MZ_start_123" });
    expect(conn.streamSid).toBe("MZ_start_123");
  });

  it("decodes an inbound media payload to a Buffer and passes it to onAudio", async () => {
    const audio = deferred<Buffer>();
    const { client: c } = await setup({ onAudio: audio.resolve });

    const mulaw = Buffer.from([0x00, 0x7e, 0xff, 0x12, 0x34]);
    sendFrame(c, { event: "media", media: { payload: mulaw.toString("base64") } });

    const received = await audio.promise;
    expect(Buffer.isBuffer(received)).toBe(true);
    expect(received.equals(mulaw)).toBe(true);
  });

  it("sendAudio emits a Twilio media frame carrying the base64 round-trip of the given Buffer", async () => {
    const started = deferred<{ streamSid: string }>();
    const { conn, client: c } = await setup({ onStart: started.resolve });
    sendFrame(c, { event: "start", start: { streamSid: "MZ_send_audio" } });
    await started.promise;

    const mulaw = Buffer.from("outbound-audio-bytes");
    const framePromise = nextMessage(c);
    conn.sendAudio(mulaw);
    const frame = await framePromise;

    expect(frame).toEqual({
      event: "media",
      streamSid: "MZ_send_audio",
      media: { payload: mulaw.toString("base64") }
    });
    expect(Buffer.from((frame as { media: { payload: string } }).media.payload, "base64").equals(mulaw)).toBe(true);
  });

  it("sendClear emits a Twilio clear frame for the stream", async () => {
    const started = deferred<{ streamSid: string }>();
    const { conn, client: c } = await setup({ onStart: started.resolve });
    sendFrame(c, { event: "start", start: { streamSid: "MZ_clear" } });
    await started.promise;

    const framePromise = nextMessage(c);
    conn.sendClear();
    const frame = await framePromise;

    expect(frame).toEqual({ event: "clear", streamSid: "MZ_clear" });
  });

  it("waitForPlayoutDrained resolves once the client echoes back the mark name", async () => {
    const started = deferred<{ streamSid: string }>();
    const { conn, client: c } = await setup({ onStart: started.resolve });
    sendFrame(c, { event: "start", start: { streamSid: "MZ_mark" } });
    await started.promise;

    const markFramePromise = nextMessage(c);
    const drainPromise = conn.waitForPlayoutDrained();

    const markFrame = await markFramePromise;
    expect(markFrame.event).toBe("mark");
    expect(markFrame.streamSid).toBe("MZ_mark");
    const markName = (markFrame as { mark: { name: string } }).mark.name;
    expect(typeof markName).toBe("string");

    // Twilio's mark event echo carries the same mark name back once
    // playback reaches it.
    sendFrame(c, { event: "mark", mark: { name: markName } });

    await expect(drainPromise).resolves.toBeUndefined();
  });

  it("waitForPlayoutDrained resolves (not rejects) on timeout when the mark is never echoed", async () => {
    const started = deferred<{ streamSid: string }>();
    const { conn, client: c } = await setup({ onStart: started.resolve });
    sendFrame(c, { event: "start", start: { streamSid: "MZ_timeout" } });
    await started.promise;

    // The client deliberately never echoes the mark back.
    await expect(conn.waitForPlayoutDrained(50)).resolves.toBeUndefined();
  });

  it("fires onStop when a stop frame arrives", async () => {
    const stopped = deferred<void>();
    const { client: c } = await setup({ onStop: () => stopped.resolve(undefined) });

    sendFrame(c, { event: "stop" });

    await stopped.promise;
  });
});

describe("MediaStreamConnection — socket lifecycle and pre-start guards", () => {
  let wss: WebSocketServer | undefined;
  let client: WebSocket | undefined;

  afterEach(async () => {
    client?.close();
    client = undefined;
    if (wss) {
      const server = wss;
      wss = undefined;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  async function setup(
    handlers: Partial<MediaStreamHandlers> = {}
  ): Promise<{ conn: MediaStreamConnection; client: WebSocket; socket: WebSocket }> {
    const fullHandlers: MediaStreamHandlers = { ...NOOP_HANDLERS, ...handlers };

    const { server, url } = await new Promise<{ server: WebSocketServer; url: string }>((resolve) => {
      const s = new WebSocketServer({ port: 0 }, () => {
        const port = (s.address() as AddressInfo).port;
        resolve({ server: s, url: `ws://127.0.0.1:${port}` });
      });
    });
    wss = server;

    const connReady = new Promise<{ conn: MediaStreamConnection; socket: WebSocket }>((resolve) => {
      server.once("connection", (socket: WebSocket) => {
        resolve({ conn: new MediaStreamConnection(socket, fullHandlers), socket });
      });
    });

    const [c, { conn, socket }] = await Promise.all([connectClient(url), connReady]);
    client = c;
    return { conn, client: c, socket };
  }

  it(
    "(a) resolves a pending drain promptly — not via the 10s default timeout — and fires onStop exactly once when the socket is abruptly destroyed mid-drain",
    async () => {
      const started = deferred<{ streamSid: string }>();
      const onStopCalled = deferred<void>();
      const onStop = vi.fn(() => onStopCalled.resolve(undefined));
      const { conn, client: c, socket } = await setup({ onStart: started.resolve, onStop });
      sendFrame(c, { event: "start", start: { streamSid: "MZ_destroy" } });
      await started.promise;

      // Use the real default timeout (no override) so a prompt resolution
      // here can only be explained by the close-triggered path, not by the
      // 10s fallback happening to also be short.
      const drainPromise = conn.waitForPlayoutDrained();
      // Wait for the outgoing mark frame to actually be sent before
      // destroying the connection, so this genuinely exercises "died
      // mid-drain" rather than "died before the drain even started".
      await nextMessage(c);

      const destroyedAt = Date.now();
      socket.terminate();
      await drainPromise;

      expect(Date.now() - destroyedAt).toBeLessThan(1000);
      await onStopCalled.promise;
      expect(onStop).toHaveBeenCalledTimes(1);
    },
    // Generous per-test timeout: this exercises the real 10s default drain
    // timeout as a fallback path, so it must be able to run well past
    // vitest's 5s default test timeout to observe a genuine value-level
    // assertion failure (rather than a framework-level timeout) when the
    // close-triggered fast path is missing.
    12_000
  );

  it("(b) does not crash when the socket emits 'error', and fires onStop exactly once", async () => {
    const started = deferred<{ streamSid: string }>();
    const onStop = vi.fn();
    const { client: c, socket } = await setup({ onStart: started.resolve, onStop });
    sendFrame(c, { event: "start", start: { streamSid: "MZ_error" } });
    await started.promise;

    // With no listener, Node's EventEmitter throws synchronously when
    // 'error' is emitted — that's the process-crashing behavior this test
    // guards against.
    expect(() => socket.emit("error", new Error("simulated socket failure"))).not.toThrow();
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("(c) fires onStop exactly once when a stop frame is followed by the socket closing", async () => {
    const started = deferred<{ streamSid: string }>();
    const onStopCalled = deferred<void>();
    const onStop = vi.fn(() => onStopCalled.resolve(undefined));
    const { client: c, socket } = await setup({ onStart: started.resolve, onStop });
    sendFrame(c, { event: "start", start: { streamSid: "MZ_stop_close" } });
    await started.promise;

    sendFrame(c, { event: "stop" });
    await onStopCalled.promise;
    expect(onStop).toHaveBeenCalledTimes(1);

    // The close event that Twilio's own socket teardown would trigger
    // right after a stop frame must not fire onStop a second time.
    socket.terminate();
    await new Promise<void>((resolve) => socket.once("close", () => resolve()));
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("(d) suppresses outgoing sendAudio/sendClear frames before a start frame has arrived", async () => {
    const { conn, socket } = await setup();
    const sendSpy = vi.spyOn(socket, "send");

    conn.sendAudio(Buffer.from("pre-start-audio"));
    conn.sendClear();

    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("(d) resolves waitForPlayoutDrained immediately — not after the timeout — before a start frame has arrived", async () => {
    const { conn } = await setup();

    const startedAt = Date.now();
    await conn.waitForPlayoutDrained(300);

    expect(Date.now() - startedAt).toBeLessThan(100);
  });

  it("suppresses sendAudio and resolves drain immediately once the connection has already terminated (extends the same guard beyond pre-start)", async () => {
    const started = deferred<{ streamSid: string }>();
    const { conn, client: c, socket } = await setup({ onStart: started.resolve });
    sendFrame(c, { event: "start", start: { streamSid: "MZ_after_stop" } });
    await started.promise;

    socket.terminate();
    await new Promise<void>((resolve) => socket.once("close", () => resolve()));

    const sendSpy = vi.spyOn(socket, "send");
    conn.sendAudio(Buffer.from("post-stop-audio"));
    expect(sendSpy).not.toHaveBeenCalled();

    const startedAt = Date.now();
    await conn.waitForPlayoutDrained(300);
    expect(Date.now() - startedAt).toBeLessThan(100);
  });
});
