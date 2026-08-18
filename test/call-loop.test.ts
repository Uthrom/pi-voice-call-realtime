import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { WebSocketServer, WebSocket } from "ws";
import { startServer } from "../src/server.js";
import type { Config } from "../src/config.js";
import { CallStore } from "../src/store.js";
import type { CallRecord } from "../src/types.js";
import { RealtimeSession } from "../src/realtime.js";
import { MockProvider } from "../src/providers/mock.js";
import { sign } from "./helpers.js";

// This is the milestone-3/4 gate: the full audio path (Twilio media stream
// <-> realtime <-> call-brain tool dispatch <-> transcript/summary) wired
// end-to-end through startServer, with every external service faked —
// MockProvider stands in for Twilio's REST API, a scripted local
// WebSocketServer stands in for the OpenAI Realtime API (wired in via
// realtimeFactory's urlOverride), and summarizeCall's fetch is stubbed.

// ---- small local test helpers (mirrors the pattern used throughout
// test/realtime.test.ts and test/media-stream.test.ts) ----

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => (resolve = res));
  return { promise, resolve };
}

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([promise, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms))]);
}

// CallSession.run() resolving (transcript flushed, summarized, and saved)
// is NOT signaled by the media WS closing — media.close() happens early in
// teardown, well before the slower transcript/summarize/save tail runs in
// the background. There's no direct external signal for "fully finalized"
// available to this test (that promise is internal to server.ts's upgrade
// handler), so poll the store until the record carries a summary — the
// last field teardown() writes before resolving.
async function waitForFinalizedRecord(store: CallStore, id: string, timeoutMs = 4000): Promise<CallRecord | undefined> {
  const start = Date.now();
  for (;;) {
    const rec = await store.get(id);
    if (rec?.summary !== undefined) return rec;
    if (Date.now() - start > timeoutMs) return rec;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const AUTH_TOKEN = "test-auth-token";

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "pi-voice-call-loop-"));
}

function makeConfig(home: string): Config {
  return {
    home,
    twilio: { accountSid: "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", authToken: AUTH_TOKEN, fromNumber: "+15559998888" },
    openai: { apiKey: "sk-test", realtimeModel: "gpt-realtime", voice: "alloy" },
    summaryModel: "gpt-4o-mini",
    serve: { controlPort: 0, publicPort: 0, tunnel: "none", controlToken: "control-secret" },
    limits: { maxDurationSec: 900, maxConcurrentCalls: 1, dailyCallCap: 20 },
    defaults: { callerIdentity: "pi", amdPolicy: "leave-message" }
  };
}

type Handle = Awaited<ReturnType<typeof startServer>>;
let handle: Handle | undefined;
const fakeRealtimeServers: WebSocketServer[] = [];
const wsClients: WebSocket[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  for (const c of wsClients.splice(0, wsClients.length)) {
    c.terminate();
  }
  if (handle) {
    const h = handle;
    handle = undefined;
    await h.close();
  }
  const servers = fakeRealtimeServers.splice(0, fakeRealtimeServers.length);
  await Promise.all(
    servers.map((s) => {
      for (const client of s.clients) client.terminate();
      return new Promise<void>((resolve) => s.close(() => resolve()));
    })
  );
});

/**
 * A scripted fake OpenAI Realtime server: acks session.update, then plays a
 * fixed script — an audio delta, an assistant transcript, a note_outcome
 * function call, and (once note_outcome's tool result round-trips back)
 * an end_call function call.
 */
async function startScriptedRealtimeServer(opts: {
  audioB64: string;
  assistantTranscript: string;
  outcome: string;
  outcomeDetails: string;
  endReason: string;
}): Promise<{ url: string }> {
  const { server, url } = await new Promise<{ server: WebSocketServer; url: string }>((resolve) => {
    const s = new WebSocketServer({ port: 0 }, () => {
      const port = (s.address() as AddressInfo).port;
      resolve({ server: s, url: `ws://127.0.0.1:${port}` });
    });
  });
  fakeRealtimeServers.push(server);

  server.on("connection", (socket: WebSocket) => {
    socket.on("message", (data: Buffer) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(data.toString()) as Record<string, unknown>;
      } catch {
        return;
      }

      if (msg.type === "session.update") {
        socket.send(JSON.stringify({ type: "session.updated", session: {} }));
        // Give the Twilio-side WS a comfortable head start to process its
        // own `start` frame before any audio needs relaying.
        setTimeout(() => {
          socket.send(
            JSON.stringify({ type: "response.output_audio.delta", delta: opts.audioB64 })
          );
          socket.send(
            JSON.stringify({ type: "response.output_audio_transcript.done", transcript: opts.assistantTranscript })
          );
          socket.send(
            JSON.stringify({
              type: "response.output_item.done",
              item: {
                type: "function_call",
                name: "note_outcome",
                call_id: "call_note_1",
                arguments: JSON.stringify({ outcome: opts.outcome, details: opts.outcomeDetails })
              }
            })
          );
        }, 50);
        return;
      }

      const item = msg.item as { call_id?: string } | undefined;
      if (msg.type === "conversation.item.create" && item?.call_id === "call_note_1") {
        // note_outcome's tool result round-tripped — now send end_call.
        setTimeout(() => {
          socket.send(
            JSON.stringify({
              type: "response.output_item.done",
              item: {
                type: "function_call",
                name: "end_call",
                call_id: "call_end_1",
                arguments: JSON.stringify({ reason: opts.endReason })
              }
            })
          );
        }, 30);
      }
    });
  });

  return { url };
}

/**
 * A second scripted fake OpenAI Realtime server, dedicated to the AMD
 * leave-message path: acks every session.update (both the initial full
 * config and the later voicemail-instructions-only update sent by
 * switchToVoicemail's updateInstructions call), records each one, and — once
 * it sees an update whose instructions carry the voicemail prompt variant's
 * "Voicemail:" section — fires a scripted end_call, mirroring the model
 * complying with the one-way voicemail prompt (which structurally never
 * calls note_outcome).
 */
async function startVoicemailScriptedServer(endReason: string): Promise<{
  url: string;
  getSessionUpdates: () => Record<string, unknown>[];
}> {
  const { server, url } = await new Promise<{ server: WebSocketServer; url: string }>((resolve) => {
    const s = new WebSocketServer({ port: 0 }, () => {
      const port = (s.address() as AddressInfo).port;
      resolve({ server: s, url: `ws://127.0.0.1:${port}` });
    });
  });
  fakeRealtimeServers.push(server);

  const sessionUpdates: Record<string, unknown>[] = [];

  server.on("connection", (socket: WebSocket) => {
    socket.on("message", (data: Buffer) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(data.toString()) as Record<string, unknown>;
      } catch {
        return;
      }
      if (msg.type !== "session.update") return;

      socket.send(JSON.stringify({ type: "session.updated", session: {} }));
      sessionUpdates.push(msg);

      const session = msg.session as { instructions?: string } | undefined;
      if (session?.instructions?.includes("Voicemail:")) {
        setTimeout(() => {
          socket.send(
            JSON.stringify({
              type: "response.output_item.done",
              item: {
                type: "function_call",
                name: "end_call",
                call_id: "call_vm_end",
                arguments: JSON.stringify({ reason: endReason })
              }
            })
          );
        }, 30);
      }
    });
  });

  return { url, getSessionUpdates: () => sessionUpdates.slice() };
}

// Stubs only the summarizer's own OpenAI call — everything else (in
// particular this test's own postSigned() hitting the local webhook server)
// passes through to the real global fetch. A blanket stub would silently
// swallow the test's own local HTTP calls too, since summarizeCall reaches
// `fetch` via the same global binding.
function stubSummaryFetch(outcome: string, summary: string): void {
  const realFetch = globalThis.fetch.bind(globalThis);
  const fetchStub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === "https://api.openai.com/v1/chat/completions") {
      return new Response(
        JSON.stringify({ choices: [{ message: { content: JSON.stringify({ outcome, summary }) } }] }),
        { status: 200 }
      );
    }
    return realFetch(input, init);
  });
  vi.stubGlobal("fetch", fetchStub);
}

/** Connects a plain `ws` client to a URL, tracked for teardown. */
function connectClient(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const client = new WebSocket(url);
    wsClients.push(client);
    client.once("open", () => resolve(client));
    client.once("error", reject);
  });
}

function sendFrame(client: WebSocket, message: unknown): void {
  client.send(JSON.stringify(message));
}

async function postSigned(
  baseUrl: string,
  path: string,
  params: Record<string, string>
): Promise<Response> {
  const url = `${baseUrl}${path}`;
  const body = new URLSearchParams(params).toString();
  const signature = sign(AUTH_TOKEN, url, params);
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": signature },
    body
  });
}

describe("call loop (mock integration)", () => {
  it(
    "relays audio, dispatches note_outcome + end_call tool calls, drains playout before hangup, and finalizes the record with transcript + summary",
    async () => {
      stubSummaryFetch("reservation confirmed", "Called and confirmed the 7pm reservation.");

      const audioBuffer = Buffer.from([0x01, 0x02, 0x03, 0xff, 0x7e]);
      const { url: realtimeUrl } = await startScriptedRealtimeServer({
        audioB64: audioBuffer.toString("base64"),
        assistantTranscript: "Your reservation for 7pm is confirmed. Goodbye.",
        outcome: "reservation confirmed",
        outcomeDetails: "confirmed for 7pm",
        endReason: "objective-complete"
      });

      const home = tempHome();
      const provider = new MockProvider();
      const h = await startServer(makeConfig(home), {
        provider,
        realtimeFactory: (opts) => new RealtimeSession({ ...opts, urlOverride: realtimeUrl, connectTimeoutMs: 2000 })
      });
      handle = h;
      const port = (h.publicServer.address() as AddressInfo).port;
      const baseUrl = `http://127.0.0.1:${port}`;

      const rec = await h.manager.initiateCall({
        to: "+15551234567",
        objective: "confirm the 7pm reservation",
        talkingPoints: ["confirm the reservation time"],
        callerIdentity: "pi"
      });

      const statusRes = await postSigned(baseUrl, "/voice/webhook?kind=status", {
        CallSid: rec.providerCallId!,
        CallStatus: "in-progress"
      });
      expect(statusRes.status).toBe(200);
      expect(h.manager.getActive()?.status).toBe("answered");

      const client = await connectClient(`ws://127.0.0.1:${port}/voice/stream?token=${rec.streamToken}`);

      const frames: Record<string, unknown>[] = [];
      const gotAudio = deferred<void>();
      let audioSeen = false;
      const closed = deferred<void>();

      client.on("message", (data: Buffer) => {
        const frame = JSON.parse(data.toString()) as Record<string, unknown>;
        frames.push(frame);
        if (frame.event === "media" && !audioSeen) {
          audioSeen = true;
          gotAudio.resolve();
        }
        if (frame.event === "mark") {
          // Echo the mark back, as Twilio does once playback reaches it —
          // this is what lets waitForPlayoutDrained() resolve promptly
          // instead of riding out its 10s default timeout.
          const markName = (frame.mark as { name: string }).name;
          sendFrame(client, { event: "mark", mark: { name: markName } });
        }
      });
      client.on("close", () => closed.resolve());

      sendFrame(client, { event: "connected" });
      sendFrame(client, { event: "start", start: { streamSid: "MZ_TEST_STREAM" } });
      sendFrame(client, { event: "media", media: { payload: Buffer.from("caller-hello").toString("base64") } });
      sendFrame(client, { event: "media", media: { payload: Buffer.from("caller-more").toString("base64") } });

      await withTimeout(gotAudio.promise, 4000, undefined);
      await withTimeout(closed.promise, 4000, undefined);

      // Client received a relayed audio-delta media frame...
      const mediaFrames = frames.filter((f) => f.event === "media");
      expect(mediaFrames.length).toBeGreaterThan(0);
      const relayed = mediaFrames[0] as { media: { payload: string } };
      expect(Buffer.from(relayed.media.payload, "base64").equals(audioBuffer)).toBe(true);

      // ...then a clear-free ordered goodbye: a mark (drain) request, with
      // no `clear` frame ever sent (no barge-in was scripted).
      const clearFrames = frames.filter((f) => f.event === "clear");
      expect(clearFrames).toHaveLength(0);
      const firstMediaIdx = frames.findIndex((f) => f.event === "media");
      const firstMarkIdx = frames.findIndex((f) => f.event === "mark");
      expect(firstMarkIdx).toBeGreaterThan(-1);
      expect(firstMediaIdx).toBeLessThan(firstMarkIdx);

      // ...and the stream closed.
      expect(client.readyState).toBe(WebSocket.CLOSED);

      // The record is fully finalized: completed, with the noted outcome,
      // a saved summary, and a transcript file containing the scripted
      // lines.
      const store = new CallStore(home);
      const finalRec = await waitForFinalizedRecord(store, rec.id);
      expect(finalRec?.status).toBe("completed");
      expect(finalRec?.outcome).toEqual({ outcome: "reservation confirmed", details: "confirmed for 7pm" });
      expect(finalRec?.summary).toBe("Called and confirmed the 7pm reservation.");
      expect(finalRec?.transcriptPath).toBeTruthy();

      const transcriptContents = await readFile(finalRec!.transcriptPath!, "utf-8");
      expect(transcriptContents).toContain("Your reservation for 7pm is confirmed. Goodbye.");

      expect(h.manager.getActive()).toBeUndefined();
    },
    10_000
  );

  it("a WS upgrade to /voice/stream with an unknown/invalid token is destroyed before any frame is exchanged", async () => {
    const home = tempHome();
    const provider = new MockProvider();
    const h = await startServer(makeConfig(home), { provider });
    handle = h;
    const port = (h.publicServer.address() as AddressInfo).port;

    // A call exists (with its own valid token) so this isn't merely "no
    // active call at all" — the bad token must be rejected even though a
    // legitimate stream token is live.
    await h.manager.initiateCall({
      to: "+15551234567",
      objective: "confirm appointment",
      talkingPoints: ["confirm time"],
      callerIdentity: "pi"
    });

    const client = new WebSocket(`ws://127.0.0.1:${port}/voice/stream?token=not-a-real-token`);
    wsClients.push(client);

    let opened = false;
    let gotMessage = false;
    client.on("open", () => {
      opened = true;
    });
    client.on("message", () => {
      gotMessage = true;
    });

    const settled = deferred<void>();
    client.once("error", () => settled.resolve());
    client.once("close", () => settled.resolve());
    await withTimeout(settled.promise, 2000, undefined);

    expect(opened).toBe(false);
    expect(gotMessage).toBe(false);
  });

  it("AMD machine detected with amdPolicy 'hangup' ends the call without any media/realtime traffic", async () => {
    const realtimeFactory = vi.fn(() => {
      throw new Error("realtime session must never be constructed for a hangup-policy AMD call");
    });

    const home = tempHome();
    const provider = new MockProvider();
    const h = await startServer(makeConfig(home), { provider, realtimeFactory });
    handle = h;

    const rec = await h.manager.initiateCall({
      to: "+15551234567",
      objective: "confirm appointment",
      talkingPoints: ["confirm time"],
      callerIdentity: "pi",
      amdPolicy: "hangup"
    });

    const ended = deferred<void>();
    h.manager.once("ended", () => ended.resolve());

    await h.manager.handleProviderEvent(provider.amdEvent(rec.providerCallId!, "machine"));
    await withTimeout(ended.promise, 2000, undefined);

    const store = new CallStore(home);
    const finalRec = await store.get(rec.id);
    expect(finalRec?.status).toBe("completed");
    expect(finalRec?.endReason).toBe("amd-hangup");
    expect(finalRec?.amdResult).toBe("machine");
    expect(realtimeFactory).not.toHaveBeenCalled();
    expect(provider.calls.some((c) => (c as { method: string }).method === "hangupCall")).toBe(true);
  });

  // Controller ruling 1 (binding for this task): the AMD leave-message
  // branch switches the model into the voicemail prompt variant, which
  // structurally never calls note_outcome (see call-brain.ts) — if the call
  // ends with no noted outcome, teardown must default it to
  // {outcome:"voicemail-left", details:"answering machine detected;
  // voicemail delivered"} before summarization. Not one of the brief's three
  // scripted cases, but exercising it directly closes an otherwise-untested
  // gap around a binding ruling.
  it("AMD machine detected with amdPolicy 'leave-message' switches the model to the voicemail prompt and defaults the outcome to voicemail-left", async () => {
    const { url: realtimeUrl, getSessionUpdates } = await startVoicemailScriptedServer("voicemail-delivered");

    const home = tempHome();
    const provider = new MockProvider();
    const h = await startServer(makeConfig(home), {
      provider,
      realtimeFactory: (opts) => new RealtimeSession({ ...opts, urlOverride: realtimeUrl, connectTimeoutMs: 2000 })
    });
    handle = h;
    const port = (h.publicServer.address() as AddressInfo).port;

    const rec = await h.manager.initiateCall({
      to: "+15551234567",
      objective: "confirm appointment",
      talkingPoints: ["confirm time"],
      callerIdentity: "pi",
      amdPolicy: "leave-message"
    });

    const client = await connectClient(`ws://127.0.0.1:${port}/voice/stream?token=${rec.streamToken}`);
    const closed = deferred<void>();
    client.on("close", () => closed.resolve());
    // Echo any `mark` frame straight back, exactly as test 1 does — without
    // this, end_call's waitForPlayoutDrained() rides out its full 10s
    // default timeout instead of resolving promptly.
    client.on("message", (data: Buffer) => {
      const frame = JSON.parse(data.toString()) as Record<string, unknown>;
      if (frame.event === "mark") {
        const markName = (frame.mark as { name: string }).name;
        sendFrame(client, { event: "mark", mark: { name: markName } });
      }
    });
    sendFrame(client, { event: "start", start: { streamSid: "MZ_VM_STREAM" } });

    // Give the realtime session's initial connect() time to complete (ack
    // received) before triggering AMD — mirrors real-world timing (AMD
    // typically resolves shortly after the stream is already live) and
    // avoids racing switchToVoicemail's updateInstructions() against a
    // still-CONNECTING socket, which would silently drop the frame.
    await new Promise((resolve) => setTimeout(resolve, 100));

    await h.manager.handleProviderEvent(provider.amdEvent(rec.providerCallId!, "machine"));

    await withTimeout(closed.promise, 4000, undefined);

    const updates = getSessionUpdates();
    expect(updates.length).toBeGreaterThanOrEqual(2);
    const voicemailUpdate = updates[updates.length - 1]?.session as { instructions?: string };
    expect(voicemailUpdate.instructions).toContain("Voicemail:");

    const store = new CallStore(home);
    const finalRec = await waitForFinalizedRecord(store, rec.id);
    expect(finalRec?.status).toBe("completed");
    expect(finalRec?.endReason).toBe("voicemail-delivered");
    expect(finalRec?.outcome).toEqual({
      outcome: "voicemail-left",
      details: "answering machine detected; voicemail delivered"
    });
  }, 10_000);
});
