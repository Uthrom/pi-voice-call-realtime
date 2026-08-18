import { describe, it, expect } from "vitest";
import { VoiceBridgeClient, projectCallRecord } from "../extension/client.js";

interface CapturedRequest {
  url: string;
  init: RequestInit;
}

// Same fakeFetch shape as test/summary.test.ts's fetchImpl DI pattern: a
// queue of canned responses, one per expected call, clamped to the last
// entry if more calls happen than scripted (mirrors the codebase's existing
// convention for stubbing `typeof fetch`).
function scriptedFetch(responses: Array<{ status: number; body: string | null }>): {
  fetchImpl: typeof fetch;
  requests: CapturedRequest[];
} {
  const requests: CapturedRequest[] = [];
  let i = 0;
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    requests.push({ url: url.toString(), init: init ?? {} });
    const r = responses[Math.min(i, responses.length - 1)]!;
    i += 1;
    return new Response(r.body, { status: r.status });
  }) as typeof fetch;
  return { fetchImpl, requests };
}

function refusedFetch(): typeof fetch {
  return (async () => {
    throw Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:3335"), { code: "ECONNREFUSED" });
  }) as typeof fetch;
}

function instantSleep(): { sleepImpl: (ms: number) => Promise<void>; calls: number[] } {
  const calls: number[] = [];
  const sleepImpl = async (ms: number) => {
    calls.push(ms);
  };
  return { sleepImpl, calls };
}

const baseUrl = "http://127.0.0.1:3335";
const token = "secret-token";

const baseParams = {
  to: "+15550001111",
  objective: "book a table for two on Thursday at 7pm",
  talkingPoints: ["party of two", "prefers a window table"],
  callerIdentity: "pi"
};

describe("VoiceBridgeClient", () => {
  describe("initiateAndWait", () => {
    it("initiates, polls dialing -> answered -> completed, and shapes the result from the final record", async () => {
      const { fetchImpl, requests } = scriptedFetch([
        {
          status: 201,
          body: JSON.stringify({ id: "call-1", status: "dialing", createdAt: "2026-01-01T00:00:00.000Z" })
        },
        {
          status: 200,
          body: JSON.stringify({ id: "call-1", status: "answered", answeredAt: "2026-01-01T00:00:05.000Z" })
        },
        {
          status: 200,
          body: JSON.stringify({
            id: "call-1",
            status: "completed",
            answeredAt: "2026-01-01T00:00:05.000Z",
            endedAt: "2026-01-01T00:00:35.000Z",
            outcome: { outcome: "reservation-confirmed", details: "Thursday 7pm, party of two" },
            summary: "Booked a table for two on Thursday at 7pm.",
            transcriptPath: "/home/user/.pi-voice/transcripts/call-1.md"
          })
        }
      ]);
      const { sleepImpl, calls: sleepCalls } = instantSleep();
      const client = new VoiceBridgeClient({ baseUrl, token, fetchImpl, sleepImpl });

      const result = await client.initiateAndWait(baseParams, { pollMs: 2000 });

      expect(result).toEqual({
        status: "completed",
        outcome: "reservation-confirmed",
        details: "Thursday 7pm, party of two",
        summary: "Booked a table for two on Thursday at 7pm.",
        durationSec: 30,
        transcriptPath: "/home/user/.pi-voice/transcripts/call-1.md"
      });

      expect(requests).toHaveLength(3);
      expect(requests[0]!.url).toBe(`${baseUrl}/calls`);
      expect(requests[0]!.init.method).toBe("POST");
      expect((requests[0]!.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${token}`);
      expect(JSON.parse(requests[0]!.init.body as string)).toEqual(baseParams);
      expect(requests[1]!.url).toBe(`${baseUrl}/calls/call-1`);
      expect(requests[2]!.url).toBe(`${baseUrl}/calls/call-1`);
      expect(sleepCalls).toEqual([2000, 2000]);
    });

    it("returns an error result carrying the daemon's message on 409, without polling", async () => {
      const { fetchImpl, requests } = scriptedFetch([
        { status: 409, body: JSON.stringify({ error: "call-in-progress" }) }
      ]);
      const { sleepImpl, calls: sleepCalls } = instantSleep();
      const client = new VoiceBridgeClient({ baseUrl, token, fetchImpl, sleepImpl });

      const result = await client.initiateAndWait(baseParams);

      expect(result).toEqual({ status: "failed", error: "call-in-progress" });
      expect(requests).toHaveLength(1);
      expect(sleepCalls).toHaveLength(0);
    });

    it("returns an error result on 429 (daily cap) without polling", async () => {
      const { fetchImpl, requests } = scriptedFetch([
        { status: 429, body: JSON.stringify({ error: "daily-cap-reached" }) }
      ]);
      const { sleepImpl } = instantSleep();
      const client = new VoiceBridgeClient({ baseUrl, token, fetchImpl, sleepImpl });

      const result = await client.initiateAndWait(baseParams);

      expect(result).toEqual({ status: "failed", error: "daily-cap-reached" });
      expect(requests).toHaveLength(1);
    });

    it("ends the call and returns interrupted when polling exceeds the overall timeout", async () => {
      const { fetchImpl, requests } = scriptedFetch([
        { status: 201, body: JSON.stringify({ id: "call-2", status: "dialing" }) },
        { status: 200, body: JSON.stringify({ id: "call-2", status: "ringing" }) },
        { status: 200, body: JSON.stringify({ id: "call-2", status: "ringing" }) },
        { status: 200, body: JSON.stringify({ ok: true }) }
      ]);
      const { sleepImpl, calls: sleepCalls } = instantSleep();
      const client = new VoiceBridgeClient({ baseUrl, token, fetchImpl, sleepImpl });

      const result = await client.initiateAndWait(baseParams, { pollMs: 1000, overallTimeoutMs: 2000 });

      expect(result).toEqual({ status: "interrupted", error: "client-timeout" });
      expect(requests).toHaveLength(4);
      expect(requests[3]!.url).toBe(`${baseUrl}/calls/call-2/end`);
      expect(requests[3]!.init.method).toBe("POST");
      expect(sleepCalls).toEqual([1000, 1000]);
    });

    it("throws an actionable error when the daemon is unreachable on initiate", async () => {
      const client = new VoiceBridgeClient({
        baseUrl,
        token,
        fetchImpl: refusedFetch(),
        sleepImpl: instantSleep().sleepImpl
      });

      await expect(client.initiateAndWait(baseParams)).rejects.toThrow(
        `voice-bridge daemon not reachable at ${baseUrl} — start it with 'npm start' in the pi-voice-call-realtime directory`
      );
    });
  });

  describe("getStatus", () => {
    it("fetches a specific call by id", async () => {
      const { fetchImpl, requests } = scriptedFetch([
        { status: 200, body: JSON.stringify({ id: "call-3", status: "in-progress" }) }
      ]);
      const client = new VoiceBridgeClient({ baseUrl, token, fetchImpl });

      const rec = await client.getStatus("call-3");

      expect(rec).toEqual({ id: "call-3", status: "in-progress" });
      expect(requests[0]!.url).toBe(`${baseUrl}/calls/call-3`);
    });

    it("fetches the active call when no id is given", async () => {
      const { fetchImpl, requests } = scriptedFetch([
        { status: 200, body: JSON.stringify({ id: "call-4", status: "answered" }) }
      ]);
      const client = new VoiceBridgeClient({ baseUrl, token, fetchImpl });

      await client.getStatus();

      expect(requests[0]!.url).toBe(`${baseUrl}/calls/active`);
    });

    it("returns undefined when there is no active call (204)", async () => {
      const { fetchImpl } = scriptedFetch([{ status: 204, body: null }]);
      const client = new VoiceBridgeClient({ baseUrl, token, fetchImpl });

      await expect(client.getStatus()).resolves.toBeUndefined();
    });

    it("returns undefined for an unknown call id (404)", async () => {
      const { fetchImpl } = scriptedFetch([{ status: 404, body: "" }]);
      const client = new VoiceBridgeClient({ baseUrl, token, fetchImpl });

      await expect(client.getStatus("unknown-id")).resolves.toBeUndefined();
    });

    // streamToken is the daemon's sole bearer credential for the public WS
    // upgrade of that call (global-constraints.md: secrets never appear in
    // model prompts, transcripts, or logs) — but the daemon's real
    // CallRecord carries it, and getStatus()'s result flows straight into
    // voice_call's tool/command JSON output. Regression coverage for that
    // leak, independent of the projectCallRecord() unit test below.
    it("never leaks streamToken even though the daemon's raw record includes it", async () => {
      const { fetchImpl } = scriptedFetch([
        {
          status: 200,
          body: JSON.stringify({ id: "call-10", status: "in-progress", streamToken: "leak-me-not" })
        }
      ]);
      const client = new VoiceBridgeClient({ baseUrl, token, fetchImpl });

      const rec = await client.getStatus("call-10");

      expect(rec).toEqual({ id: "call-10", status: "in-progress" });
      expect(rec).not.toHaveProperty("streamToken");
    });
  });

  describe("projectCallRecord", () => {
    it("keeps only CallRecordLike's declared fields, dropping streamToken and any other unknown wire field", () => {
      const raw = {
        id: "call-11",
        status: "answered",
        streamToken: "super-secret-stream-token",
        params: { to: "+15550001111", objective: "book a table" },
        unexpectedField: "whatever the daemon might one day add"
      };

      const projected = projectCallRecord(raw);

      expect(projected).toEqual({ id: "call-11", status: "answered" });
      expect(Object.keys(projected)).not.toContain("streamToken");
      expect(Object.keys(projected)).not.toContain("params");
      expect(Object.keys(projected)).not.toContain("unexpectedField");
    });

    it("keeps every declared field, including a nested outcome, when present", () => {
      const raw = {
        id: "call-12",
        providerCallId: "CAxxxx",
        status: "completed",
        createdAt: "2026-01-01T00:00:00.000Z",
        answeredAt: "2026-01-01T00:00:05.000Z",
        endedAt: "2026-01-01T00:00:35.000Z",
        amdResult: "human",
        outcome: { outcome: "reservation-confirmed", details: "Thursday 7pm" },
        summary: "Booked a table.",
        transcriptPath: "/tmp/call-12.md",
        error: undefined,
        endReason: "operator",
        streamToken: "leak-me-not"
      };

      const projected = projectCallRecord(raw);

      expect(projected).toEqual({
        id: "call-12",
        providerCallId: "CAxxxx",
        status: "completed",
        createdAt: "2026-01-01T00:00:00.000Z",
        answeredAt: "2026-01-01T00:00:05.000Z",
        endedAt: "2026-01-01T00:00:35.000Z",
        amdResult: "human",
        outcome: { outcome: "reservation-confirmed", details: "Thursday 7pm" },
        summary: "Booked a table.",
        transcriptPath: "/tmp/call-12.md",
        endReason: "operator"
      });
      expect(projected).not.toHaveProperty("streamToken");
    });
  });

  describe("getTranscript", () => {
    it("returns the transcript text on success", async () => {
      const { fetchImpl, requests } = scriptedFetch([{ status: 200, body: "# Transcript\n\n..." }]);
      const client = new VoiceBridgeClient({ baseUrl, token, fetchImpl });

      const text = await client.getTranscript("call-5");

      expect(text).toBe("# Transcript\n\n...");
      expect(requests[0]!.url).toBe(`${baseUrl}/calls/call-5/transcript`);
    });

    it("throws a readable error when no transcript exists (404)", async () => {
      const { fetchImpl } = scriptedFetch([{ status: 404, body: "" }]);
      const client = new VoiceBridgeClient({ baseUrl, token, fetchImpl });

      await expect(client.getTranscript("call-6")).rejects.toThrow(/call-6/);
    });
  });

  describe("endCall", () => {
    it("POSTs to /calls/:id/end", async () => {
      const { fetchImpl, requests } = scriptedFetch([{ status: 200, body: JSON.stringify({ ok: true }) }]);
      const client = new VoiceBridgeClient({ baseUrl, token, fetchImpl });

      await client.endCall("call-7");

      expect(requests[0]!.url).toBe(`${baseUrl}/calls/call-7/end`);
      expect(requests[0]!.init.method).toBe("POST");
    });
  });

  describe("health", () => {
    it("returns { ok: true } when the daemon responds", async () => {
      const { fetchImpl } = scriptedFetch([
        { status: 200, body: JSON.stringify({ ok: true, activeCall: null, publicUrl: null }) }
      ]);
      const client = new VoiceBridgeClient({ baseUrl, token, fetchImpl });

      await expect(client.health()).resolves.toEqual({ ok: true });
    });

    it("returns undefined when the daemon is unreachable", async () => {
      const client = new VoiceBridgeClient({ baseUrl, token, fetchImpl: refusedFetch() });

      await expect(client.health()).resolves.toBeUndefined();
    });
  });
});
