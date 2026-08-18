import { describe, it, expect, vi } from "vitest";
import { TwilioProvider } from "../src/providers/twilio.js";
import { MockProvider } from "../src/providers/mock.js";
import { guardedJsonApiRequest, ProviderApiError, DEFAULT_TIMEOUT_MS } from "../src/providers/guarded-json-api.js";
import type { ProviderCallEvent } from "../src/manager.js";

interface CapturedRequest {
  url: string;
  init: RequestInit;
}

function fakeFetch(responses: Array<{ status: number; body: string }>): {
  fetchImpl: typeof fetch;
  requests: CapturedRequest[];
} {
  const requests: CapturedRequest[] = [];
  let i = 0;
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    requests.push({ url: url.toString(), init: init ?? {} });
    const r = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return new Response(r.body, { status: r.status });
  }) as typeof fetch;
  return { fetchImpl, requests };
}

const OPTS = {
  to: "+15551234567",
  from: "+15559998888",
  answerUrl: "https://example.com/voice/webhook?kind=answer",
  statusCallbackUrl: "https://example.com/voice/webhook?kind=status",
  amdCallbackUrl: "https://example.com/voice/webhook?kind=amd",
  timeoutSec: 30
};

describe("TwilioProvider", () => {
  describe("createCall", () => {
    it("POSTs to the Twilio Calls resource with Basic auth and the expected form body", async () => {
      const { fetchImpl, requests } = fakeFetch([{ status: 201, body: JSON.stringify({ sid: "CA123", status: "queued" }) }]);
      const provider = new TwilioProvider({ accountSid: "ACxxx", authToken: "tok", fetchImpl });

      const result = await provider.createCall(OPTS);

      expect(result).toEqual({ providerCallId: "CA123" });
      expect(requests).toHaveLength(1);
      const req = requests[0]!;
      expect(req.url).toBe("https://api.twilio.com/2010-04-01/Accounts/ACxxx/Calls.json");
      expect(req.init.method).toBe("POST");
      const headers = req.init.headers as Record<string, string>;
      expect(headers.Authorization).toBe(`Basic ${Buffer.from("ACxxx:tok").toString("base64")}`);

      const body = new URLSearchParams(req.init.body as string);
      expect(body.get("To")).toBe(OPTS.to);
      expect(body.get("From")).toBe(OPTS.from);
      expect(body.get("Url")).toBe(OPTS.answerUrl);
      expect(body.get("StatusCallback")).toBe(OPTS.statusCallbackUrl);
      expect(body.get("StatusCallbackEvent")).toBe("initiated ringing answered completed");
      expect(body.get("Timeout")).toBe("30");
      expect(body.get("MachineDetection")).toBe("DetectMessageEnd");
      expect(body.get("AsyncAmd")).toBe("true");
      expect(body.get("AsyncAmdStatusCallback")).toBe(OPTS.amdCallbackUrl);
    });

    it("throws a ProviderApiError including Twilio's error body on a non-2xx response", async () => {
      const { fetchImpl } = fakeFetch([
        { status: 400, body: JSON.stringify({ code: 21211, message: "Invalid 'To' Phone Number" }) }
      ]);
      const provider = new TwilioProvider({ accountSid: "ACxxx", authToken: "tok", fetchImpl });

      let thrown: unknown;
      try {
        await provider.createCall(OPTS);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(ProviderApiError);
      expect((thrown as Error).message).toMatch(/Invalid 'To' Phone Number/);
    });
  });

  describe("hangupCall", () => {
    it("POSTs Status=completed to the call's resource URL", async () => {
      const { fetchImpl, requests } = fakeFetch([{ status: 200, body: JSON.stringify({ sid: "CA123", status: "completed" }) }]);
      const provider = new TwilioProvider({ accountSid: "ACxxx", authToken: "tok", fetchImpl });

      await provider.hangupCall("CA123");

      expect(requests).toHaveLength(1);
      expect(requests[0]!.url).toBe("https://api.twilio.com/2010-04-01/Accounts/ACxxx/Calls/CA123.json");
      expect(requests[0]!.init.method).toBe("POST");
      const body = new URLSearchParams(requests[0]!.init.body as string);
      expect(body.get("Status")).toBe("completed");
    });

    it("does not throw when Twilio no longer has the call (404)", async () => {
      const { fetchImpl } = fakeFetch([{ status: 404, body: "" }]);
      const provider = new TwilioProvider({ accountSid: "ACxxx", authToken: "tok", fetchImpl });

      await expect(provider.hangupCall("CA123")).resolves.toBeUndefined();
    });
  });

  describe("getCall", () => {
    it("GETs the call's resource URL and returns its status", async () => {
      const { fetchImpl, requests } = fakeFetch([{ status: 200, body: JSON.stringify({ sid: "CA123", status: "in-progress" }) }]);
      const provider = new TwilioProvider({ accountSid: "ACxxx", authToken: "tok", fetchImpl });

      const result = await provider.getCall("CA123");

      expect(result).toEqual({ status: "in-progress" });
      expect(requests[0]!.init.method).toBe("GET");
      expect(requests[0]!.url).toBe("https://api.twilio.com/2010-04-01/Accounts/ACxxx/Calls/CA123.json");
    });
  });

  // Controller note: "Your HTTP calls MUST have a hard request timeout ...
  // The manager awaits provider calls while holding a global lock — a hung
  // Twilio request stalls all webhook processing."
  describe("request timeout", () => {
    it("every Twilio request carries an AbortSignal (wired for a hard timeout)", async () => {
      const { fetchImpl, requests } = fakeFetch([{ status: 201, body: JSON.stringify({ sid: "CA123" }) }]);
      const provider = new TwilioProvider({ accountSid: "ACxxx", authToken: "tok", fetchImpl });

      await provider.createCall(OPTS);

      expect(requests[0]!.init.signal).toBeInstanceOf(AbortSignal);
    });

    it("guardedJsonApiRequest rejects with a clear timeout error when the request never resolves", async () => {
      // Models real fetch/undici semantics: a fetchImpl that hangs forever
      // unless it observes the AbortSignal firing, at which point it
      // rejects with the signal's abort reason (a TimeoutError).
      const hangingFetch = ((_url: string, init?: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject((init.signal as AbortSignal).reason);
          });
        });
      }) as typeof fetch;

      let thrown: unknown;
      try {
        await guardedJsonApiRequest({
          url: "https://api.twilio.com/2010-04-01/Accounts/ACxxx/Calls.json",
          method: "POST",
          headers: {},
          allowedHostnames: ["api.twilio.com"],
          fetchImpl: hangingFetch,
          timeoutMs: 20
        });
      } catch (err) {
        thrown = err;
      }

      expect(thrown).toBeInstanceOf(ProviderApiError);
      expect((thrown as Error).message).toMatch(/timed out after 20ms/);
    });

    it("exports a documented default timeout applied when no override is given", () => {
      expect(DEFAULT_TIMEOUT_MS).toBe(15_000);
    });
  });

  // Controller note: "Thrown error messages must never embed credentials —
  // the Authorization header value or authToken must not appear in any
  // error text ... Twilio API error bodies are safe to include."
  describe("credential safety", () => {
    const authToken = "super-secret-auth-token";
    const expectedAuthHeader = `Basic ${Buffer.from(`ACxxx:${authToken}`).toString("base64")}`;

    it("a non-2xx Twilio response error never includes the auth token or Authorization header value", async () => {
      const { fetchImpl, requests } = fakeFetch([{ status: 500, body: "Internal Server Error" }]);
      const provider = new TwilioProvider({ accountSid: "ACxxx", authToken, fetchImpl });

      let thrown: unknown;
      try {
        await provider.createCall(OPTS);
      } catch (err) {
        thrown = err;
      }

      expect(thrown).toBeInstanceOf(Error);
      const message = (thrown as Error).message;
      expect(message).not.toContain(authToken);
      expect(message).not.toContain(expectedAuthHeader);
      // Sanity: the real request DID carry the credential — proves this is
      // a meaningful assertion about the error text, not vacuously true
      // because the request never happened.
      const headers = requests[0]!.init.headers as Record<string, string>;
      expect(headers.Authorization).toBe(expectedAuthHeader);
    });

    it("a network failure error never includes the auth token or Authorization header value", async () => {
      const throwingFetch = (async () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:443");
      }) as typeof fetch;
      const provider = new TwilioProvider({ accountSid: "ACxxx", authToken, fetchImpl: throwingFetch });

      let thrown: unknown;
      try {
        await provider.createCall(OPTS);
      } catch (err) {
        thrown = err;
      }

      expect(thrown).toBeInstanceOf(Error);
      const message = (thrown as Error).message;
      expect(message).not.toContain(authToken);
      expect(message).not.toContain(expectedAuthHeader);
    });
  });
});

describe("guardedJsonApiRequest SSRF guards", () => {
  it("rejects a non-https URL before ever calling fetch", async () => {
    const fetchImpl = vi.fn();

    await expect(
      guardedJsonApiRequest({
        url: "http://api.twilio.com/2010-04-01/Accounts/ACxxx/Calls.json",
        method: "GET",
        headers: {},
        allowedHostnames: ["api.twilio.com"],
        fetchImpl: fetchImpl as unknown as typeof fetch
      })
    ).rejects.toThrow(/https/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects a hostname outside the allowlist before ever calling fetch", async () => {
    const fetchImpl = vi.fn();

    await expect(
      guardedJsonApiRequest({
        url: "https://evil.example/Calls.json",
        method: "GET",
        headers: {},
        allowedHostnames: ["api.twilio.com"],
        fetchImpl: fetchImpl as unknown as typeof fetch
      })
    ).rejects.toThrow(/allowlist/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses to follow a redirect response instead of chasing Location", async () => {
    const fetchImpl = (async () => new Response(null, { status: 302, headers: { Location: "https://internal.example/" } })) as typeof fetch;

    await expect(
      guardedJsonApiRequest({
        url: "https://api.twilio.com/2010-04-01/Accounts/ACxxx/Calls.json",
        method: "GET",
        headers: {},
        allowedHostnames: ["api.twilio.com"],
        fetchImpl
      })
    ).rejects.toThrow(/redirect/);
  });

  it("returns undefined on 404 when allowNotFound is set", async () => {
    const fetchImpl = (async () => new Response(null, { status: 404 })) as typeof fetch;

    const result = await guardedJsonApiRequest({
      url: "https://api.twilio.com/2010-04-01/Accounts/ACxxx/Calls/CA1.json",
      method: "GET",
      headers: {},
      allowedHostnames: ["api.twilio.com"],
      allowNotFound: true,
      fetchImpl
    });

    expect(result).toBeUndefined();
  });
});

describe("MockProvider", () => {
  it("records every call and returns MOCK-N style ids", async () => {
    const provider = new MockProvider();

    const first = await provider.createCall(OPTS);
    const second = await provider.createCall(OPTS);

    expect(first.providerCallId).toBe("MOCK-1");
    expect(second.providerCallId).toBe("MOCK-2");
    expect(provider.calls).toHaveLength(2);
  });

  it("hangupCall and getCall record the call and reflect hangup in subsequent status", async () => {
    const provider = new MockProvider();
    const { providerCallId } = await provider.createCall(OPTS);

    expect(await provider.getCall(providerCallId)).toEqual({ status: "in-progress" });

    await provider.hangupCall(providerCallId);

    expect(await provider.getCall(providerCallId)).toEqual({ status: "completed" });
    expect(provider.calls.map((c) => (c as { method: string }).method)).toEqual([
      "createCall",
      "getCall",
      "hangupCall",
      "getCall"
    ]);
  });

  it("event factories build ProviderCallEvent objects ready for CallManager.handleProviderEvent", async () => {
    const provider = new MockProvider();
    const { providerCallId } = await provider.createCall(OPTS);

    const ringing: ProviderCallEvent = provider.progressEvent("ringing", providerCallId);
    expect(ringing).toEqual({ type: "ringing", providerCallId });

    const completed: ProviderCallEvent = provider.completedEvent(providerCallId, "completed");
    expect(completed).toEqual({ type: "completed", providerCallId, providerStatus: "completed" });

    const amd: ProviderCallEvent = provider.amdEvent(providerCallId, "machine");
    expect(amd).toEqual({ type: "amd", providerCallId, result: "machine" });
  });
});
