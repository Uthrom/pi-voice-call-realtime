import { describe, it, expect, afterEach } from "vitest";
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
  ): Promise<{ conn: MediaStreamConnection; client: WebSocket }> {
    const fullHandlers: MediaStreamHandlers = { ...NOOP_HANDLERS, ...handlers };

    const { server, url } = await new Promise<{ server: WebSocketServer; url: string }>((resolve) => {
      const s = new WebSocketServer({ port: 0 }, () => {
        const port = (s.address() as AddressInfo).port;
        resolve({ server: s, url: `ws://127.0.0.1:${port}` });
      });
    });
    wss = server;

    const connReady = new Promise<MediaStreamConnection>((resolve) => {
      server.once("connection", (socket: WebSocket) => {
        resolve(new MediaStreamConnection(socket, fullHandlers));
      });
    });

    const [c, conn] = await Promise.all([connectClient(url), connReady]);
    client = c;
    return { conn, client: c };
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
