// Adapted from openclaw-voice-call-realtime (MIT) — https://github.com/TristanBrotherton/openclaw-voice-call-realtime
//
// The reference implementation delegates to an external SSRF-guard runtime
// (`openclaw/plugin-sdk/ssrf-runtime`) that isn't available to us
// (global-constraints.md caps runtime deps at exactly `ws` + `zod`). This
// ports its two guarantees using only Fetch/URL built-ins: https-only, and
// never following a redirect — the simplest way to guarantee a redirect can
// never land on a private range is to never follow one at all — plus a hard
// request timeout so a hung request can never stall a caller indefinitely.

/**
 * Thrown by {@link guardedJsonApiRequest} for URL/SSRF-guard rejections,
 * network failures, timeouts, and non-2xx provider responses.
 *
 * Messages are safe to persist/log: callers must never interpolate request
 * headers (which may carry an Authorization credential) into the message
 * passed here. A provider's own error response body is fine to include.
 */
export class ProviderApiError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "ProviderApiError";
    this.status = status;
  }
}

// Example value suggested by task-5's controller notes; long enough for a
// slow-but-healthy Twilio API call, short enough that a hung request can't
// stall the CallManager's global lock indefinitely.
export const DEFAULT_TIMEOUT_MS = 15_000;

export interface GuardedJsonApiRequestParams {
  url: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  /** Pre-encoded request body (e.g. `URLSearchParams#toString()`). */
  body?: string;
  /** Exact hostnames this request is allowed to reach. */
  allowedHostnames: readonly string[];
  /** Treat a 404 response as "no result" instead of throwing. */
  allowNotFound?: boolean;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Overrides {@link DEFAULT_TIMEOUT_MS}. */
  timeoutMs?: number;
}

/**
 * SSRF-guarded fetch wrapper for outbound calls to telephony provider REST
 * APIs. Rejects non-https URLs and hostnames outside the caller's allowlist
 * before ever calling fetch, refuses to follow redirects, applies a hard
 * timeout, and parses the JSON response body.
 */
export async function guardedJsonApiRequest<T = unknown>(params: GuardedJsonApiRequestParams): Promise<T> {
  const fetchFn = params.fetchImpl ?? fetch;
  const parsedUrl = guardUrl(params.url, params.allowedHostnames);
  const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let response: Response;
  try {
    response = await fetchFn(parsedUrl.toString(), {
      method: params.method,
      headers: params.headers,
      body: params.body,
      // Never auto-follow a redirect: the target could point at a private
      // address even when the original hostname passed the allowlist above.
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      throw new ProviderApiError(`request to ${parsedUrl.hostname} timed out after ${timeoutMs}ms`);
    }
    // SECURITY: never interpolate `params.headers` into this message — it
    // may carry the Authorization header, and this error text is persisted
    // to call records and logged (global-constraints.md: secrets must never
    // appear in logs).
    const message = err instanceof Error ? err.message : String(err);
    throw new ProviderApiError(`request to ${parsedUrl.hostname} failed: ${message}`);
  }

  if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
    throw new ProviderApiError(`refusing to follow redirect from ${parsedUrl.hostname}`);
  }

  if (!response.ok) {
    if (params.allowNotFound && response.status === 404) {
      return undefined as T;
    }
    const errorText = await response.text();
    throw new ProviderApiError(`provider API error: ${response.status} ${errorText}`, response.status);
  }

  const text = await response.text();
  return text ? (JSON.parse(text) as T) : (undefined as T);
}

function guardUrl(url: string, allowedHostnames: readonly string[]): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ProviderApiError("invalid request URL");
  }
  if (parsed.protocol !== "https:") {
    throw new ProviderApiError(`refusing non-https URL (protocol "${parsed.protocol}")`);
  }
  if (!allowedHostnames.includes(parsed.hostname)) {
    throw new ProviderApiError(`hostname "${parsed.hostname}" is not in the allowlist`);
  }
  return parsed;
}
