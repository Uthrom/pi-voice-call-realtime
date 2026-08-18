import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { WebSocketServer, WebSocket } from "ws";
import { startServer, formatBanner, createShutdownHandler } from "../src/server.js";
import type { Config } from "../src/config.js";
import { CallStore } from "../src/store.js";
import { RealtimeSession } from "../src/realtime.js";
import { MockProvider } from "../src/providers/mock.js";

// Covers the daemon-entrypoint pieces of Task 14 that are extracted for
// testability per the brief: the secret-free startup banner, the
// idempotent/bounded shutdown handler (called directly rather than via a
// real process signal), and startServer's drainActiveSession() — which
// must let an in-flight call finish through its normal path when it can,
// and never let shutdown itself hang when it can't (binding controller
// notes 1 and 2 for this task).

const AUTH_TOKEN = "test-auth-token";

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "pi-voice-daemon-"));
}

function makeConfig(home: string): Config {
  return {
    home,
    twilio: { accountSid: "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", authToken: AUTH_TOKEN, fromNumber: "+15559998888" },
    openai: { apiKey: "sk-super-secret-openai-key", realtimeModel: "gpt-realtime", voice: "alloy" },
    summaryModel: "gpt-4o-mini",
    serve: {
      controlPort: 0,
      publicPort: 0,
      tunnel: "none",
      controlToken: "super-secret-control-token"
    },
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

/** A fake OpenAI Realtime server that just acks every session.update — enough to keep a CallSession genuinely connected/live. */
async function startAckOnlyRealtimeServer(): Promise<{ url: string }> {
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
      }
    });
  });
  return { url };
}

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

/** A fetch stub whose OpenAI-bound call never resolves — models a hung summarizeCall(). */
function stubHangingSummaryFetch(): void {
  const realFetch = globalThis.fetch.bind(globalThis);
  const fetchStub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === "https://api.openai.com/v1/chat/completions") {
      return new Promise<Response>(() => {}); // never resolves
    }
    return realFetch(input, init);
  });
  vi.stubGlobal("fetch", fetchStub);
}

async function bootWithLiveCall(overrides: { drainTimeoutMs?: number } = {}): Promise<{
  h: Handle;
  callId: string;
  store: CallStore;
}> {
  const { url: realtimeUrl } = await startAckOnlyRealtimeServer();
  const home = tempHome();
  const provider = new MockProvider();
  const h = await startServer(makeConfig(home), {
    provider,
    realtimeFactory: (opts) => new RealtimeSession({ ...opts, urlOverride: realtimeUrl, connectTimeoutMs: 2000 }),
    ...overrides
  });
  handle = h;
  const port = (h.publicServer.address() as AddressInfo).port;

  const rec = await h.manager.initiateCall({
    to: "+15551234567",
    objective: "say hello",
    talkingPoints: [],
    callerIdentity: "pi"
  });

  const client = await connectClient(`ws://127.0.0.1:${port}/voice/stream?token=${rec.streamToken}`);
  sendFrame(client, { event: "connected" });
  sendFrame(client, { event: "start", start: { streamSid: "MZ_TEST_STREAM" } });

  // Wait until the manager has actually observed the stream attach
  // (markStreaming) — the point at which activeSession/activeRun are
  // guaranteed set inside startServer's closure.
  const start = Date.now();
  while (h.manager.getActive()?.status !== "in-progress") {
    if (Date.now() - start > 3000) throw new Error("timed out waiting for call to reach in-progress");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  return { h, callId: rec.id, store: new CallStore(home) };
}

describe("formatBanner", () => {
  it("includes the public URL, both ports, and the from-number", () => {
    const cfg = makeConfig("/tmp/whatever");
    cfg.serve.controlPort = 3335;
    cfg.serve.publicPort = 3334;
    const banner = formatBanner(cfg, "https://abc123.trycloudflare.com");

    expect(banner).toContain("https://abc123.trycloudflare.com");
    expect(banner).toContain("3335");
    expect(banner).toContain("3334");
    expect(banner).toContain("+15559998888");
  });

  it("never includes the control token, Twilio auth token, or OpenAI API key", () => {
    const cfg = makeConfig("/tmp/whatever");
    const banner = formatBanner(cfg, "https://abc123.trycloudflare.com");

    expect(banner).not.toContain(cfg.serve.controlToken);
    expect(banner).not.toContain(cfg.twilio.authToken);
    expect(banner).not.toContain(cfg.openai.apiKey);
  });
});

describe("createShutdownHandler", () => {
  it("drains, then closes the server handle, then closes the tunnel, then exits with code 0 — in that order", async () => {
    const order: string[] = [];
    const fakeHandle = {
      drainActiveSession: vi.fn(async () => {
        order.push("drain");
      }),
      close: vi.fn(async () => {
        order.push("close");
      })
    };
    const fakeTunnel = {
      url: "https://example.com",
      close: vi.fn(async () => {
        order.push("tunnel-close");
      })
    };
    const exit = vi.fn((..._args: [number]) => {
      order.push("exit");
    });

    const shutdown = createShutdownHandler({ handle: fakeHandle, tunnel: fakeTunnel, exit });
    await shutdown("SIGINT");

    expect(order).toEqual(["drain", "close", "tunnel-close", "exit"]);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("exits cleanly with no tunnel configured", async () => {
    const fakeHandle = { drainActiveSession: vi.fn(async () => {}), close: vi.fn(async () => {}) };
    const exit = vi.fn();

    const shutdown = createShutdownHandler({ handle: fakeHandle, exit });
    await shutdown("SIGTERM");

    expect(exit).toHaveBeenCalledWith(0);
  });

  it("is idempotent — a second concurrent call does not re-run drain/close", async () => {
    const fakeHandle = { drainActiveSession: vi.fn(async () => {}), close: vi.fn(async () => {}) };
    const exit = vi.fn();
    const shutdown = createShutdownHandler({ handle: fakeHandle, exit });

    await Promise.all([shutdown("SIGINT"), shutdown("SIGINT")]);

    expect(fakeHandle.drainActiveSession).toHaveBeenCalledTimes(1);
    expect(fakeHandle.close).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it("still closes the handle and exits even when drainActiveSession itself rejects", async () => {
    const fakeHandle = {
      drainActiveSession: vi.fn(async () => {
        throw new Error("drain blew up");
      }),
      close: vi.fn(async () => {})
    };
    const exit = vi.fn();
    const shutdown = createShutdownHandler({ handle: fakeHandle, exit });

    await expect(shutdown("SIGINT")).resolves.toBeUndefined();
    expect(fakeHandle.close).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });
});

describe("startServer(...).drainActiveSession()", () => {
  it("resolves immediately when there is no active call", async () => {
    const home = tempHome();
    const h = await startServer(makeConfig(home), { provider: new MockProvider() });
    handle = h;

    const start = Date.now();
    await h.drainActiveSession();
    expect(Date.now() - start).toBeLessThan(200);
  });

  it(
    "gracefully ends an active call (endCall reason \"shutdown\") and finalizes it through the normal path before resolving",
    async () => {
      stubSummaryFetch("said hello", "Greeted the callee.");
      const { h, callId, store } = await bootWithLiveCall();

      await h.drainActiveSession();

      const rec = await store.get(callId);
      expect(rec?.status).toBe("completed");
      expect(rec?.endReason).toBe("shutdown");
    },
    10_000
  );

  it(
    "is bounded by drainTimeoutMs: if the call's own teardown hangs (summarize never resolves), drainActiveSession still resolves promptly, and does NOT override a record that already finalized through the normal endCall path",
    async () => {
      stubHangingSummaryFetch();
      const { h, callId, store } = await bootWithLiveCall({ drainTimeoutMs: 50 });
      const finalizeSpy = vi.spyOn(h.manager, "finalize");

      const start = Date.now();
      await h.drainActiveSession();
      const elapsed = Date.now() - start;

      // Bounded: nowhere near the 10s default, nor the never-resolving
      // summarize call — it must never gate shutdown.
      expect(elapsed).toBeLessThan(2000);

      // The record already reached a terminal status via the manager's own
      // normal endCall("shutdown") path (MockProvider's hangupCall/finalize
      // resolve fast, independent of the hung summarize call) — the
      // timeout's best-effort force-finalize(interrupted) fallback must not
      // clobber that with "interrupted" (controller ruling: a drained call
      // that completed its [manager-level] teardown finalizes through its
      // normal path).
      const rec = await store.get(callId);
      expect(rec?.status).toBe("completed");
      expect(rec?.endReason).toBe("shutdown");

      // The timeout path was still genuinely exercised — the fallback was
      // attempted (and, per the above, correctly no-op'd against an
      // already-terminal record).
      expect(finalizeSpy).toHaveBeenCalledWith(callId, "interrupted");
    },
    10_000
  );
});
