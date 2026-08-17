import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CallStore } from "../src/store.js";
import { CallManager, CapacityError, DailyCapError } from "../src/manager.js";
import type { TelephonyProvider } from "../src/manager.js";
import type { CallParams, CallRecord } from "../src/types.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "pi-voice-manager-"));
}

class FakeProvider implements TelephonyProvider {
  public readonly hangupCalls: string[] = [];
  public createCallResult: { providerCallId: string } | Error = { providerCallId: "CA1" };

  async createCall(): ReturnType<TelephonyProvider["createCall"]> {
    if (this.createCallResult instanceof Error) throw this.createCallResult;
    return this.createCallResult;
  }

  async hangupCall(providerCallId: string): Promise<void> {
    this.hangupCalls.push(providerCallId);
  }

  async getCall(): Promise<{ status: string }> {
    return { status: "in-progress" };
  }
}

const LIMITS = { maxDurationSec: 900, maxConcurrentCalls: 1, dailyCallCap: 20 };
const URLS = {
  answerUrl: "https://example.com/voice/webhook?kind=answer",
  statusCallbackUrl: "https://example.com/voice/webhook?kind=status",
  amdCallbackUrl: "https://example.com/voice/webhook?kind=amd"
};

function makeParams(overrides: Partial<CallParams> = {}): CallParams {
  return {
    to: "+15551234567",
    objective: "confirm appointment",
    talkingPoints: ["confirm time"],
    callerIdentity: "pi",
    ...overrides
  };
}

function makeManager(opts: { provider?: FakeProvider; store?: CallStore; now?: () => number } = {}): {
  manager: CallManager;
  provider: FakeProvider;
  store: CallStore;
} {
  const provider = opts.provider ?? new FakeProvider();
  const store = opts.store ?? new CallStore(tempDir());
  const manager = new CallManager({
    store,
    provider,
    limits: LIMITS,
    urls: URLS,
    fromNumber: "+15559998888",
    now: opts.now
  });
  return { manager, provider, store };
}

async function seedTodayRecords(store: CallStore, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    const rec: CallRecord = {
      id: `seed-${i}`,
      params: makeParams(),
      status: "completed",
      streamToken: `token-${i}`,
      createdAt: new Date().toISOString(),
      endedAt: new Date().toISOString()
    };
    await store.save(rec);
  }
}

describe("CallManager", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("(a) initiate persists a dialing record with streamToken and returns it", async () => {
    const { manager, store } = makeManager();

    const rec = await manager.initiateCall(makeParams());

    expect(rec.status).toBe("dialing");
    expect(rec.providerCallId).toBe("CA1");
    expect(rec.streamToken).toBeTruthy();

    const saved = await store.get(rec.id);
    expect(saved).toEqual(rec);
  });

  it("(b) second initiate while one active throws CapacityError", async () => {
    const { manager } = makeManager();
    await manager.initiateCall(makeParams());

    await expect(manager.initiateCall(makeParams())).rejects.toThrow(CapacityError);
  });

  it("(c) initiate throws DailyCapError once countCreatedToday reaches the cap", async () => {
    const store = new CallStore(tempDir());
    await seedTodayRecords(store, 20);
    const { manager } = makeManager({ store });

    await expect(manager.initiateCall(makeParams())).rejects.toThrow(DailyCapError);
  });

  it("(d) initiated->ringing->answered->completed lands completed with answeredAt/endedAt set and emits ended", async () => {
    const { manager } = makeManager();
    const rec = await manager.initiateCall(makeParams());
    const ended = vi.fn();
    manager.on("ended", ended);

    await manager.handleProviderEvent({ type: "initiated", providerCallId: "CA1" });
    await manager.handleProviderEvent({ type: "ringing", providerCallId: "CA1" });
    await manager.handleProviderEvent({ type: "answered", providerCallId: "CA1" });
    await manager.handleProviderEvent({ type: "completed", providerCallId: "CA1", providerStatus: "completed" });

    expect(ended).toHaveBeenCalledTimes(1);
    const final = ended.mock.calls[0]?.[0] as CallRecord;
    expect(final.id).toBe(rec.id);
    expect(final.status).toBe("completed");
    expect(final.answeredAt).toBeTruthy();
    expect(final.endedAt).toBeTruthy();
  });

  it("(e) completed with providerStatus no-answer from ringing -> status no-answer", async () => {
    const { manager, store } = makeManager();
    const initial = await manager.initiateCall(makeParams());

    await manager.handleProviderEvent({ type: "ringing", providerCallId: "CA1" });
    await manager.handleProviderEvent({ type: "completed", providerCallId: "CA1", providerStatus: "no-answer" });

    const saved = await store.get(initial.id);
    expect(saved?.status).toBe("no-answer");
    expect(manager.getActive()).toBeUndefined();
  });

  it("(f) after answered, advancing fake time past maxDurationSec calls provider hangupCall and finalizes", async () => {
    const { manager, provider, store } = makeManager();
    const rec = await manager.initiateCall(makeParams());

    await manager.handleProviderEvent({ type: "answered", providerCallId: "CA1" });
    expect(provider.hangupCalls).toEqual([]);

    await vi.advanceTimersByTimeAsync(LIMITS.maxDurationSec * 1000 + 1000);
    // The timer callback kicks off real fs I/O (via CallStore) that fake
    // timers don't control; hop to real timers briefly so it can settle.
    vi.useRealTimers();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(provider.hangupCalls).toEqual(["CA1"]);
    const saved = await store.get(rec.id);
    expect(saved?.status).toBe("completed");
    expect(saved?.error).toBe("duration-cap");
  });

  it("(g) getByStreamToken returns the active record and undefined after terminal", async () => {
    const { manager } = makeManager();
    const rec = await manager.initiateCall(makeParams());

    expect(manager.getByStreamToken(rec.streamToken)).toEqual(rec);

    await manager.handleProviderEvent({ type: "completed", providerCallId: "CA1", providerStatus: "failed" });

    expect(manager.getByStreamToken(rec.streamToken)).toBeUndefined();
  });

  it("(h) a createCall failure finalizes the record as failed instead of wedging capacity", async () => {
    const provider = new FakeProvider();
    provider.createCallResult = new Error("network down");
    const { manager, store } = makeManager({ provider });

    await expect(manager.initiateCall(makeParams())).rejects.toThrow("network down");

    expect(manager.getActive()).toBeUndefined();
    const list = await store.list();
    expect(list).toHaveLength(1);
    expect(list[0]?.status).toBe("failed");
    expect(list[0]?.error).toBe("network down");

    // Capacity is released — a follow-up call can proceed.
    provider.createCallResult = { providerCallId: "CA2" };
    const rec = await manager.initiateCall(makeParams());
    expect(rec.status).toBe("dialing");
  });

  it("markStreaming transitions an answered call to in-progress", async () => {
    const { manager, store } = makeManager();
    const rec = await manager.initiateCall(makeParams());
    await manager.handleProviderEvent({ type: "answered", providerCallId: "CA1" });

    await manager.markStreaming(rec.id);

    expect(manager.getActive()?.status).toBe("in-progress");
    const saved = await store.get(rec.id);
    expect(saved?.status).toBe("in-progress");
  });

  it("markStreaming is ignored with a warn log (no throw) for a call not yet answered", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { manager } = makeManager();
    const rec = await manager.initiateCall(makeParams());

    await expect(manager.markStreaming(rec.id)).resolves.toBeUndefined();
    expect(manager.getActive()?.status).toBe("dialing");
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("handleProviderEvent for an unknown providerCallId is ignored with a warn log, not thrown", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { manager } = makeManager();
    await manager.initiateCall(makeParams());

    await expect(
      manager.handleProviderEvent({ type: "ringing", providerCallId: "does-not-exist" })
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("endCall hangs up the provider and finalizes as completed with the given reason", async () => {
    const { manager, provider, store } = makeManager();
    const rec = await manager.initiateCall(makeParams());
    await manager.handleProviderEvent({ type: "answered", providerCallId: "CA1" });

    await manager.endCall(rec.id, "operator");

    expect(provider.hangupCalls).toEqual(["CA1"]);
    const saved = await store.get(rec.id);
    expect(saved?.status).toBe("completed");
    expect(saved?.error).toBe("operator");
    expect(manager.getActive()).toBeUndefined();
  });

  it("emits amd event with the record and result", async () => {
    const { manager } = makeManager();
    await manager.initiateCall(makeParams());
    const amdHandler = vi.fn();
    manager.on("amd", amdHandler);

    await manager.handleProviderEvent({ type: "amd", providerCallId: "CA1", result: "machine" });

    expect(amdHandler).toHaveBeenCalledTimes(1);
    const [rec, result] = amdHandler.mock.calls[0] as [CallRecord, string];
    expect(rec.amdResult).toBe("machine");
    expect(result).toBe("machine");
  });
});
