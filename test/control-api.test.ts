import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { startServer } from "../src/server.js";
import type { Config } from "../src/config.js";
import { CallStore } from "../src/store.js";
import type { CallRecord } from "../src/types.js";
import { MockProvider } from "../src/providers/mock.js";

// Task 13: the localhost control API (initiate/status/transcript/end).
// Every test boots the real server (startServer) with a MockProvider and a
// temp home, then drives it over real HTTP against the ephemeral control
// port — no route logic is unit-tested in isolation.

const CONTROL_TOKEN = "test-control-token";

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "pi-voice-control-api-"));
}

function makeConfig(home: string, limitOverrides: Partial<Config["limits"]> = {}): Config {
  return {
    home,
    twilio: { accountSid: "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", authToken: "twilio-auth-token", fromNumber: "+15559998888" },
    openai: { apiKey: "sk-test", realtimeModel: "gpt-realtime", voice: "alloy" },
    summaryModel: "gpt-4o-mini",
    serve: { controlPort: 0, publicPort: 0, tunnel: "none", controlToken: CONTROL_TOKEN },
    limits: { maxDurationSec: 900, maxConcurrentCalls: 1, dailyCallCap: 20, ...limitOverrides },
    defaults: { callerIdentity: "pi", amdPolicy: "leave-message" }
  };
}

function makeSeedRecord(createdAt: string): CallRecord {
  return {
    id: randomUUID(),
    status: "completed",
    params: { to: "+15550000000", objective: "seed", talkingPoints: [], callerIdentity: "pi" },
    streamToken: randomBytes(16).toString("base64url"),
    createdAt,
    endedAt: createdAt
  };
}

type Handle = Awaited<ReturnType<typeof startServer>>;
let handle: Handle | undefined;

afterEach(async () => {
  if (handle) {
    const h = handle;
    handle = undefined;
    await h.close();
  }
});

async function boot(
  cfg?: Config,
  opts?: { provider?: MockProvider; store?: CallStore }
): Promise<{ handle: Handle; baseUrl: string; provider: MockProvider }> {
  const provider = opts?.provider ?? new MockProvider();
  const config = cfg ?? makeConfig(tempHome());
  const h = await startServer(config, { provider, ...(opts?.store ? { store: opts.store } : {}) });
  handle = h;
  const port = (h.controlServer.address() as AddressInfo).port;
  return { handle: h, baseUrl: `http://127.0.0.1:${port}`, provider };
}

function authed(token: string = CONTROL_TOKEN): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

function jsonHeaders(token: string = CONTROL_TOKEN): Record<string, string> {
  return { ...authed(token), "content-type": "application/json" };
}

describe("control API", () => {
  describe("auth", () => {
    it("rejects GET /calls/active with no Authorization header with 401", async () => {
      const { baseUrl } = await boot();
      const res = await fetch(`${baseUrl}/calls/active`);
      expect(res.status).toBe(401);
    });

    it("rejects GET /calls/active with a wrong bearer token with 401", async () => {
      const { baseUrl } = await boot();
      const res = await fetch(`${baseUrl}/calls/active`, { headers: authed("wrong-token") });
      expect(res.status).toBe(401);
    });

    it("rejects POST /calls with no Authorization header with 401 (mutating routes are gated too)", async () => {
      const { baseUrl } = await boot();
      const res = await fetch(`${baseUrl}/calls`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ to: "+15551234567", objective: "confirm appointment" })
      });
      expect(res.status).toBe(401);
    });

    it("GET /health requires no auth", async () => {
      const { baseUrl } = await boot();
      const res = await fetch(`${baseUrl}/health`);
      expect(res.status).toBe(200);
    });
  });

  describe("POST /calls", () => {
    it("rejects a body missing objective with 400 naming the field", async () => {
      const { baseUrl } = await boot();
      const res = await fetch(`${baseUrl}/calls`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ to: "+15551234567" })
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("objective");
    });

    it("rejects an invalid E.164 'to' with 400 naming the field", async () => {
      const { baseUrl } = await boot();
      const res = await fetch(`${baseUrl}/calls`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ to: "not-a-number", objective: "confirm appointment" })
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("to");
    });

    it("rejects a malformed JSON body with 400", async () => {
      const { baseUrl } = await boot();
      const res = await fetch(`${baseUrl}/calls`, {
        method: "POST",
        headers: jsonHeaders(),
        body: "{not valid json"
      });
      expect(res.status).toBe(400);
    });

    it("rejects an oversized body with 413", async () => {
      const { baseUrl } = await boot();
      const huge = "x".repeat(70 * 1024);
      const res = await fetch(`${baseUrl}/calls`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ to: "+15551234567", objective: "confirm appointment", talkingPoints: [huge] })
      });
      expect(res.status).toBe(413);
    });

    it("happy initiate: 201 with id, status dialing, and defaults applied", async () => {
      const { baseUrl } = await boot();
      const res = await fetch(`${baseUrl}/calls`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ to: "+15551234567", objective: "confirm the 7pm reservation" })
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as CallRecord;
      expect(body.id).toBeTruthy();
      expect(body.status).toBe("dialing");
      expect(body.params.talkingPoints).toEqual([]);
      expect(body.params.callerIdentity).toBe("pi");
    });

    it("passes through optional voice/maxDurationSec/amdPolicy fields", async () => {
      const { baseUrl } = await boot();
      const res = await fetch(`${baseUrl}/calls`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({
          to: "+15551234567",
          objective: "confirm appointment",
          voice: "verse",
          maxDurationSec: 300,
          amdPolicy: "hangup"
        })
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as CallRecord;
      expect(body.params.voice).toBe("verse");
      expect(body.params.maxDurationSec).toBe(300);
      expect(body.params.amdPolicy).toBe("hangup");
    });

    it("a second concurrent initiate returns 409 call-in-progress", async () => {
      const { baseUrl } = await boot();
      const first = await fetch(`${baseUrl}/calls`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ to: "+15551234567", objective: "confirm appointment" })
      });
      expect(first.status).toBe(201);

      const second = await fetch(`${baseUrl}/calls`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ to: "+15557654321", objective: "confirm another appointment" })
      });
      expect(second.status).toBe(409);
      const body = await second.json();
      expect(body).toEqual({ error: "call-in-progress" });
    });

    it("daily cap reached returns 429", async () => {
      const home = tempHome();
      const store = new CallStore(home);
      await store.save(makeSeedRecord(new Date().toISOString()));
      const cfg = makeConfig(home, { dailyCallCap: 1 });
      const { baseUrl } = await boot(cfg, { store });

      const res = await fetch(`${baseUrl}/calls`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ to: "+15551234567", objective: "confirm appointment" })
      });
      expect(res.status).toBe(429);
      const body = await res.json();
      expect(body).toEqual({ error: "daily-cap-reached" });
    });
  });

  describe("GET /calls/:id", () => {
    it("returns 404 for an unknown id", async () => {
      const { baseUrl } = await boot();
      const res = await fetch(`${baseUrl}/calls/${randomUUID()}`, { headers: authed() });
      expect(res.status).toBe(404);
    });

    it("returns the record for a known id", async () => {
      const { baseUrl, handle: h } = await boot();
      const rec = await h.manager.initiateCall({
        to: "+15551234567",
        objective: "confirm appointment",
        talkingPoints: [],
        callerIdentity: "pi"
      });
      const res = await fetch(`${baseUrl}/calls/${rec.id}`, { headers: authed() });
      expect(res.status).toBe(200);
      const body = (await res.json()) as CallRecord;
      expect(body.id).toBe(rec.id);
    });

    it("returns 500 (not a crash) when the record file on disk is corrupt", async () => {
      const home = tempHome();
      mkdirSync(join(home, "calls"), { recursive: true });
      const id = randomUUID();
      writeFileSync(join(home, "calls", `${id}.json`), "{not valid json");
      const { baseUrl } = await boot(makeConfig(home));

      const res = await fetch(`${baseUrl}/calls/${id}`, { headers: authed() });
      expect(res.status).toBe(500);

      // The listener must survive the crash-shaped failure — proven by a
      // completely independent, well-formed request succeeding right after.
      const following = await fetch(`${baseUrl}/calls/active`, { headers: authed() });
      expect(following.status).toBe(204);
    });
  });

  describe("GET /calls/active", () => {
    it("returns 204 when no call is active", async () => {
      const { baseUrl } = await boot();
      const res = await fetch(`${baseUrl}/calls/active`, { headers: authed() });
      expect(res.status).toBe(204);
    });

    it("returns the active record when one exists", async () => {
      const { baseUrl, handle: h } = await boot();
      const rec = await h.manager.initiateCall({
        to: "+15551234567",
        objective: "confirm appointment",
        talkingPoints: [],
        callerIdentity: "pi"
      });
      const res = await fetch(`${baseUrl}/calls/active`, { headers: authed() });
      expect(res.status).toBe(200);
      const body = (await res.json()) as CallRecord;
      expect(body.id).toBe(rec.id);
    });
  });

  describe("GET /calls/:id/transcript", () => {
    it("returns 404 when no transcript exists yet", async () => {
      const { baseUrl, handle: h } = await boot();
      const rec = await h.manager.initiateCall({
        to: "+15551234567",
        objective: "confirm appointment",
        talkingPoints: [],
        callerIdentity: "pi"
      });
      const res = await fetch(`${baseUrl}/calls/${rec.id}/transcript`, { headers: authed() });
      expect(res.status).toBe(404);
    });

    it("returns 404 for a transcript request against an unknown call id", async () => {
      const { baseUrl } = await boot();
      const res = await fetch(`${baseUrl}/calls/${randomUUID()}/transcript`, { headers: authed() });
      expect(res.status).toBe(404);
    });

    it("returns 404 when the record has a transcriptPath but the file on disk is missing", async () => {
      const home = tempHome();
      const store = new CallStore(home);
      const provider = new MockProvider();
      const { baseUrl, handle: h } = await boot(makeConfig(home), { provider, store });
      const rec = await h.manager.initiateCall({
        to: "+15551234567",
        objective: "confirm appointment",
        talkingPoints: [],
        callerIdentity: "pi"
      });
      const saved = await store.get(rec.id);
      await store.save({ ...saved!, transcriptPath: join(home, "transcripts", "does-not-exist.md") });

      const res = await fetch(`${baseUrl}/calls/${rec.id}/transcript`, { headers: authed() });
      expect(res.status).toBe(404);
    });

    it("returns the transcript file contents as text/markdown", async () => {
      const home = tempHome();
      const store = new CallStore(home);
      const provider = new MockProvider();
      const { baseUrl, handle: h } = await boot(makeConfig(home), { provider, store });
      const rec = await h.manager.initiateCall({
        to: "+15551234567",
        objective: "confirm appointment",
        talkingPoints: [],
        callerIdentity: "pi"
      });

      const transcriptPath = join(home, "transcripts", `${rec.id}.md`);
      mkdirSync(join(home, "transcripts"), { recursive: true });
      writeFileSync(transcriptPath, "# Call transcript\n\nhello world");
      const saved = await store.get(rec.id);
      await store.save({ ...saved!, transcriptPath });

      const res = await fetch(`${baseUrl}/calls/${rec.id}/transcript`, { headers: authed() });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/markdown");
      const text = await res.text();
      expect(text).toContain("hello world");
    });
  });

  describe("POST /calls/:id/end", () => {
    it("ends an active call: 200, and the record becomes terminal", async () => {
      const { baseUrl, handle: h } = await boot();
      const rec = await h.manager.initiateCall({
        to: "+15551234567",
        objective: "confirm appointment",
        talkingPoints: [],
        callerIdentity: "pi"
      });

      const res = await fetch(`${baseUrl}/calls/${rec.id}/end`, { method: "POST", headers: authed() });
      expect(res.status).toBe(200);

      const check = await fetch(`${baseUrl}/calls/${rec.id}`, { headers: authed() });
      const body = (await check.json()) as CallRecord;
      expect(body.status).toBe("completed");
      expect(body.endReason).toBe("operator");
    });

    it("ending an unknown call id is a 200 no-op, mirroring manager.endCall's own idempotent semantics", async () => {
      const { baseUrl } = await boot();
      const res = await fetch(`${baseUrl}/calls/${randomUUID()}/end`, { method: "POST", headers: authed() });
      expect(res.status).toBe(200);
    });
  });

  describe("GET /health", () => {
    it("reports ok:true, activeCall:null, and a publicUrl string when idle", async () => {
      const { baseUrl } = await boot();
      const res = await fetch(`${baseUrl}/health`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; activeCall: string | null; publicUrl: string | null };
      expect(body.ok).toBe(true);
      expect(body.activeCall).toBeNull();
      expect(typeof body.publicUrl).toBe("string");
    });

    it("reports the active call's id once a call is in flight", async () => {
      const { baseUrl, handle: h } = await boot();
      const rec = await h.manager.initiateCall({
        to: "+15551234567",
        objective: "confirm appointment",
        talkingPoints: [],
        callerIdentity: "pi"
      });
      const res = await fetch(`${baseUrl}/health`);
      const body = (await res.json()) as { activeCall: string | null };
      expect(body.activeCall).toBe(rec.id);
    });
  });

  it("an unknown route with valid auth returns 404", async () => {
    const { baseUrl } = await boot();
    const res = await fetch(`${baseUrl}/nope`, { headers: authed() });
    expect(res.status).toBe(404);
  });
});
