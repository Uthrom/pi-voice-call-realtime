import { EventEmitter } from "node:events";
import { randomBytes, randomUUID } from "node:crypto";
import type { Config } from "./config.js";
import type { CallStore } from "./store.js";
import { TERMINAL_STATUSES } from "./types.js";
import type { CallParams, CallRecord, CallStatus } from "./types.js";

// Provider contract lives here (rather than store.ts/types.ts) to avoid an
// import cycle: CallManager depends on it, and Task 5's Twilio/mock
// implementations depend on CallManager's exported type only, never the
// reverse.
export interface TelephonyProvider {
  createCall(opts: {
    to: string;
    from: string;
    answerUrl: string;
    statusCallbackUrl: string;
    amdCallbackUrl: string;
    timeoutSec: number;
  }): Promise<{ providerCallId: string }>;
  hangupCall(providerCallId: string): Promise<void>;
  getCall(providerCallId: string): Promise<{ status: string }>;
}

export type ProviderCallEvent =
  | { type: "initiated" | "ringing" | "answered"; providerCallId: string }
  | { type: "completed"; providerCallId: string; providerStatus: string } // raw Twilio CallStatus
  | { type: "amd"; providerCallId: string; result: "human" | "machine" };

export class CapacityError extends Error {}
export class DailyCapError extends Error {}

// Twilio ring timeout (global-constraints.md: "Ring timeout 30s"); not a
// configurable limit in this MVP.
const RING_TIMEOUT_SEC = 30;

// Forward order of the pre-answer chain. Used to reject a provider event
// that would move a call backwards (e.g. a stale "ringing" arriving after
// "answered" already landed) instead of clobbering later state.
const CHAIN_ORDER: readonly CallStatus[] = ["queued", "dialing", "ringing", "answered", "in-progress"];

const COMPLETED_STATUS_MAP: Readonly<Record<string, CallStatus>> = {
  completed: "completed",
  busy: "busy",
  "no-answer": "no-answer",
  failed: "failed",
  canceled: "canceled"
};

export class CallManager extends EventEmitter {
  private readonly store: CallStore;
  private readonly provider: TelephonyProvider;
  private readonly limits: Config["limits"];
  private readonly urls: { answerUrl: string; statusCallbackUrl: string; amdCallbackUrl: string };
  private readonly fromNumber: string;
  private readonly now: () => number;

  // MVP tracks a single active call in memory (matches the maxConcurrentCalls
  // default of 1); a second slot would require reworking this to a map.
  private active: CallRecord | undefined;
  private durationTimer: NodeJS.Timeout | undefined;

  constructor(opts: {
    store: CallStore;
    provider: TelephonyProvider;
    limits: Config["limits"];
    urls: { answerUrl: string; statusCallbackUrl: string; amdCallbackUrl: string };
    fromNumber: string;
    now?: () => number;
  }) {
    super();
    this.store = opts.store;
    this.provider = opts.provider;
    this.limits = opts.limits;
    this.urls = opts.urls;
    this.fromNumber = opts.fromNumber;
    this.now = opts.now ?? Date.now;
  }

  async initiateCall(params: CallParams): Promise<CallRecord> {
    // This MVP tracks exactly one active call in memory (see `active` field),
    // so it can only ever honor a maxConcurrentCalls of 1 — the configured
    // default. A slot is occupied whenever `active` is set, independent of
    // the configured value.
    if (this.active !== undefined) {
      throw new CapacityError(
        `at capacity: a call is already active (maxConcurrentCalls=${this.limits.maxConcurrentCalls})`
      );
    }

    const createdToday = await this.store.countCreatedToday(new Date(this.now()));
    if (createdToday >= this.limits.dailyCallCap) {
      throw new DailyCapError(`daily call cap of ${this.limits.dailyCallCap} reached`);
    }

    const pending: CallRecord = {
      id: randomUUID(),
      params,
      status: "queued",
      streamToken: randomBytes(16).toString("base64url"),
      createdAt: new Date(this.now()).toISOString()
    };
    this.active = pending;

    try {
      const { providerCallId } = await this.provider.createCall({
        to: params.to,
        from: this.fromNumber,
        answerUrl: this.urls.answerUrl,
        statusCallbackUrl: this.urls.statusCallbackUrl,
        amdCallbackUrl: this.urls.amdCallbackUrl,
        timeoutSec: RING_TIMEOUT_SEC
      });

      const rec: CallRecord = { ...pending, providerCallId, status: "dialing" };
      await this.persist(rec);
      this.emit("status", rec);
      return rec;
    } catch (err) {
      // createCall failed before we ever got a providerCallId — finalize the
      // pending record as failed instead of leaving it wedged as the
      // permanently-active call (which would lock out every future call).
      const message = err instanceof Error ? err.message : String(err);
      await this.finalize(pending.id, "failed", message);
      throw err;
    }
  }

  async handleProviderEvent(evt: ProviderCallEvent): Promise<void> {
    const rec = await this.getRecordByProviderCallId(evt.providerCallId);
    if (!rec) {
      this.warnIgnored(evt.type, evt.providerCallId, "no matching call record");
      return;
    }

    switch (evt.type) {
      case "amd":
        await this.handleAmdEvent(rec, evt.result);
        return;
      case "completed":
        await this.handleCompletedEvent(rec, evt.providerStatus);
        return;
      case "initiated":
      case "ringing":
      case "answered":
        await this.handleProgressEvent(rec, evt.type);
        return;
    }
  }

  async endCall(id: string, reason: string): Promise<void> {
    const rec = await this.getRecord(id);
    if (!rec) {
      console.warn(`[CallManager] endCall: no record found for id ${id}`);
      return;
    }
    if (TERMINAL_STATUSES.has(rec.status)) {
      return; // already ended — idempotent no-op
    }

    if (rec.providerCallId) {
      try {
        await this.provider.hangupCall(rec.providerCallId);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[CallManager] hangupCall(${rec.providerCallId}) failed: ${message}`);
      }
    }

    await this.finalize(id, "completed", reason);
  }

  async finalize(id: string, status: CallStatus, error?: string): Promise<void> {
    const rec = await this.getRecord(id);
    if (!rec) {
      console.warn(`[CallManager] finalize: no record found for id ${id}`);
      return;
    }
    if (TERMINAL_STATUSES.has(rec.status)) {
      this.warnIgnored("finalize", rec.providerCallId ?? id, `call ${id} already terminal (${rec.status})`);
      return;
    }

    const updated: CallRecord = {
      ...rec,
      status,
      endedAt: new Date(this.now()).toISOString(),
      ...(error !== undefined ? { error } : {})
    };
    await this.persist(updated);
    this.emit("status", updated);
    this.emit("ended", updated);
  }

  async markStreaming(id: string): Promise<void> {
    const rec = await this.getRecord(id);
    if (!rec) {
      console.warn(`[CallManager] markStreaming: no record found for id ${id}`);
      return;
    }
    if (rec.status !== "answered") {
      this.warnIgnored("markStreaming", rec.providerCallId ?? id, `call ${id} not in "answered" state (${rec.status})`);
      return;
    }

    const updated: CallRecord = { ...rec, status: "in-progress" };
    await this.persist(updated);
    this.emit("status", updated);
  }

  getActive(): CallRecord | undefined {
    return this.active;
  }

  getByStreamToken(token: string): CallRecord | undefined {
    return this.active?.streamToken === token ? this.active : undefined;
  }

  private async handleAmdEvent(rec: CallRecord, result: "human" | "machine"): Promise<void> {
    if (TERMINAL_STATUSES.has(rec.status)) {
      this.warnIgnored("amd", rec.providerCallId ?? rec.id, `call ${rec.id} already terminal (${rec.status})`);
      return;
    }
    const updated: CallRecord = { ...rec, amdResult: result };
    await this.persist(updated);
    this.emit("amd", updated, result);
  }

  private async handleCompletedEvent(rec: CallRecord, providerStatus: string): Promise<void> {
    if (TERMINAL_STATUSES.has(rec.status)) {
      this.warnIgnored("completed", rec.providerCallId ?? rec.id, `call ${rec.id} already terminal (${rec.status})`);
      return;
    }
    const mapped = COMPLETED_STATUS_MAP[providerStatus];
    if (!mapped) {
      this.warnIgnored("completed", rec.providerCallId ?? rec.id, `unrecognized providerStatus "${providerStatus}"`);
      return;
    }
    await this.finalize(rec.id, mapped);
  }

  private async handleProgressEvent(rec: CallRecord, type: "initiated" | "ringing" | "answered"): Promise<void> {
    if (TERMINAL_STATUSES.has(rec.status)) {
      this.warnIgnored(type, rec.providerCallId ?? rec.id, `call ${rec.id} already terminal (${rec.status})`);
      return;
    }

    const target: CallStatus = type === "initiated" ? "dialing" : type;
    const currentIdx = CHAIN_ORDER.indexOf(rec.status);
    const targetIdx = CHAIN_ORDER.indexOf(target);
    if (currentIdx === -1 || targetIdx < currentIdx) {
      this.warnIgnored(type, rec.providerCallId ?? rec.id, `out of order for call ${rec.id} (status ${rec.status})`);
      return;
    }

    const updated: CallRecord = { ...rec, status: target };
    if (target === "answered") {
      updated.answeredAt = new Date(this.now()).toISOString();
    }

    await this.persist(updated);
    this.emit("status", updated);
    if (target === "answered") {
      this.emit("answered", updated);
      this.startDurationTimer(updated);
    }
  }

  private async getRecord(id: string): Promise<CallRecord | undefined> {
    if (this.active?.id === id) return this.active;
    return this.store.get(id);
  }

  private async getRecordByProviderCallId(providerCallId: string): Promise<CallRecord | undefined> {
    if (this.active?.providerCallId === providerCallId) return this.active;
    return this.store.findByProviderCallId(providerCallId);
  }

  // Persists a record and keeps in-memory active-call tracking in sync:
  // updates it while non-terminal, clears it (and the duration timer) once
  // terminal. Every state-changing method routes through this.
  private async persist(rec: CallRecord): Promise<void> {
    await this.store.save(rec);
    if (this.active?.id === rec.id) {
      if (TERMINAL_STATUSES.has(rec.status)) {
        this.clearDurationTimer();
        this.active = undefined;
      } else {
        this.active = rec;
      }
    }
  }

  private startDurationTimer(rec: CallRecord): void {
    this.clearDurationTimer();
    const maxDurationSec = rec.params.maxDurationSec ?? this.limits.maxDurationSec;
    const timer = setTimeout(() => {
      void this.endCall(rec.id, "duration-cap");
    }, maxDurationSec * 1000);
    timer.unref();
    this.durationTimer = timer;
  }

  private clearDurationTimer(): void {
    if (this.durationTimer) {
      clearTimeout(this.durationTimer);
      this.durationTimer = undefined;
    }
  }

  private warnIgnored(eventType: string, providerCallIdOrId: string, reason: string): void {
    console.warn(`[CallManager] ignoring "${eventType}" event (${providerCallIdOrId}): ${reason}`);
  }
}
