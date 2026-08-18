// Adapted from openclaw-voice-call-realtime (MIT) — https://github.com/TristanBrotherton/openclaw-voice-call-realtime
import type { ProviderCallEvent, TelephonyProvider } from "../manager.js";

/**
 * In-memory fake `TelephonyProvider` for tests. Records every call it
 * receives (`calls`) so a test can assert on exactly what CallManager sent
 * it, and exposes small `*Event` factories that build a `ProviderCallEvent`
 * for a call it created — ready to hand straight to
 * `CallManager.handleProviderEvent(...)` — for integration tests (Task 12)
 * that want to drive the state machine without a real signed webhook POST.
 */
export class MockProvider implements TelephonyProvider {
  readonly calls: unknown[] = [];
  private counter = 0;
  private readonly hungUp = new Set<string>();

  async createCall(opts: {
    to: string;
    from: string;
    answerUrl: string;
    statusCallbackUrl: string;
    amdCallbackUrl: string;
    timeoutSec: number;
  }): Promise<{ providerCallId: string }> {
    this.counter += 1;
    const providerCallId = `MOCK-${this.counter}`;
    this.calls.push({ method: "createCall", opts, providerCallId });
    return { providerCallId };
  }

  async hangupCall(providerCallId: string): Promise<void> {
    this.calls.push({ method: "hangupCall", providerCallId });
    this.hungUp.add(providerCallId);
  }

  async getCall(providerCallId: string): Promise<{ status: string }> {
    this.calls.push({ method: "getCall", providerCallId });
    return { status: this.hungUp.has(providerCallId) ? "completed" : "in-progress" };
  }

  /** Builds an `initiated`/`ringing`/`answered` event for a call this provider created. */
  progressEvent(type: "initiated" | "ringing" | "answered", providerCallId: string): ProviderCallEvent {
    return { type, providerCallId };
  }

  /** Builds a `completed` event carrying a raw Twilio-style CallStatus. */
  completedEvent(providerCallId: string, providerStatus: string): ProviderCallEvent {
    return { type: "completed", providerCallId, providerStatus };
  }

  /** Builds an async-AMD-result event. */
  amdEvent(providerCallId: string, result: "human" | "machine"): ProviderCallEvent {
    return { type: "amd", providerCallId, result };
  }
}
