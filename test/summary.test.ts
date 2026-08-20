import { describe, it, expect } from "vitest";
import { summarizeCall } from "../src/summary.js";

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

function chatCompletionBody(outcome: string, summary: string): string {
  return JSON.stringify({ choices: [{ message: { content: JSON.stringify({ outcome, summary }) } }] });
}

describe("summarizeCall", () => {
  it("POSTs to OpenAI chat completions with model/messages/response_format and returns the parsed result", async () => {
    const { fetchImpl, requests } = fakeFetch([
      {
        status: 200,
        body: chatCompletionBody(
          "appointment confirmed",
          "The caller confirmed their Tuesday appointment and asked for the address."
        )
      }
    ]);

    const result = await summarizeCall({
      apiKey: "sk-test-key",
      model: "gpt-4o-mini",
      objective: "confirm the Tuesday appointment",
      transcript: "assistant: Hi\ncaller: Sure, Tuesday works",
      fetchImpl
    });

    expect(result).toEqual({
      outcome: "appointment confirmed",
      summary: "The caller confirmed their Tuesday appointment and asked for the address."
    });

    expect(requests).toHaveLength(1);
    const req = requests[0]!;
    expect(req.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(req.init.method).toBe("POST");
    const headers = req.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk-test-key");
    expect(headers["Content-Type"]).toBe("application/json");

    const body = JSON.parse(req.init.body as string);
    expect(body.model).toBe("gpt-4o-mini");
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.messages[0]).toEqual({
      role: "system",
      content: 'Summarize this phone call against its objective; reply as JSON {"outcome": one short line, "summary": 2-4 sentences}'
    });
    expect(body.messages[1].role).toBe("user");
    expect(body.messages[1].content).toContain("confirm the Tuesday appointment");
    expect(body.messages[1].content).toContain("assistant: Hi");
  });

  // Controller ruling (supersedes the brief's literal "truncated to
  // 12,000 chars"): a plain head-slice discards exactly where a call's
  // outcome tends to live — its closing turns. Truncation must keep a
  // 4,000-char head, an elision marker, and the last 8,000 chars of the
  // transcript, within the same 12,000-char budget.
  it("truncates a long transcript to a 4,000-char head + elision marker + 8,000-char tail, preserving the closing turns where the outcome lives", async () => {
    const { fetchImpl, requests } = fakeFetch([{ status: 200, body: chatCompletionBody("ok", "fine") }]);

    const headMarker = "HEAD-MARKER-OPENING-TURNS";
    const tailMarker = "TAIL-MARKER-CLOSING-TURNS-YES-TUESDAY-WORKS";
    const middleFiller = "MIDDLE-FILLER-SHOULD-BE-DROPPED";
    // Constructed so the implementation's exact slice boundaries
    // (`transcript.slice(0, 4000)` / `transcript.slice(-8000)`) line up
    // precisely with these marker placements — no ambiguity about whether a
    // marker landed inside or outside the kept region.
    const head = headMarker + "a".repeat(4_000 - headMarker.length);
    const middle = "m".repeat(6_000) + middleFiller + "m".repeat(6_000);
    const tail = "z".repeat(8_000 - tailMarker.length) + tailMarker;
    const longTranscript = head + middle + tail;

    await summarizeCall({
      apiKey: "sk-test-key",
      model: "gpt-4o-mini",
      objective: "test",
      transcript: longTranscript,
      fetchImpl
    });

    const body = JSON.parse(requests[0]!.init.body as string);
    const userContent = body.messages[1].content as string;
    const marker = "\n…[transcript truncated]…\n";
    const transcriptSection = userContent.slice(userContent.indexOf("Transcript:\n") + "Transcript:\n".length);

    expect(transcriptSection).toContain(headMarker);
    expect(transcriptSection).toContain(tailMarker);
    expect(transcriptSection).toContain(marker);
    expect(transcriptSection).not.toContain(middleFiller);
    expect(transcriptSection.length).toBeLessThanOrEqual(12_000 + marker.length);
  });

  it("leaves a transcript at or under 12,000 chars completely untouched (no elision marker introduced)", async () => {
    const { fetchImpl, requests } = fakeFetch([{ status: 200, body: chatCompletionBody("ok", "fine") }]);
    const shortTranscript = "assistant: Hi\ncaller: Yes, Tuesday works.\n" + "y".repeat(11_900);

    await summarizeCall({
      apiKey: "sk-test-key",
      model: "gpt-4o-mini",
      objective: "test",
      transcript: shortTranscript,
      fetchImpl
    });

    const body = JSON.parse(requests[0]!.init.body as string);
    const userContent = body.messages[1].content as string;

    expect(userContent).toContain(shortTranscript);
    expect(userContent).not.toContain("transcript truncated");
  });

  it("includes notedOutcome in the prompt when present", async () => {
    const { fetchImpl, requests } = fakeFetch([{ status: 200, body: chatCompletionBody("ok", "fine") }]);

    await summarizeCall({
      apiKey: "sk-test-key",
      model: "gpt-4o-mini",
      objective: "test",
      transcript: "hi",
      notedOutcome: { outcome: "voicemail-left", details: "left a message" },
      fetchImpl
    });

    const body = JSON.parse(requests[0]!.init.body as string);
    const userContent = body.messages[1].content as string;
    expect(userContent).toContain("voicemail-left");
    expect(userContent).toContain("left a message");
  });

  it("on a 500 API failure WITH a notedOutcome, echoes notedOutcome.outcome and the summary mentions the failure", async () => {
    const { fetchImpl } = fakeFetch([{ status: 500, body: "Internal Server Error" }]);

    const result = await summarizeCall({
      apiKey: "sk-test-key",
      model: "gpt-4o-mini",
      objective: "test",
      transcript: "hi",
      notedOutcome: { outcome: "voicemail-left" },
      fetchImpl
    });

    expect(result.outcome).toBe("voicemail-left");
    expect(result.summary.toLowerCase()).toContain("summary unavailable");
  });

  it("on a 500 API failure WITHOUT a notedOutcome, returns outcome 'unknown'", async () => {
    const { fetchImpl } = fakeFetch([{ status: 500, body: "Internal Server Error" }]);

    const result = await summarizeCall({
      apiKey: "sk-test-key",
      model: "gpt-4o-mini",
      objective: "test",
      transcript: "hi",
      fetchImpl
    });

    expect(result).toEqual({
      outcome: "unknown",
      summary: expect.stringContaining("Summary unavailable:")
    });
  });

  it("never throws even when fetchImpl itself rejects (network failure)", async () => {
    const throwingFetch = (async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:443");
    }) as typeof fetch;

    const result = await summarizeCall({
      apiKey: "sk-test-key",
      model: "gpt-4o-mini",
      objective: "test",
      transcript: "hi",
      fetchImpl: throwingFetch
    });

    expect(result.outcome).toBe("unknown");
    expect(result.summary).toContain("connect ECONNREFUSED");
  });

  it("never throws when the model returns malformed JSON in its message content", async () => {
    const { fetchImpl } = fakeFetch([
      { status: 200, body: JSON.stringify({ choices: [{ message: { content: "not valid json" } }] }) }
    ]);

    const result = await summarizeCall({
      apiKey: "sk-test-key",
      model: "gpt-4o-mini",
      objective: "test",
      transcript: "hi",
      fetchImpl
    });

    expect(result.outcome).toBe("unknown");
    expect(result.summary).toContain("Summary unavailable:");
  });

  it("POSTs to a custom OpenAI-compatible baseUrl when one is provided", async () => {
    const { fetchImpl, requests } = fakeFetch([{ status: 200, body: chatCompletionBody("ok", "fine") }]);

    await summarizeCall({
      apiKey: "sk-local",
      model: "my-local-model",
      baseUrl: "https://llm.example.com/v1",
      objective: "test",
      transcript: "hi",
      fetchImpl
    });

    expect(requests[0]!.url).toBe("https://llm.example.com/v1/chat/completions");
  });

  it("tolerates a trailing slash on baseUrl", async () => {
    const { fetchImpl, requests } = fakeFetch([{ status: 200, body: chatCompletionBody("ok", "fine") }]);

    await summarizeCall({
      apiKey: "sk-local",
      model: "my-local-model",
      baseUrl: "https://llm.example.com/v1/",
      objective: "test",
      transcript: "hi",
      fetchImpl
    });

    expect(requests[0]!.url).toBe("https://llm.example.com/v1/chat/completions");
  });

  // Controller note (task instructions): the API key must never appear in
  // thrown/returned text or logs. Defense in depth: even a pathological
  // fetchImpl error that happens to embed the key must not leak it back out.
  it("never leaks the API key into the returned outcome/summary text, even if the underlying error embeds it", async () => {
    const apiKey = "sk-super-secret-key";
    const leakyFetch = (async () => {
      throw new Error(`request failed, headers were Authorization: Bearer ${apiKey}`);
    }) as typeof fetch;

    const result = await summarizeCall({
      apiKey,
      model: "gpt-4o-mini",
      objective: "test",
      transcript: "hi",
      fetchImpl: leakyFetch
    });

    expect(result.outcome).not.toContain(apiKey);
    expect(result.summary).not.toContain(apiKey);
  });
});
