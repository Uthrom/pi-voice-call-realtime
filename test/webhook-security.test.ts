import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { validateTwilioSignature, ReplayCache, publicUrlFor } from "../src/webhook-security.js";
import { sign } from "./helpers.js";

describe("validateTwilioSignature", () => {
  const authToken = "test-auth-token";
  const url = "https://x.example/voice/webhook";
  const params = { CallSid: "CA123", From: "+15550001111", To: "+15550002222" };

  it("accepts a valid signature", () => {
    const signature = sign(authToken, url, params);
    expect(validateTwilioSignature({ authToken, signature, url, params })).toBe(true);
  });

  it("rejects a tampered param", () => {
    const signature = sign(authToken, url, params);
    const tampered = { ...params, From: "+15559999999" };
    expect(validateTwilioSignature({ authToken, signature, url, params: tampered })).toBe(false);
  });

  it("rejects a missing signature", () => {
    expect(validateTwilioSignature({ authToken, signature: undefined, url, params })).toBe(false);
  });

  // Independent conformance anchor: this fixture is Twilio's own, taken
  // verbatim from twilio-python's RequestValidator test suite
  // (tests/unit/test_request_validator.py in twilio/twilio-python), not
  // derived from the `sign()` helper above. It pins this implementation to
  // Twilio's published algorithm rather than to this test file's own math,
  // so a shared porting bug in both `sign()` and the implementation (e.g.
  // wrong join separator, wrong sort, wrong digest encoding) would still
  // be caught.
  it("accepts Twilio's documented request-validation test vector", () => {
    const twilioAuthToken = "12345";
    const twilioUrl = "https://mycompany.com/myapp.php?foo=1&bar=2";
    const twilioParams = {
      CallSid: "CA1234567890ABCDE",
      Digits: "1234",
      From: "+14158675309",
      To: "+18005551212",
      Caller: "+14158675309"
    };
    const twilioSignature = "RSOYDt4T1cUTdK1PDd93/VVr8B8=";

    expect(
      validateTwilioSignature({
        authToken: twilioAuthToken,
        signature: twilioSignature,
        url: twilioUrl,
        params: twilioParams
      })
    ).toBe(true);
  });
});

describe("ReplayCache", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns false the first time a key is seen, then true for the same key", () => {
    const cache = new ReplayCache();
    expect(cache.seen("key-1")).toBe(false);
    expect(cache.seen("key-1")).toBe(true);
  });

  it("returns false again after the ttl elapses", () => {
    const cache = new ReplayCache(5 * 60 * 1000);
    expect(cache.seen("key-1")).toBe(false);
    expect(cache.seen("key-1")).toBe(true);
    vi.advanceTimersByTime(5 * 60 * 1000 + 1);
    expect(cache.seen("key-1")).toBe(false);
  });

  it("caps its size, evicting the oldest key so the newest is retained", () => {
    const cache = new ReplayCache();
    const MAX_ENTRIES = 1000; // mirrors ReplayCache's internal cap

    for (let i = 0; i <= MAX_ENTRIES; i++) {
      cache.seen(`key-${i}`);
    }

    // The oldest key was evicted to keep the cache bounded: re-querying it
    // looks unseen (inserted anew) rather than already-seen.
    expect(cache.seen("key-0")).toBe(false);
    // The newest key survived the cap.
    expect(cache.seen(`key-${MAX_ENTRIES}`)).toBe(true);
  });
});

describe("publicUrlFor", () => {
  it("joins a trailing-slash base URL and a leading-slash path without a double slash", () => {
    expect(publicUrlFor("https://x.example/", "/voice/webhook")).toBe(
      "https://x.example/voice/webhook"
    );
  });

  it("joins cleanly regardless of slash presence on either side", () => {
    expect(publicUrlFor("https://x.example", "/voice/webhook")).toBe(
      "https://x.example/voice/webhook"
    );
    expect(publicUrlFor("https://x.example", "voice/webhook")).toBe(
      "https://x.example/voice/webhook"
    );
    expect(publicUrlFor("https://x.example/", "voice/webhook")).toBe(
      "https://x.example/voice/webhook"
    );
  });
});
