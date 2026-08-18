import { describe, it, expect, afterEach } from "vitest";
import { WebSocketServer, WebSocket } from "ws";
import type { AddressInfo } from "node:net";
import { RealtimeSession } from "../src/realtime.js";
import type { RealtimeCallbacks, RealtimeToolDef } from "../src/realtime.js";
import { ManagedRealtimeSession } from "../src/managed-realtime.js";

// Deferred-resolution helper: turns a one-shot handler callback into an
// awaitable promise (see test/media-stream.test.ts for the same pattern).
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => (resolve = res));
  return { promise, resolve };
}

// Races a promise against a bounded fallback so a callback/message that
// never fires produces a clean value-level assertion mismatch (fallback vs
// expected) instead of riding out vitest's full test timeout.
function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([promise, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms))]);
}

const TEST_API_KEY = "sk-test-SECRET-abc123";

const NOOP_CALLBACKS: RealtimeCallbacks = {
  onAudioDelta: () => {},
  onSpeechStarted: () => {},
  onTranscript: () => {},
  onToolCall: () => {},
  onClosed: () => {}
};

const TOOLS: RealtimeToolDef[] = [
  {
    name: "end_call",
    description: "End the call",
    parameters: {
      type: "object",
      properties: { reason: { type: "string" } },
      required: ["reason"]
    }
  }
];

const activeServers: WebSocketServer[] = [];

afterEach(async () => {
  const servers = activeServers.splice(0, activeServers.length);
  await Promise.all(
    servers.map((s) => {
      // wss.close()'s callback does not fire until every client connection
      // is also closed. Most tests here never explicitly close their
      // session (that's not what's under test), so force-terminate any
      // still-open client sockets first rather than let teardown hang.
      for (const client of s.clients) {
        client.terminate();
      }
      return new Promise<void>((resolve) => s.close(() => resolve()));
    })
  );
});

async function startServer(): Promise<{ server: WebSocketServer; url: string }> {
  const { server, url } = await new Promise<{ server: WebSocketServer; url: string }>((resolve) => {
    const s = new WebSocketServer({ port: 0 }, () => {
      const port = (s.address() as AddressInfo).port;
      resolve({ server: s, url: `ws://127.0.0.1:${port}` });
    });
  });
  activeServers.push(server);
  return { server, url };
}

// Wires a server-side socket to auto-reply to session.update with
// session.updated, optionally reporting the captured session.update payload.
function startAutoAck(socket: WebSocket, onSessionUpdate?: (msg: Record<string, unknown>) => void): void {
  socket.on("message", (data: Buffer) => {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(data.toString()) as Record<string, unknown>;
    } catch {
      return;
    }
    if (msg.type === "session.update") {
      onSessionUpdate?.(msg);
      socket.send(JSON.stringify({ type: "session.updated", session: {} }));
    }
  });
}

function nextClientMessage(socket: WebSocket): Promise<Record<string, unknown> | undefined> {
  const p = new Promise<Record<string, unknown>>((resolve) => {
    socket.once("message", (data: Buffer) => resolve(JSON.parse(data.toString())));
  });
  return withTimeout(p, 300, undefined);
}

async function connectedSession(
  callbacks: Partial<RealtimeCallbacks> = {},
  opts: Partial<{ instructions: string; tools: RealtimeToolDef[]; voice: string; model: string }> = {}
): Promise<{
  session: RealtimeSession;
  socket: WebSocket;
  server: WebSocketServer;
  sessionUpdate: Record<string, unknown> | undefined;
}> {
  const { server, url } = await startServer();
  let capturedSessionUpdate: Record<string, unknown> | undefined;

  const connReady = new Promise<WebSocket>((resolve) => {
    server.once("connection", (socket: WebSocket) => {
      // Attached synchronously in the connection handler (no await first)
      // so no message sent right after the client's 'open' can be missed.
      startAutoAck(socket, (msg) => {
        capturedSessionUpdate = msg;
      });
      resolve(socket);
    });
  });

  const session = new RealtimeSession({
    apiKey: TEST_API_KEY,
    model: opts.model ?? "gpt-realtime",
    voice: opts.voice ?? "alloy",
    instructions: opts.instructions ?? "Base instructions",
    tools: opts.tools ?? TOOLS,
    callbacks: { ...NOOP_CALLBACKS, ...callbacks },
    urlOverride: url
  });

  const connectPromise = session.connect();
  const socket = await connReady;
  await connectPromise;

  return { session, socket, server, sessionUpdate: capturedSessionUpdate };
}

describe("RealtimeSession", () => {
  it("connect() resolves only after session.updated arrives, not merely on socket open", async () => {
    const { url } = await startServer();
    activeServers[activeServers.length - 1].once("connection", (socket: WebSocket) => {
      socket.on("message", (data: Buffer) => {
        const msg = JSON.parse(data.toString()) as { type?: string };
        if (msg.type === "session.update") {
          // Deliberately delayed ack so a premature resolve is observable.
          setTimeout(() => socket.send(JSON.stringify({ type: "session.updated", session: {} })), 40);
        }
      });
    });

    const session = new RealtimeSession({
      apiKey: TEST_API_KEY,
      model: "gpt-realtime",
      voice: "alloy",
      instructions: "hi",
      tools: [],
      callbacks: NOOP_CALLBACKS,
      urlOverride: url
    });

    let resolved = false;
    const connectPromise = session.connect().then(() => {
      resolved = true;
    });

    await new Promise((r) => setTimeout(r, 10)); // well before the 40ms server delay
    expect(resolved).toBe(false);
    await connectPromise;
    expect(resolved).toBe(true);
  });

  it("session.update carries the GA session shape: audio/pcmu both directions, server_vad tuning, instructions, and our tools", async () => {
    const { sessionUpdate } = await connectedSession(
      {},
      { voice: "verse", instructions: "Be concise.", tools: TOOLS }
    );

    expect(sessionUpdate).toEqual({
      type: "session.update",
      session: {
        type: "realtime",
        output_modalities: ["audio"],
        audio: {
          input: {
            format: { type: "audio/pcmu" },
            turn_detection: { type: "server_vad", threshold: 0.5, silence_duration_ms: 800 }
          },
          output: { format: { type: "audio/pcmu" }, voice: "verse" }
        },
        instructions: "Be concise.",
        tools: [
          {
            type: "function",
            name: "end_call",
            description: "End the call",
            parameters: TOOLS[0].parameters
          }
        ]
      }
    });
  });

  it("connects with an Authorization: Bearer <apiKey> header, and never leaks the key on a failed connection", async () => {
    const { server, url } = await startServer();
    let capturedAuth: string | undefined;
    server.once("connection", (socket: WebSocket, req) => {
      capturedAuth = req.headers.authorization;
      socket.close(1011, "simulated refusal"); // never acks session.update
    });

    const session = new RealtimeSession({
      apiKey: TEST_API_KEY,
      model: "gpt-realtime",
      voice: "alloy",
      instructions: "hi",
      tools: [],
      callbacks: NOOP_CALLBACKS,
      urlOverride: url
    });

    const connectPromise = session.connect();
    await expect(connectPromise).rejects.toThrow();
    expect(capturedAuth).toBe(`Bearer ${TEST_API_KEY}`);

    let message = "";
    try {
      await connectPromise;
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).not.toContain(TEST_API_KEY);
  });

  it("appendAudio base64-frames the raw mu-law buffer with zero transcoding", async () => {
    const { session, socket } = await connectedSession();
    const mulaw = Buffer.from([0x00, 0x7e, 0xff, 0x12, 0x34]);

    const msgPromise = nextClientMessage(socket);
    session.appendAudio(mulaw);

    expect(await msgPromise).toEqual({ type: "input_audio_buffer.append", audio: mulaw.toString("base64") });
  });

  it("createResponse sends response.create", async () => {
    const { session, socket } = await connectedSession();
    const msgPromise = nextClientMessage(socket);
    session.createResponse();
    expect(await msgPromise).toEqual({ type: "response.create" });
  });

  it.each([
    ["GA", "response.output_audio.delta"],
    ["legacy", "response.audio.delta"]
  ])("scripted %s audio delta reaches onAudioDelta decoded to a Buffer", async (_label, eventType) => {
    const got = deferred<Buffer | undefined>();
    const { socket } = await connectedSession({ onAudioDelta: (b) => got.resolve(b) });

    const audioBytes = Buffer.from([0x01, 0x02, 0x03, 0xff]);
    socket.send(JSON.stringify({ type: eventType, delta: audioBytes.toString("base64") }));

    const received = await withTimeout(got.promise, 300, undefined);
    expect(Buffer.isBuffer(received)).toBe(true);
    expect((received as Buffer).equals(audioBytes)).toBe(true);
  });

  it("input_audio_buffer.speech_started fires onSpeechStarted; a subsequent cancelResponse() sends response.cancel", async () => {
    const got = deferred<boolean>();
    const { session, socket } = await connectedSession({ onSpeechStarted: () => got.resolve(true) });

    socket.send(JSON.stringify({ type: "input_audio_buffer.speech_started" }));
    expect(await withTimeout(got.promise, 300, false)).toBe(true);

    const msgPromise = nextClientMessage(socket);
    session.cancelResponse();
    expect(await msgPromise).toEqual({ type: "response.cancel" });
  });

  it("scripted function_call item fires onToolCall with parsed args", async () => {
    const got = deferred<{ name: string; callId: string; args: Record<string, unknown> } | undefined>();
    const { socket } = await connectedSession({ onToolCall: (e) => got.resolve(e) });

    socket.send(
      JSON.stringify({
        type: "response.output_item.done",
        item: {
          type: "function_call",
          name: "end_call",
          call_id: "call_1",
          arguments: JSON.stringify({ reason: "done" })
        }
      })
    );

    expect(await withTimeout(got.promise, 300, undefined)).toEqual({
      name: "end_call",
      callId: "call_1",
      args: { reason: "done" }
    });
  });

  it("a malformed function_call arguments string does not crash the session — onToolCall gets an empty args object", async () => {
    const got = deferred<{ name: string; callId: string; args: Record<string, unknown> } | undefined>();
    const { socket } = await connectedSession({ onToolCall: (e) => got.resolve(e) });

    socket.send(
      JSON.stringify({
        type: "response.output_item.done",
        item: { type: "function_call", name: "end_call", call_id: "call_2", arguments: "{not json" }
      })
    );

    expect(await withTimeout(got.promise, 300, undefined)).toEqual({ name: "end_call", callId: "call_2", args: {} });
  });

  it("sendToolResult emits function_call_output then response.create, in order", async () => {
    const { session, socket } = await connectedSession();
    // Both frames are sent synchronously back to back inside
    // sendToolResult(), so both listeners must be attached up front —
    // registering the second one only after awaiting the first message
    // would race it and could miss a message sent in between.
    const messages: Record<string, unknown>[] = [];
    socket.on("message", (data: Buffer) => messages.push(JSON.parse(data.toString())));

    session.sendToolResult("call_1", "ok");
    await new Promise((r) => setTimeout(r, 60));

    expect(messages).toEqual([
      { type: "conversation.item.create", item: { type: "function_call_output", call_id: "call_1", output: "ok" } },
      { type: "response.create" }
    ]);
  });

  it("sendToolResult with respond:false emits function_call_output only — no response.create", async () => {
    const { session, socket } = await connectedSession();
    const messages: Record<string, unknown>[] = [];
    socket.on("message", (data: Buffer) => messages.push(JSON.parse(data.toString())));

    session.sendToolResult("call_2", "goodbye sent", false);
    await new Promise((r) => setTimeout(r, 60)); // give a wrongly-sent second frame time to arrive

    expect(messages).toEqual([
      { type: "conversation.item.create", item: { type: "function_call_output", call_id: "call_2", output: "goodbye sent" } }
    ]);
  });

  it("caller transcript: conversation.item.input_audio_transcription.completed -> onTranscript role caller", async () => {
    const got = deferred<{ role: string; text: string } | undefined>();
    const { socket } = await connectedSession({ onTranscript: (e) => got.resolve(e) });

    socket.send(
      JSON.stringify({ type: "conversation.item.input_audio_transcription.completed", transcript: "hello there" })
    );

    expect(await withTimeout(got.promise, 300, undefined)).toEqual({ role: "caller", text: "hello there" });
  });

  it.each([
    ["GA", "response.output_audio_transcript.done"],
    ["legacy", "response.audio_transcript.done"]
  ])("assistant transcript (%s) -> onTranscript role assistant", async (_label, eventType) => {
    const got = deferred<{ role: string; text: string } | undefined>();
    const { socket } = await connectedSession({ onTranscript: (e) => got.resolve(e) });

    socket.send(JSON.stringify({ type: eventType, transcript: "goodbye" }));

    expect(await withTimeout(got.promise, 300, undefined)).toEqual({ role: "assistant", text: "goodbye" });
  });

  it("updateInstructions sends a session.update carrying only the new instructions", async () => {
    const { session, socket } = await connectedSession();
    const msgPromise = nextClientMessage(socket);
    session.updateInstructions("Leave a voicemail.");
    expect(await msgPromise).toEqual({ type: "session.update", session: { type: "realtime", instructions: "Leave a voicemail." } });
  });

  it("server close fires onClosed and marks the session ended", async () => {
    const got = deferred<string | undefined>();
    const { session, socket } = await connectedSession({ onClosed: (reason) => got.resolve(reason) });

    socket.close(1000, "bye");

    const reason = await withTimeout(got.promise, 300, undefined);
    expect(typeof reason).toBe("string");
    expect(session.ended).toBe(true);
  });

  it("close() is idempotent and marks ended", async () => {
    const { session } = await connectedSession();
    expect(session.ended).toBe(false);
    session.close();
    expect(session.ended).toBe(true);
    expect(() => session.close()).not.toThrow();
  });
});

describe("ManagedRealtimeSession", () => {
  it("reconnects after the server refuses the first connection attempt (2 connection attempts total)", async () => {
    const { server, url } = await startServer();
    let attempts = 0;
    server.on("connection", (socket: WebSocket) => {
      attempts++;
      if (attempts === 1) {
        socket.close(1011, "refused");
        return;
      }
      startAutoAck(socket);
    });

    const session = new ManagedRealtimeSession({
      apiKey: TEST_API_KEY,
      model: "gpt-realtime",
      voice: "alloy",
      instructions: "hi",
      tools: [],
      callbacks: NOOP_CALLBACKS,
      urlOverride: url,
      reconnectBaseDelayMs: 5
    });

    await session.connect();

    expect(attempts).toBe(2);
    expect(session.ended).toBe(false);
    session.close();
  });

  it("delegates appendAudio/createResponse/cancelResponse/sendToolResult/updateInstructions to the live session", async () => {
    const { server, url } = await startServer();
    let socketRef: WebSocket | undefined;
    server.once("connection", (socket: WebSocket) => {
      startAutoAck(socket);
      socketRef = socket;
    });

    const session = new ManagedRealtimeSession({
      apiKey: TEST_API_KEY,
      model: "gpt-realtime",
      voice: "alloy",
      instructions: "hi",
      tools: [],
      callbacks: NOOP_CALLBACKS,
      urlOverride: url
    });
    await session.connect();
    const socket = socketRef!;

    const msgPromise = nextClientMessage(socket);
    session.appendAudio(Buffer.from("abc"));
    expect(await msgPromise).toEqual({ type: "input_audio_buffer.append", audio: Buffer.from("abc").toString("base64") });

    session.close();
  });

  it("idle timeout closes the session and fires onClosed after idleTimeoutMs of inactivity", async () => {
    const { server, url } = await startServer();
    server.on("connection", (socket: WebSocket) => startAutoAck(socket));

    const got = deferred<string | undefined>();
    const session = new ManagedRealtimeSession({
      apiKey: TEST_API_KEY,
      model: "gpt-realtime",
      voice: "alloy",
      instructions: "hi",
      tools: [],
      callbacks: { ...NOOP_CALLBACKS, onClosed: (reason) => got.resolve(reason) },
      urlOverride: url,
      idleTimeoutMs: 30,
      maxSessionMs: 10_000
    });

    await session.connect();
    const reason = await withTimeout(got.promise, 500, undefined);

    expect(reason).toBe("idle_timeout");
    expect(session.ended).toBe(true);
  });

  it("max session timeout closes the session even under ongoing activity", async () => {
    const { server, url } = await startServer();
    server.on("connection", (socket: WebSocket) => startAutoAck(socket));

    const got = deferred<string | undefined>();
    const session = new ManagedRealtimeSession({
      apiKey: TEST_API_KEY,
      model: "gpt-realtime",
      voice: "alloy",
      instructions: "hi",
      tools: [],
      callbacks: { ...NOOP_CALLBACKS, onClosed: (reason) => got.resolve(reason) },
      urlOverride: url,
      idleTimeoutMs: 10_000,
      maxSessionMs: 30
    });

    await session.connect();
    // Keep "activity" flowing so the idle timer alone could never explain a
    // close — isolates the max-session timer as the only possible cause.
    const keepAlive = setInterval(() => session.appendAudio(Buffer.from([0])), 10);

    const reason = await withTimeout(got.promise, 500, undefined);
    clearInterval(keepAlive);

    expect(reason).toBe("max_session_reached");
    expect(session.ended).toBe(true);
  });

  it("close() is idempotent and marks ended", async () => {
    const { server, url } = await startServer();
    server.on("connection", (socket: WebSocket) => startAutoAck(socket));

    const session = new ManagedRealtimeSession({
      apiKey: TEST_API_KEY,
      model: "gpt-realtime",
      voice: "alloy",
      instructions: "hi",
      tools: [],
      callbacks: NOOP_CALLBACKS,
      urlOverride: url
    });
    await session.connect();

    expect(session.ended).toBe(false);
    session.close();
    expect(session.ended).toBe(true);
    expect(() => session.close()).not.toThrow();
  });
});
