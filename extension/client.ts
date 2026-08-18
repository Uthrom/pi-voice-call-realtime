// This file must import NOTHING from `src/` — pi loads the extension
// standalone (via jiti), independent of this repo's own module graph. The
// wire types below are therefore a deliberate, local re-declaration of the
// shapes `src/types.ts` and the control API (src/control-api.ts) already
// define, not an import of them. Keep the two in sync by hand if the wire
// contract changes.

export type CallStatus =
  | "queued"
  | "dialing"
  | "ringing"
  | "answered"
  | "in-progress"
  | "completed"
  | "no-answer"
  | "busy"
  | "failed"
  | "canceled"
  | "interrupted";

const TERMINAL_STATUSES: ReadonlySet<CallStatus> = new Set([
  "completed",
  "no-answer",
  "busy",
  "failed",
  "canceled",
  "interrupted"
]);

export type AmdPolicy = "leave-message" | "hangup";

export interface CallParamsInput {
  to: string;
  objective: string;
  talkingPoints?: string[];
  callerIdentity?: string;
  voice?: string;
  maxDurationSec?: number;
  amdPolicy?: AmdPolicy;
}

export interface CallOutcomeLike {
  outcome: string;
  details?: string;
}

export interface CallRecordLike {
  id: string;
  providerCallId?: string;
  status: CallStatus;
  createdAt?: string;
  answeredAt?: string;
  endedAt?: string;
  amdResult?: "human" | "machine";
  outcome?: CallOutcomeLike;
  summary?: string;
  transcriptPath?: string;
  error?: string; // genuine failure only (e.g. createCall threw) — see toResult() below
  endReason?: string; // why a non-error termination happened (e.g. "duration-cap", "operator")
}

export interface VoiceCallResult {
  status: string;
  outcome?: string;
  details?: string;
  summary?: string;
  durationSec?: number;
  transcriptPath?: string;
  error?: string;
}

// Mirrors config.ts's `limits.maxDurationSec` default. Duplicated, not
// imported, for the same isolation reason as the types above — this is the
// fallback used only when a caller's params and initiateAndWait's opts both
// omit maxDurationSec/overallTimeoutMs.
const DEFAULT_MAX_DURATION_SEC = 900;
const DEFAULT_POLL_MS = 2000;

/**
 * Thin HTTP client for the voice-bridge daemon's localhost control API
 * (src/control-api.ts). Holds every bit of extension-side logic — polling,
 * timeout handling, error-message mapping, result shaping — so it can be
 * unit-tested with a stubbed `fetchImpl`/`sleepImpl`; `extension/voice-call.ts`
 * is deliberately just wiring on top of this class.
 */
export class VoiceBridgeClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleepImpl: (ms: number) => Promise<void>;

  constructor(opts: {
    baseUrl: string;
    token: string;
    fetchImpl?: typeof fetch;
    sleepImpl?: (ms: number) => Promise<void>;
  }) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.token = opts.token;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleepImpl = opts.sleepImpl ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /**
   * POST /calls, then poll GET /calls/:id every `pollMs` (default 2000)
   * until the record reaches a terminal status or the overall timeout
   * elapses. The overall timeout is tracked as a virtual clock — accumulated
   * `pollMs` per iteration, not wall-clock `Date.now()` — so a stubbed
   * instant `sleepImpl` still exercises the timeout path deterministically
   * in tests, without an actual wait.
   *
   * A non-201 initiate response (409 call-in-progress, 429 daily-cap-reached,
   * 400 validation) is returned as a `{status:"failed", error}` result with
   * no polling at all. A network-level failure on initiate (daemon down) is
   * the one case that throws rather than returns — see `request()`.
   */
  async initiateAndWait(
    params: CallParamsInput,
    opts?: { pollMs?: number; overallTimeoutMs?: number }
  ): Promise<VoiceCallResult> {
    const pollMs = opts?.pollMs ?? DEFAULT_POLL_MS;
    const maxDurationSec = params.maxDurationSec ?? DEFAULT_MAX_DURATION_SEC;
    const overallTimeoutMs = opts?.overallTimeoutMs ?? maxDurationSec * 1000 + 60_000;

    const initiateRes = await this.request("POST", "/calls", params);
    if (initiateRes.status !== 201) {
      const message = await extractErrorMessage(initiateRes);
      return { status: "failed", error: message };
    }

    let current = (await initiateRes.json()) as CallRecordLike;
    const id = current.id;
    let elapsedMs = 0;

    for (;;) {
      if (TERMINAL_STATUSES.has(current.status)) {
        return toResult(current);
      }
      if (elapsedMs >= overallTimeoutMs) {
        try {
          await this.endCall(id);
        } catch {
          // Best-effort: the client is already giving up on this call, and
          // the daemon may be the reason (down, or the call just finished
          // between the last poll and here). Either way, the caller still
          // gets a definitive "interrupted" result rather than a rejection.
        }
        return { status: "interrupted", error: "client-timeout" };
      }
      await this.sleepImpl(pollMs);
      elapsedMs += pollMs;
      const next = await this.getStatus(id);
      if (next) current = next;
    }
  }

  /** `callId` given → GET /calls/:id. Omitted → GET /calls/active ("most recent" per spec §2.2). */
  async getStatus(callId?: string): Promise<CallRecordLike | undefined> {
    const path = callId ? `/calls/${callId}` : "/calls/active";
    const res = await this.request("GET", path);
    if (res.status === 404 || res.status === 204) return undefined;
    if (!res.ok) {
      throw new Error(`unexpected response status ${res.status} from GET ${path}`);
    }
    return (await res.json()) as CallRecordLike;
  }

  async getTranscript(callId: string): Promise<string> {
    const path = `/calls/${callId}/transcript`;
    const res = await this.request("GET", path);
    if (res.status === 404) {
      throw new Error(`no transcript available for call ${callId}`);
    }
    if (!res.ok) {
      throw new Error(`unexpected response status ${res.status} fetching transcript for call ${callId}`);
    }
    return res.text();
  }

  async endCall(callId: string): Promise<void> {
    const path = `/calls/${callId}/end`;
    const res = await this.request("POST", path);
    if (!res.ok) {
      throw new Error(`unexpected response status ${res.status} ending call ${callId}`);
    }
  }

  /** Never throws — `undefined` covers both an unreachable daemon and a non-OK response. */
  async health(): Promise<{ ok: boolean } | undefined> {
    try {
      const res = await this.request("GET", "/health");
      if (!res.ok) return undefined;
      const body = (await res.json()) as { ok?: boolean };
      return { ok: Boolean(body.ok) };
    } catch {
      return undefined;
    }
  }

  private async request(method: string, path: string, body?: unknown): Promise<Response> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.token}` };
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    try {
      return await this.fetchImpl(`${this.baseUrl}${path}`, init);
    } catch {
      // Any fetch-level rejection (ECONNREFUSED chief among them — the
      // daemon isn't running) becomes this one actionable message, verbatim
      // per the brief, rather than leaking a raw "fetch failed" error.
      throw new Error(
        `voice-bridge daemon not reachable at ${this.baseUrl} — start it with 'npm start' in the pi-voice-call-realtime directory`
      );
    }
  }
}

function toResult(rec: CallRecordLike): VoiceCallResult {
  return {
    status: rec.status,
    outcome: rec.outcome?.outcome,
    // `error` is reserved for a genuine failure (rec.error); `endReason` is a
    // benign termination reason (e.g. "duration-cap", "operator") and is
    // surfaced through `details` instead — falling back to it only when the
    // call never got a structured outcome, so the two are never conflated
    // into the same field.
    details: rec.outcome?.details ?? rec.endReason,
    summary: rec.summary,
    durationSec: computeDurationSec(rec.answeredAt, rec.endedAt),
    transcriptPath: rec.transcriptPath,
    error: rec.error
  };
}

function computeDurationSec(answeredAt: string | undefined, endedAt: string | undefined): number | undefined {
  if (!answeredAt || !endedAt) return undefined;
  const ms = new Date(endedAt).getTime() - new Date(answeredAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return undefined;
  return Math.round(ms / 1000);
}

async function extractErrorMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    if (typeof body?.error === "string") return body.error;
  } catch {
    // Non-JSON or empty body — fall through to the generic message below.
  }
  return `unexpected response status ${res.status}`;
}
