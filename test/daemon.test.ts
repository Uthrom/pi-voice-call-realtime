import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { createServer as createNetServer } from "node:net";
import type { AddressInfo } from "node:net";
import type { spawn } from "node:child_process";
import { WebSocketServer, WebSocket } from "ws";
import { startServer, formatBanner, createShutdownHandler, bootDaemon } from "../src/server.js";
import type { Config } from "../src/config.js";
import { CallStore } from "../src/store.js";
import { RealtimeSession } from "../src/realtime.js";
import { MockProvider } from "../src/providers/mock.js";
import type { TelephonyProvider } from "../src/manager.js";

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

/** Binds an ephemeral TCP port, reads it, and releases it. */
function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const port = (probe.address() as AddressInfo).port;
      probe.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

/** Binds and holds a TCP port so it looks occupied to a subsequent listen() attempt. */
/**
 * Binds and holds a TCP port so it looks occupied to a subsequent listen()
 * attempt. Deliberately binds with no host argument (all interfaces),
 * matching exactly how startServer itself binds the public port
 * (`listen(publicServer, cfg.serve.publicPort)`, no host) — binding this
 * occupier to "127.0.0.1" specifically does NOT reliably conflict with a
 * later no-host bind on this platform (verified empirically), so the host
 * here must match.
 */
function occupyPort(port: number): Promise<import("node:net").Server> {
  return new Promise((resolve, reject) => {
    const occupier = createNetServer();
    occupier.once("error", reject);
    occupier.listen(port, () => resolve(occupier));
  });
}

/** A minimal ChildProcess-like fake, mirroring test/tunnel.test.ts's own — an EventEmitter with stdout/stderr sub-emitters and a stubbed kill(). */
function fakeChildProcess(): EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: ReturnType<typeof vi.fn> } {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
  };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  // Mirrors a real process's behavior closely enough for makeProcessTunnel's
  // close() to resolve promptly instead of riding out its 2s fallback timer.
  proc.kill = vi.fn(() => {
    setTimeout(() => proc.emit("close", 0), 5);
    return true;
  });
  return proc;
}

function fakeSpawnImpl(proc: ReturnType<typeof fakeChildProcess>): typeof spawn {
  return ((..._args: unknown[]) => proc) as unknown as typeof spawn;
}

/** A TelephonyProvider whose hangupCall never settles — models a genuinely wedged Twilio hangup request, for exercising Finding 3's force-terminal fallback. */
class HangingHangupProvider implements TelephonyProvider {
  private readonly inner = new MockProvider();

  async createCall(opts: Parameters<TelephonyProvider["createCall"]>[0]): ReturnType<TelephonyProvider["createCall"]> {
    return this.inner.createCall(opts);
  }

  async hangupCall(_providerCallId: string): Promise<void> {
    return new Promise(() => {
      // never resolves
    });
  }

  async getCall(providerCallId: string): ReturnType<TelephonyProvider["getCall"]> {
    return this.inner.getCall(providerCallId);
  }
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
  it("closes the control listener, then drains, then closes the rest of the server, then the tunnel, then exits with code 0 — in that order", async () => {
    const order: string[] = [];
    const fakeHandle = {
      closeControl: vi.fn(async () => {
        order.push("closeControl");
      }),
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

    // closeControl is deliberately first: it stops new work (POST /calls)
    // from landing during the drain, while drain itself must run before
    // the rest of the server (public listener/wss, which Twilio still
    // needs to reach) and the tunnel are torn down.
    expect(order).toEqual(["closeControl", "drain", "close", "tunnel-close", "exit"]);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("exits cleanly with no tunnel configured", async () => {
    const fakeHandle = {
      closeControl: vi.fn(async () => {}),
      drainActiveSession: vi.fn(async () => {}),
      close: vi.fn(async () => {})
    };
    const exit = vi.fn();

    const shutdown = createShutdownHandler({ handle: fakeHandle, exit });
    await shutdown("SIGTERM");

    expect(exit).toHaveBeenCalledWith(0);
  });

  it("is idempotent — a second concurrent call does not re-run closeControl/drain/close", async () => {
    const fakeHandle = {
      closeControl: vi.fn(async () => {}),
      drainActiveSession: vi.fn(async () => {}),
      close: vi.fn(async () => {})
    };
    const exit = vi.fn();
    const shutdown = createShutdownHandler({ handle: fakeHandle, exit });

    await Promise.all([shutdown("SIGINT"), shutdown("SIGINT")]);

    expect(fakeHandle.closeControl).toHaveBeenCalledTimes(1);
    expect(fakeHandle.drainActiveSession).toHaveBeenCalledTimes(1);
    expect(fakeHandle.close).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it("still drains, closes the handle, and exits even when closeControl and drainActiveSession both reject", async () => {
    const fakeHandle = {
      closeControl: vi.fn(async () => {
        throw new Error("closeControl blew up");
      }),
      drainActiveSession: vi.fn(async () => {
        throw new Error("drain blew up");
      }),
      close: vi.fn(async () => {})
    };
    const exit = vi.fn();
    const shutdown = createShutdownHandler({ handle: fakeHandle, exit });

    await expect(shutdown("SIGINT")).resolves.toBeUndefined();
    expect(fakeHandle.drainActiveSession).toHaveBeenCalledTimes(1);
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

      const start = Date.now();
      await h.drainActiveSession();
      const elapsed = Date.now() - start;

      // Bounded: nowhere near the 10s default, nor the never-resolving
      // summarize call — it must never gate shutdown.
      expect(elapsed).toBeLessThan(2000);

      // The record already reached a terminal status via the manager's own
      // normal endCall("shutdown") path (MockProvider's hangupCall/finalize
      // resolve fast, independent of the hung summarize call) — the
      // timeout's force-terminal fallback (writing directly through the
      // store) must not clobber that with "interrupted" (controller ruling:
      // a drained call that completed its [manager-level] teardown
      // finalizes through its normal path). error is the tell: it's only
      // ever set by the force-terminal path, never by endCall's own.
      const rec = await store.get(callId);
      expect(rec?.status).toBe("completed");
      expect(rec?.endReason).toBe("shutdown");
      expect(rec?.error).toBeUndefined();
    },
    10_000
  );

  it(
    "drains a pre-stream active call (still dialing/ringing, no CallSession/media stream yet) via manager.endCall, and reaches a terminal record",
    async () => {
      const home = tempHome();
      const provider = new MockProvider();
      const h = await startServer(makeConfig(home), { provider });
      handle = h;

      const rec = await h.manager.initiateCall({
        to: "+15551234567",
        objective: "say hello",
        talkingPoints: [],
        callerIdentity: "pi"
      });
      // No media stream is ever connected — activeSession/activeRun stay
      // undefined for this call the whole time, exactly the pre-stream
      // dialing/ringing window (up to Twilio's 30s ring timeout) that a
      // SIGINT could land in.
      expect(h.manager.getActive()?.id).toBe(rec.id);

      const start = Date.now();
      await h.drainActiveSession();
      expect(Date.now() - start).toBeLessThan(2000);

      const store = new CallStore(home);
      const finalRec = await store.get(rec.id);
      expect(finalRec?.status).toBe("completed");
      expect(finalRec?.endReason).toBe("shutdown");
    },
    10_000
  );

  it(
    "when the provider's hangupCall is genuinely wedged (never settles), drainActiveSession is still bounded and force-writes a terminal record with error \"shutdown-drain-timeout\"",
    async () => {
      const home = tempHome();
      const provider = new HangingHangupProvider();
      const h = await startServer(makeConfig(home), { provider, drainTimeoutMs: 50 });
      handle = h;

      const rec = await h.manager.initiateCall({
        to: "+15551234567",
        objective: "say hello",
        talkingPoints: [],
        callerIdentity: "pi"
      });

      const start = Date.now();
      await h.drainActiveSession();
      const elapsed = Date.now() - start;

      // Bounded even though manager.endCall's own hangupCall call — and
      // therefore the manager's serialized lock queue — never resolves at
      // all: the force-terminal write bypasses the manager entirely (see
      // ruling 3), so it isn't stuck queued behind the wedged call.
      expect(elapsed).toBeLessThan(2000);

      const store = new CallStore(home);
      const finalRec = await store.get(rec.id);
      expect(finalRec?.status).toBe("interrupted");
      expect(finalRec?.error).toBe("shutdown-drain-timeout");
    },
    10_000
  );
});

describe("startServer(...).closeControl()", () => {
  it("stops accepting new control requests immediately, while the public listener stays reachable", async () => {
    const home = tempHome();
    const h = await startServer(makeConfig(home), { provider: new MockProvider() });
    handle = h;
    const controlPort = (h.controlServer.address() as AddressInfo).port;
    const publicPort = (h.publicServer.address() as AddressInfo).port;

    await h.closeControl();

    // The control listener is down — a subsequent request to it fails
    // outright (connection refused), not just a 401/404.
    await expect(fetch(`http://127.0.0.1:${controlPort}/health`)).rejects.toThrow();

    // The public listener (webhooks + media stream) must stay up through
    // the drain — Twilio still needs to reach it for whatever call is in
    // flight. GET / isn't a route webhook.ts defines, but a 404 (a real
    // HTTP response) proves the listener itself is still accepting
    // connections, as opposed to refusing them outright like the control
    // port above.
    const publicRes = await fetch(`http://127.0.0.1:${publicPort}/`);
    expect(publicRes.status).toBe(404);
  });
});

describe("bootDaemon", () => {
  it("closes a spawned tunnel process when startServer subsequently fails (e.g. the public port is already in use)", async () => {
    const occupiedPort = await getFreePort();
    const occupier = await occupyPort(occupiedPort);
    try {
      const proc = fakeChildProcess();
      const spawnImpl = fakeSpawnImpl(proc);

      const cfg = makeConfig(tempHome());
      cfg.serve.tunnel = "cloudflared";
      cfg.serve.publicPort = occupiedPort;

      const bootPromise = bootDaemon(cfg, spawnImpl);
      await Promise.resolve();
      proc.stderr.emit("data", Buffer.from("https://abc123.trycloudflare.com\n"));

      await expect(bootPromise).rejects.toThrow();
      expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
    } finally {
      await new Promise<void>((resolve) => occupier.close(() => resolve()));
    }
  });
});
