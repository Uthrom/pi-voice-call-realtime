import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { startServer } from "../src/server.js";
import type { Config } from "../src/config.js";
import { MockProvider } from "../src/providers/mock.js";
import { sign } from "./helpers.js";

const AUTH_TOKEN = "test-auth-token";

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "pi-voice-webhook-"));
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

afterEach(async () => {
  if (handle) {
    await handle.close();
    handle = undefined;
  }
});

async function boot(): Promise<{ handle: Handle; baseUrl: string; provider: MockProvider }> {
  const provider = new MockProvider();
  const h = await startServer(makeConfig(tempHome()), { provider });
  handle = h;
  const port = (h.publicServer.address() as AddressInfo).port;
  return { handle: h, baseUrl: `http://127.0.0.1:${port}`, provider };
}

function callParams(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    CallSid: "CA-DOES-NOT-EXIST",
    AccountSid: "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    From: "+15559998888",
    To: "+15551234567",
    CallStatus: "ringing",
    Direction: "outbound-api",
    ...overrides
  };
}

async function postSigned(
  baseUrl: string,
  path: string,
  params: Record<string, string>,
  opts: { authToken?: string; badSignature?: boolean } = {}
): Promise<Response> {
  const url = `${baseUrl}${path}`;
  const body = new URLSearchParams(params).toString();
  const signature = opts.badSignature
    ? "AAAAAAAAAAAAAAAAAAAAAAAAAAA="
    : sign(opts.authToken ?? AUTH_TOKEN, url, params);
  return fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-twilio-signature": signature
    },
    body
  });
}

describe("public webhook server", () => {
  it("kind=answer: known CallSid returns Connect/Stream TwiML with the stream URL and token", async () => {
    const { baseUrl, provider } = await boot();
    const rec = await handle!.manager.initiateCall({
      to: "+15551234567",
      objective: "confirm appointment",
      talkingPoints: ["confirm time"],
      callerIdentity: "pi"
    });
    expect(provider.calls).toHaveLength(1);

    const res = await postSigned(baseUrl, "/voice/webhook?kind=answer", callParams({ CallSid: rec.providerCallId! }));

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/xml");
    const body = await res.text();
    const port = (handle!.publicServer.address() as AddressInfo).port;
    expect(body).toContain(`wss://127.0.0.1:${port}/voice/stream`);
    expect(body).toContain(`value="${rec.streamToken}"`);
    expect(body).toContain("<Connect>");
  });

  it("kind=answer: unknown CallSid returns Hangup TwiML", async () => {
    const { baseUrl } = await boot();
    await handle!.manager.initiateCall({
      to: "+15551234567",
      objective: "confirm appointment",
      talkingPoints: ["confirm time"],
      callerIdentity: "pi"
    });

    const res = await postSigned(baseUrl, "/voice/webhook?kind=answer", callParams({ CallSid: "CA-UNKNOWN-999" }));

    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("<Hangup/>");
    expect(body).not.toContain("<Connect>");
  });

  it("kind=status: CallStatus in-progress transitions the record to answered", async () => {
    const { baseUrl } = await boot();
    const rec = await handle!.manager.initiateCall({
      to: "+15551234567",
      objective: "confirm appointment",
      talkingPoints: ["confirm time"],
      callerIdentity: "pi"
    });

    const res = await postSigned(
      baseUrl,
      "/voice/webhook?kind=status",
      callParams({ CallSid: rec.providerCallId!, CallStatus: "in-progress" })
    );

    expect(res.status).toBe(200);
    expect(handle!.manager.getActive()?.status).toBe("answered");
    expect(handle!.manager.getActive()?.answeredAt).toBeTruthy();
  });

  it("kind=status: CallStatus ringing transitions the record to ringing", async () => {
    const { baseUrl } = await boot();
    const rec = await handle!.manager.initiateCall({
      to: "+15551234567",
      objective: "confirm appointment",
      talkingPoints: ["confirm time"],
      callerIdentity: "pi"
    });

    const res = await postSigned(
      baseUrl,
      "/voice/webhook?kind=status",
      callParams({ CallSid: rec.providerCallId!, CallStatus: "ringing" })
    );

    expect(res.status).toBe(200);
    expect(handle!.manager.getActive()?.status).toBe("ringing");
  });

  it("kind=status: a terminal CallStatus (completed) finalizes the record as completed", async () => {
    const { baseUrl } = await boot();
    const rec = await handle!.manager.initiateCall({
      to: "+15551234567",
      objective: "confirm appointment",
      talkingPoints: ["confirm time"],
      callerIdentity: "pi"
    });

    const res = await postSigned(
      baseUrl,
      "/voice/webhook?kind=status",
      callParams({ CallSid: rec.providerCallId!, CallStatus: "completed" })
    );

    expect(res.status).toBe(200);
    expect(handle!.manager.getActive()).toBeUndefined();
  });

  it("kind=amd: AnsweredBy starting with machine maps to amdResult machine", async () => {
    const { baseUrl } = await boot();
    const rec = await handle!.manager.initiateCall({
      to: "+15551234567",
      objective: "confirm appointment",
      talkingPoints: ["confirm time"],
      callerIdentity: "pi"
    });
    const amdHandler = vi.fn();
    handle!.manager.on("amd", amdHandler);

    const res = await postSigned(
      baseUrl,
      "/voice/webhook?kind=amd",
      callParams({ CallSid: rec.providerCallId!, AnsweredBy: "machine_start", CallStatus: "in-progress" })
    );

    expect(res.status).toBe(200);
    expect(amdHandler).toHaveBeenCalledTimes(1);
    expect(handle!.manager.getActive()?.amdResult).toBe("machine");
  });

  it("kind=amd: AnsweredBy human maps to amdResult human", async () => {
    const { baseUrl } = await boot();
    const rec = await handle!.manager.initiateCall({
      to: "+15551234567",
      objective: "confirm appointment",
      talkingPoints: ["confirm time"],
      callerIdentity: "pi"
    });

    const res = await postSigned(
      baseUrl,
      "/voice/webhook?kind=amd",
      callParams({ CallSid: rec.providerCallId!, AnsweredBy: "human", CallStatus: "in-progress" })
    );

    expect(res.status).toBe(200);
    expect(handle!.manager.getActive()?.amdResult).toBe("human");
  });

  it("kind=amd: an unrecognized AnsweredBy value is ignored (no amdResult, no error)", async () => {
    const { baseUrl } = await boot();
    const rec = await handle!.manager.initiateCall({
      to: "+15551234567",
      objective: "confirm appointment",
      talkingPoints: ["confirm time"],
      callerIdentity: "pi"
    });
    const amdHandler = vi.fn();
    handle!.manager.on("amd", amdHandler);

    const res = await postSigned(
      baseUrl,
      "/voice/webhook?kind=amd",
      callParams({ CallSid: rec.providerCallId!, AnsweredBy: "unknown", CallStatus: "in-progress" })
    );

    expect(res.status).toBe(200);
    expect(amdHandler).not.toHaveBeenCalled();
    expect(handle!.manager.getActive()?.amdResult).toBeUndefined();
  });

  it("an invalid signature returns 403 and leaves the record unchanged, before any other processing", async () => {
    const { baseUrl } = await boot();
    const rec = await handle!.manager.initiateCall({
      to: "+15551234567",
      objective: "confirm appointment",
      talkingPoints: ["confirm time"],
      callerIdentity: "pi"
    });

    const res = await postSigned(
      baseUrl,
      "/voice/webhook?kind=status",
      callParams({ CallSid: rec.providerCallId!, CallStatus: "in-progress" }),
      { badSignature: true }
    );

    expect(res.status).toBe(403);
    expect(handle!.manager.getActive()?.status).toBe("dialing");

    // The forged attempt above must not have poisoned the replay cache: the
    // legitimate follow-up with a correctly computed signature over the
    // exact same params must still succeed, not be treated as a replay.
    const legit = await postSigned(
      baseUrl,
      "/voice/webhook?kind=status",
      callParams({ CallSid: rec.providerCallId!, CallStatus: "in-progress" })
    );
    expect(legit.status).toBe(200);
    expect(handle!.manager.getActive()?.status).toBe("answered");
  });

  it("GET /anything returns 404", async () => {
    const { baseUrl } = await boot();
    const res = await fetch(`${baseUrl}/anything`);
    expect(res.status).toBe(404);
  });

  it("GET /voice/webhook (wrong method) returns 404", async () => {
    const { baseUrl } = await boot();
    const res = await fetch(`${baseUrl}/voice/webhook?kind=status`);
    expect(res.status).toBe(404);
  });

  it("POST /voice/webhook with no/unknown kind returns 404", async () => {
    const { baseUrl } = await boot();
    const res = await postSigned(baseUrl, "/voice/webhook", callParams());
    expect(res.status).toBe(404);
  });

  it("a replayed status POST is processed exactly once", async () => {
    const { baseUrl } = await boot();
    const rec = await handle!.manager.initiateCall({
      to: "+15551234567",
      objective: "confirm appointment",
      talkingPoints: ["confirm time"],
      callerIdentity: "pi"
    });
    const spy = vi.spyOn(handle!.manager, "handleProviderEvent");
    const params = callParams({ CallSid: rec.providerCallId!, CallStatus: "in-progress" });

    const first = await postSigned(baseUrl, "/voice/webhook?kind=status", params);
    const second = await postSigned(baseUrl, "/voice/webhook?kind=status", params);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("a replayed answer POST still re-serves the TwiML (not deduped — no side effects to protect)", async () => {
    const { baseUrl } = await boot();
    const rec = await handle!.manager.initiateCall({
      to: "+15551234567",
      objective: "confirm appointment",
      talkingPoints: ["confirm time"],
      callerIdentity: "pi"
    });
    const params = callParams({ CallSid: rec.providerCallId! });

    const first = await postSigned(baseUrl, "/voice/webhook?kind=answer", params);
    const second = await postSigned(baseUrl, "/voice/webhook?kind=answer", params);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const secondBody = await second.text();
    expect(secondBody).toContain(`value="${rec.streamToken}"`);
  });

  it("a body over the 100KB cap is rejected without being processed", async () => {
    const { baseUrl } = await boot();
    const rec = await handle!.manager.initiateCall({
      to: "+15551234567",
      objective: "confirm appointment",
      talkingPoints: ["confirm time"],
      callerIdentity: "pi"
    });

    const huge = "x".repeat(101 * 1024);
    const params = callParams({ CallSid: rec.providerCallId!, CallStatus: "in-progress", Padding: huge });
    const url = `${baseUrl}/voice/webhook?kind=status`;
    const body = new URLSearchParams(params).toString();
    const signature = sign(AUTH_TOKEN, url, params);

    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": signature },
      body
    });

    expect(res.status).toBe(413);
    expect(handle!.manager.getActive()?.status).toBe("dialing");
  });

  it("control server responds to GET /health with {ok:true}", async () => {
    const { handle: h } = await boot();
    const port = (h.controlServer.address() as AddressInfo).port;
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
  });
});
