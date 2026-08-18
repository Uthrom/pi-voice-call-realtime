import { createHmac } from "node:crypto";

// Computes a Twilio-style signature exactly as Twilio does, independent of
// the implementation under test (src/webhook-security.ts's
// validateTwilioSignature). Shared by test/webhook-security.test.ts and
// test/webhook.test.ts so both sign requests the same way.
export function sign(authToken: string, url: string, params: Record<string, string>): string {
  const data =
    url +
    Object.keys(params)
      .sort()
      .map((k) => k + params[k])
      .join("");
  return createHmac("sha1", authToken).update(data).digest("base64");
}
