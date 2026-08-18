import type { CallOutcome } from "./types.js";

const OPENAI_CHAT_COMPLETIONS_URL = "https://api.openai.com/v1/chat/completions";
const MAX_TRANSCRIPT_CHARS = 12_000;

// Exact wording per the task brief — a test asserts this literal string.
const SYSTEM_PROMPT =
  'Summarize this phone call against its objective; reply as JSON {"outcome": one short line, "summary": 2-4 sentences}';

export interface SummarizeCallOpts {
  apiKey: string;
  model: string;
  objective: string;
  transcript: string;
  notedOutcome?: CallOutcome;
  fetchImpl?: typeof fetch;
}

export interface CallSummary {
  outcome: string;
  summary: string;
}

/**
 * Summarizes a completed call against its objective via a single OpenAI
 * chat-completions call (`response_format: {type:"json_object"}`).
 *
 * NEVER throws. Any failure — network error, non-2xx response, or a
 * malformed/missing JSON reply from the model — falls back to
 * `notedOutcome.outcome` (set in-call by the `note_outcome` tool) when one
 * was supplied, or `"unknown"` otherwise, with a `"Summary unavailable: <error>"`
 * summary.
 *
 * SECURITY: `apiKey` is used only in the Authorization header. It is never
 * interpolated into any thrown/returned/logged text; `redact()` below is a
 * defense-in-depth backstop in case a future `fetchImpl` ever echoes it back
 * in an error message (global-constraints.md: secrets never appear in model
 * prompts, transcripts, or logs).
 */
export async function summarizeCall(opts: SummarizeCallOpts): Promise<CallSummary> {
  const fetchFn = opts.fetchImpl ?? fetch;

  try {
    const truncated = opts.transcript.slice(0, MAX_TRANSCRIPT_CHARS);
    const userContent = buildUserContent(opts.objective, truncated, opts.notedOutcome);

    const res = await fetchFn(OPENAI_CHAT_COMPLETIONS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: opts.model,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userContent }
        ]
      })
    });

    if (!res.ok) {
      throw new Error(`OpenAI API error: ${res.status}`);
    }

    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      throw new Error("OpenAI response missing message content");
    }

    const parsed = JSON.parse(content) as { outcome?: unknown; summary?: unknown };
    if (typeof parsed.outcome !== "string" || typeof parsed.summary !== "string") {
      throw new Error("OpenAI response JSON missing outcome/summary");
    }

    return { outcome: parsed.outcome, summary: parsed.summary };
  } catch (err) {
    const message = redact(errorMessage(err), opts.apiKey);
    return {
      outcome: opts.notedOutcome?.outcome ?? "unknown",
      summary: `Summary unavailable: ${message}`
    };
  }
}

function buildUserContent(objective: string, transcript: string, notedOutcome?: CallOutcome): string {
  const parts = [`Objective: ${objective}`];
  if (notedOutcome) {
    const details = notedOutcome.details ? ` (${notedOutcome.details})` : "";
    parts.push(`Noted outcome during the call: ${notedOutcome.outcome}${details}`);
  }
  parts.push(`Transcript:\n${transcript}`);
  return parts.join("\n\n");
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function redact(message: string, apiKey: string): string {
  return apiKey ? message.split(apiKey).join("[redacted]") : message;
}
