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
// that would move a call backwards, or re-apply one already applied (e.g. a
// duplicate "answered" webhook), instead of clobbering later state.
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
  // Bound to the call that armed it, so a stale/non-active record's provider
  // event can never disarm or retarget the active call's cap.
  private durationTimer: { callId: string; handle: NodeJS.Timeout } | undefined;

  // Serializes every mutating operation (initiateCall, handleProviderEvent,
  // endCall, finalize, markStreaming) into a single FIFO queue. Twilio
  // delivers status/AMD/stream-attach signals as independently-arriving,
  // overlapping async calls; without this, two handlers can each snapshot
  // the same record and the one whose `store.save` settles last silently
  // clobbers the other's update (lost update), and two concurrent
  // initiateCall calls can both observe capacity/daily-cap as available
  // before either claims it (TOCTOU). The private `*Core`/internal methods
  // below must never call `lock` themselves — they already run inside a
  // locked turn, and re-entering would deadlock against their own caller.
  private queue: Promise<unknown> = Promise.resolve();

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
    return this.lock(() => this.initiateCallCore(params));
  }

  async handleProviderEvent(evt: ProviderCallEvent): Promise<void> {
    return this.lock(() => this.handleProviderEventCore(evt));
  }

  async endCall(id: string, reason: string): Promise<void> {
    return this.lock(() => this.endCallCore(id, reason));
  }

  async finalize(id: string, status: CallStatus, error?: string): Promise<void> {
    return this.lock(() => this.finalizeInternal(id, status, { error }));
  }

  async markStreaming(id: string): Promise<void> {
    return this.lock(() => this.markStreamingCore(id));
  }

  getActive(): CallRecord | undefined {
    return this.active;
  }

  getByStreamToken(token: string): CallRecord | undefined {
    return this.active?.streamToken === token ? this.active : undefined;
  }

  private lock<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.queue.then(fn, fn);
    this.queue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  private async initiateCallCore(params: CallParams): Promise<CallRecord> {
    // This MVP tracks exactly one active call in memory (see `active`
    // field), so it can only ever honor a maxConcurrentCalls of 1 — the
    // configured default. A slot is occupied whenever `active` is set,
    // independent of the configured value. Serialization via `lock` means
    // this check and the claim below can no longer race with another
    // initiateCall.
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
      await this.finalizeInternal(pending.id, "failed", { error: message });
      throw err;
    }
  }

  private async handleProviderEventCore(evt: ProviderCallEvent): Promise<void> {
    const rec = await this.getRecordByProviderCallId(evt.providerCallId);
    if (!rec) {
      this.warnIgnored(evt.type, evt.providerCallId, "no matching call record");
      return;
    }

    switch (evt.type) {
      case "amd":
        await this.handleAmdEventCore(rec, evt.result);
        return;
      case "completed":
        await this.handleCompletedEventCore(rec, evt.providerStatus);
        return;
      case "initiated":
        // "dialing" is already set synchronously by initiateCall before any
        // provider event can arrive; this event only confirms what we
        // already know, so it's always a silent no-op.
        return;
      case "ringing":
      case "answered":
        await this.handleProgressEventCore(rec, evt.type);
        return;
    }
  }

  private async endCallCore(id: string, reason: string): Promise<void> {
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

    // Non-error termination — the reason lives in `endReason`, not `error`
    // (that field is reserved for genuine failures).
    await this.finalizeInternal(id, "completed", { endReason: reason });
  }

  // Shared core for the public `finalize` and every internal caller that
  // needs to terminate a record (initiateCall's createCall failure,
  // endCall, a "completed" provider event). `error` is for genuine
  // failures; `endReason` is for benign/expected terminations.
  private async finalizeInternal(
    id: string,
    status: CallStatus,
    extra: { error?: string; endReason?: string } = {}
  ): Promise<void> {
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
      ...(extra.error !== undefined ? { error: extra.error } : {}),
      ...(extra.endReason !== undefined ? { endReason: extra.endReason } : {})
    };
    await this.persist(updated);
    this.emit("status", updated);
    this.emit("ended", updated);
  }

  private async markStreamingCore(id: string): Promise<void> {
    const rec = await this.getRecord(id);
    if (!rec) {
      console.warn(`[CallManager] markStreaming: no record found for id ${id}`);
      return;
    }
    if (TERMINAL_STATUSES.has(rec.status)) {
      this.warnIgnored("markStreaming", rec.providerCallId ?? id, `call ${id} already terminal (${rec.status})`);
      return;
    }
    if (rec.status === "in-progress") {
      return; // already streaming — idempotent no-op
    }

    // Legal from any non-terminal state: the media stream can attach
    // (Twilio <Connect><Stream>) before the provider's own "answered"
    // status callback lands, so this can't require rec.status === "answered".
    const updated: CallRecord = { ...rec, status: "in-progress" };
    if (!updated.answeredAt) {
      updated.answeredAt = new Date(this.now()).toISOString();
    }

    await this.persist(updated);
    this.emit("status", updated);
    this.armDurationTimer(updated);
  }

  private async handleAmdEventCore(rec: CallRecord, result: "human" | "machine"): Promise<void> {
    if (TERMINAL_STATUSES.has(rec.status)) {
      this.warnIgnored("amd", rec.providerCallId ?? rec.id, `call ${rec.id} already terminal (${rec.status})`);
      return;
    }
    const updated: CallRecord = { ...rec, amdResult: result };
    await this.persist(updated);
    this.emit("amd", updated, result);
  }

  private async handleCompletedEventCore(rec: CallRecord, providerStatus: string): Promise<void> {
    if (TERMINAL_STATUSES.has(rec.status)) {
      this.warnIgnored("completed", rec.providerCallId ?? rec.id, `call ${rec.id} already terminal (${rec.status})`);
      return;
    }
    const mapped = COMPLETED_STATUS_MAP[providerStatus];
    if (!mapped) {
      // An unrecognized providerStatus used to be silently ignored, leaving
      // the record wedged non-terminal forever (and, while it was `active`,
      // permanently occupying the single call slot with no timer to ever
      // un-wedge it). Finalizing as "failed" guarantees forward progress.
      console.warn(
        `[CallManager] unrecognized providerStatus "${providerStatus}" for call ${rec.id} (${rec.providerCallId ?? "no providerCallId"}) — finalizing as failed`
      );
      await this.finalizeInternal(rec.id, "failed", { error: `unrecognized providerStatus "${providerStatus}"` });
      return;
    }
    await this.finalizeInternal(rec.id, mapped);
  }

  private async handleProgressEventCore(rec: CallRecord, type: "ringing" | "answered"): Promise<void> {
    if (TERMINAL_STATUSES.has(rec.status)) {
      this.warnIgnored(type, rec.providerCallId ?? rec.id, `call ${rec.id} already terminal (${rec.status})`);
      return;
    }

    if (type === "answered" && rec.status === "in-progress") {
      // markStreaming can promote a call straight to in-progress before the
      // provider's own "answered" status callback lands — expected
      // real-world ordering, not an error. Silent (no warn).
      return;
    }

    const currentIdx = CHAIN_ORDER.indexOf(rec.status);
    const targetIdx = CHAIN_ORDER.indexOf(type);
    // Strictly forward only: rejects backward moves AND repeats (e.g. a
    // duplicate "answered" webhook), which would otherwise re-stamp
    // answeredAt / re-emit "answered" / re-arm the duration timer.
    if (currentIdx === -1 || targetIdx <= currentIdx) {
      this.warnIgnored(type, rec.providerCallId ?? rec.id, `out of order for call ${rec.id} (status ${rec.status})`);
      return;
    }

    const updated: CallRecord = { ...rec, status: type };
    if (type === "answered") {
      updated.answeredAt = new Date(this.now()).toISOString();
    }

    await this.persist(updated);
    this.emit("status", updated);
    if (type === "answered") {
      this.emit("answered", updated);
      this.armDurationTimer(updated);
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

  // Idempotent and call-bound: a duplicate/late signal for the call that
  // already armed the timer is a no-op, and a signal for any call other
  // than the currently-active one (e.g. a stale non-terminal record left
  // over from a previous process) can never arm or disarm the active
  // call's timer.
  private armDurationTimer(rec: CallRecord): void {
    if (rec.id !== this.active?.id) return;
    if (this.durationTimer?.callId === rec.id) return;

    const maxDurationSec = rec.params.maxDurationSec ?? this.limits.maxDurationSec;
    const handle = setTimeout(() => {
      void this.endCall(rec.id, "duration-cap");
    }, maxDurationSec * 1000);
    handle.unref();
    this.durationTimer = { callId: rec.id, handle };
  }

  private clearDurationTimer(): void {
    if (this.durationTimer) {
      clearTimeout(this.durationTimer.handle);
      this.durationTimer = undefined;
    }
  }

  private warnIgnored(eventType: string, providerCallIdOrId: string, reason: string): void {
    console.warn(`[CallManager] ignoring "${eventType}" event (${providerCallIdOrId}): ${reason}`);
  }
}
