// Adapted from openclaw-voice-call-realtime (MIT) — https://github.com/TristanBrotherton/openclaw-voice-call-realtime
import type { TelephonyProvider } from "../manager.js";
import { guardedJsonApiRequest } from "./guarded-json-api.js";

const TWILIO_HOSTNAME = "api.twilio.com";
const TWILIO_API_VERSION = "2010-04-01";

/**
 * Twilio Programmable Voice REST provider — raw REST calls (no Twilio SDK,
 * per global-constraints.md's dependency cap), outbound-call-only. Every
 * request goes through {@link guardedJsonApiRequest}, which enforces
 * https-only + a hostname allowlist + no redirect-following + a hard
 * request timeout.
 */
export class TwilioProvider implements TelephonyProvider {
  private readonly accountSid: string;
  private readonly authToken: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch | undefined;

  constructor(opts: { accountSid: string; authToken: string; fetchImpl?: typeof fetch }) {
    this.accountSid = opts.accountSid;
    this.authToken = opts.authToken;
    this.baseUrl = `https://${TWILIO_HOSTNAME}/${TWILIO_API_VERSION}/Accounts/${opts.accountSid}`;
    this.fetchImpl = opts.fetchImpl;
  }

  async createCall(opts: {
    to: string;
    from: string;
    answerUrl: string;
    statusCallbackUrl: string;
    amdCallbackUrl: string;
    timeoutSec: number;
  }): Promise<{ providerCallId: string }> {
    const body = new URLSearchParams({
      To: opts.to,
      From: opts.from,
      Url: opts.answerUrl,
      StatusCallback: opts.statusCallbackUrl,
      Timeout: String(opts.timeoutSec),
      // Async answering-machine detection: the call connects immediately;
      // Twilio posts AnsweredBy to amdCallbackUrl once it has decided.
      MachineDetection: "DetectMessageEnd",
      AsyncAmd: "true",
      AsyncAmdStatusCallback: opts.amdCallbackUrl
    });
    // Twilio requires one StatusCallbackEvent field PER event (repeated form
    // params, as twilio-node sends). A single space-separated value is
    // rejected with error 21626 and NO status callbacks are ever delivered —
    // observed live on 2026-08-18; every unanswered call wedged at "dialing".
    for (const event of ["initiated", "ringing", "answered", "completed"]) {
      body.append("StatusCallbackEvent", event);
    }

    const data = await this.post<TwilioCallResponse>("/Calls.json", body);
    return { providerCallId: data.sid };
  }

  async hangupCall(providerCallId: string): Promise<void> {
    const body = new URLSearchParams({ Status: "completed" });
    // allowNotFound: hanging up a call Twilio already considers gone (e.g.
    // the callee hung up moments earlier and Twilio's own status callback
    // just hasn't landed yet) is an expected race, not a real failure.
    await this.post(`/Calls/${encodeURIComponent(providerCallId)}.json`, body, { allowNotFound: true });
  }

  async getCall(providerCallId: string): Promise<{ status: string }> {
    const data = await guardedJsonApiRequest<{ status: string }>({
      url: `${this.baseUrl}/Calls/${encodeURIComponent(providerCallId)}.json`,
      method: "GET",
      headers: { Authorization: this.authHeader() },
      allowedHostnames: [TWILIO_HOSTNAME],
      fetchImpl: this.fetchImpl
    });
    return { status: data.status };
  }

  private async post<T = unknown>(
    path: string,
    body: URLSearchParams,
    opts: { allowNotFound?: boolean } = {}
  ): Promise<T> {
    return guardedJsonApiRequest<T>({
      url: `${this.baseUrl}${path}`,
      method: "POST",
      headers: {
        Authorization: this.authHeader(),
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: body.toString(),
      allowedHostnames: [TWILIO_HOSTNAME],
      allowNotFound: opts.allowNotFound,
      fetchImpl: this.fetchImpl
    });
  }

  private authHeader(): string {
    return `Basic ${Buffer.from(`${this.accountSid}:${this.authToken}`).toString("base64")}`;
  }
}

interface TwilioCallResponse {
  sid: string;
  status: string;
}
