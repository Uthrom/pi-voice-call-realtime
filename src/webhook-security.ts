// Adapted from openclaw-voice-call-realtime (MIT) — https://github.com/TristanBrotherton/openclaw-voice-call-realtime
import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Validate a Twilio webhook signature using HMAC-SHA1.
 *
 * Twilio signs requests by concatenating the URL with sorted POST params,
 * then computing HMAC-SHA1 with the auth token, base64-encoded.
 *
 * @see https://www.twilio.com/docs/usage/webhooks/webhooks-security
 */
export function validateTwilioSignature(opts: {
  authToken: string;
  signature: string | undefined;
  url: string; // full public URL as Twilio saw it
  params: Record<string, string>; // parsed form body
}): boolean {
  const { authToken, signature, url, params } = opts;
  if (!signature) {
    return false;
  }

  const dataToSign =
    url +
    Object.keys(params)
      .sort()
      .map((key) => key + params[key])
      .join("");

  const expectedSignature = createHmac("sha1", authToken).update(dataToSign).digest("base64");

  return timingSafeEqualStrings(signature, expectedSignature);
}

// Timing-safe string comparison to prevent timing attacks. Falls back to a
// dummy constant-time comparison on length mismatch so the branch taken
// doesn't leak how close a forged signature was.
function timingSafeEqualStrings(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

// Hard cap on cache size. TTL expiry alone only reclaims a key when it is
// re-queried, so a key inserted once and never queried again would live
// forever; this bounds memory even under sustained insert-only traffic.
const MAX_ENTRIES = 1000;

/**
 * Dedupe repeated webhook deliveries (Twilio retries a webhook on timeout or
 * a non-2xx response, which would otherwise replay side effects).
 */
export class ReplayCache {
  private readonly ttlMs: number;
  private readonly seenUntil = new Map<string, number>();

  constructor(ttlMs = 5 * 60 * 1000) {
    this.ttlMs = ttlMs;
  }

  /**
   * True if already seen (and marks it either way).
   *
   * SECURITY: only call this after `validateTwilioSignature` has returned
   * true. `seen()` unconditionally inserts the key, so calling it on
   * unauthenticated requests lets anyone who can reach the public endpoint
   * grow the cache at request rate — the size cap below limits the damage,
   * but authenticate first regardless.
   */
  seen(key: string): boolean {
    const now = Date.now();
    const expiresAt = this.seenUntil.get(key);
    if (expiresAt !== undefined) {
      if (expiresAt > now) {
        return true;
      }
      this.seenUntil.delete(key);
    }

    this.seenUntil.set(key, now + this.ttlMs);
    if (this.seenUntil.size > MAX_ENTRIES) {
      const oldest = this.seenUntil.keys().next().value;
      if (oldest !== undefined) {
        this.seenUntil.delete(oldest);
      }
    }
    return false;
  }
}

/** Join a public base URL and a path without producing a double slash. */
export function publicUrlFor(publicUrl: string, path: string): string {
  return publicUrl.replace(/\/+$/, "") + "/" + path.replace(/^\/+/, "");
}
