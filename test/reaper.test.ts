import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CallStore } from "../src/store.js";
import { createReaper } from "../src/reaper.js";
import type { Reaper } from "../src/reaper.js";
import type { TelephonyProvider } from "../src/manager.js";
import type { CallRecord, CallParams } from "../src/types.js";

// Finding 2: the spec-promised stale-call reaper / restart-reconciliation
// sweep. Covers both the one-shot startup sweep (reconciles every
// non-terminal record unconditionally) and the periodic sweep (only touches
// records with no active session in this process, older than
// maxDurationSec + 120s grace — the "phantom guard" that must never disturb
// a genuinely live call).

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "pi-voice-reaper-"));
}

function makeParams(): CallParams {
  return { to: "+15551234567", objective: "confirm appointment", talkingPoints: [], callerIdentity: "pi" };
}

function makeRecord(overrides: Partial<CallRecord> = {}): CallRecord {
  return {
    id: overrides.id ?? "rec-1",
    providerCallId: "CA-STALE",
    params: makeParams(),
    status: "in-progress",
    streamToken: "token-1",
    createdAt: new Date().toISOString(),
    ...overrides
  };
}

/** Fake provider whose getCall() response (or failure) is configured per providerCallId. */
class FakeProvider implements TelephonyProvider {
  private readonly statuses = new Map<string, string>();
  private readonly failures = new Map<string, Error>();
  readonly getCallIds: string[] = [];

  setStatus(providerCallId: string, status: string): void {
    this.statuses.set(providerCallId, status);
  }

  setFailure(providerCallId: string, err: Error): void {
    this.failures.set(providerCallId, err);
  }

  async createCall(): ReturnType<TelephonyProvider["createCall"]> {
    throw new Error("not used in reaper tests");
  }

  async hangupCall(): Promise<void> {
    throw new Error("not used in reaper tests");
  }

  async getCall(providerCallId: string): Promise<{ status: string }> {
    this.getCallIds.push(providerCallId);
    const failure = this.failures.get(providerCallId);
    if (failure) throw failure;
    const status = this.statuses.get(providerCallId);
    return { status: status ?? "in-progress" };
  }
}

const MAX_DURATION_SEC = 900;

let activeReaper: Reaper | undefined;

afterEach(() => {
  activeReaper?.stop();
  activeReaper = undefined;
  vi.useRealTimers();
});

function makeReaper(opts: {
  store: CallStore;
  provider: TelephonyProvider;
  hasActiveSession?: (id: string) => boolean;
  now?: () => number;
}): Reaper {
  const reaper = createReaper({
    store: opts.store,
    provider: opts.provider,
    maxDurationSec: MAX_DURATION_SEC,
    hasActiveSession: opts.hasActiveSession ?? (() => false),
    now: opts.now
  });
  activeReaper = reaper;
  return reaper;
}

describe("createReaper", () => {
  describe("sweepOnStartup", () => {
    it("finalizes a stale in-progress record as the provider's current terminal status", async () => {
      const store = new CallStore(tempDir());
      await store.save(makeRecord({ id: "rec-1", providerCallId: "CA-STALE", status: "in-progress" }));
      const provider = new FakeProvider();
      provider.setStatus("CA-STALE", "completed");

      const reaper = makeReaper({ store, provider });
      await reaper.sweepOnStartup();

      const saved = await store.get("rec-1");
      expect(saved?.status).toBe("completed");
      expect(saved?.endedAt).toBeTruthy();
    });

    it("finalizes a record with no providerCallId as failed", async () => {
      const store = new CallStore(tempDir());
      const rec = makeRecord({ id: "rec-2", status: "queued" });
      delete rec.providerCallId;
      await store.save(rec);
      const provider = new FakeProvider();

      const reaper = makeReaper({ store, provider });
      await reaper.sweepOnStartup();

      const saved = await store.get("rec-2");
      expect(saved?.status).toBe("failed");
      expect(saved?.endedAt).toBeTruthy();
      expect(provider.getCallIds).toEqual([]); // never called getCall — nothing to look up
    });

    it('maps a live provider status (in-progress/ringing) with no session in this process to "interrupted"', async () => {
      const store = new CallStore(tempDir());
      await store.save(makeRecord({ id: "rec-3", providerCallId: "CA-LIVE", status: "answered" }));
      const provider = new FakeProvider();
      provider.setStatus("CA-LIVE", "ringing");

      const reaper = makeReaper({ store, provider });
      await reaper.sweepOnStartup();

      const saved = await store.get("rec-3");
      expect(saved?.status).toBe("interrupted");
      expect(saved?.error).toBeTruthy();
    });

    it('maps an unrecognized provider status to "interrupted" with the error noted', async () => {
      const store = new CallStore(tempDir());
      await store.save(makeRecord({ id: "rec-4", providerCallId: "CA-WEIRD", status: "ringing" }));
      const provider = new FakeProvider();
      provider.setStatus("CA-WEIRD", "some-bogus-status");

      const reaper = makeReaper({ store, provider });
      await reaper.sweepOnStartup();

      const saved = await store.get("rec-4");
      expect(saved?.status).toBe("interrupted");
      expect(saved?.error).toContain("some-bogus-status");
    });

    it('maps a provider.getCall() failure to "interrupted" with the error noted, never throwing', async () => {
      const store = new CallStore(tempDir());
      await store.save(makeRecord({ id: "rec-5", providerCallId: "CA-ERR", status: "answered" }));
      const provider = new FakeProvider();
      provider.setFailure("CA-ERR", new Error("network unreachable"));

      const reaper = makeReaper({ store, provider });
      await expect(reaper.sweepOnStartup()).resolves.toBeUndefined();

      const saved = await store.get("rec-5");
      expect(saved?.status).toBe("interrupted");
      expect(saved?.error).toContain("network unreachable");
    });

    it("never lets one bad record stop the sweep from reconciling the rest", async () => {
      const store = new CallStore(tempDir());
      await store.save(makeRecord({ id: "rec-a", providerCallId: "CA-BAD", status: "answered" }));
      await store.save(makeRecord({ id: "rec-b", providerCallId: "CA-GOOD", status: "answered" }));
      const provider = new FakeProvider();
      provider.setFailure("CA-BAD", new Error("boom"));
      provider.setStatus("CA-GOOD", "completed");

      const reaper = makeReaper({ store, provider });
      await expect(reaper.sweepOnStartup()).resolves.toBeUndefined();

      expect((await store.get("rec-a"))?.status).toBe("interrupted");
      expect((await store.get("rec-b"))?.status).toBe("completed");
    });

    it("leaves an already-terminal record untouched and never calls the provider for it", async () => {
      const store = new CallStore(tempDir());
      await store.save(makeRecord({ id: "rec-6", providerCallId: "CA-DONE", status: "completed", endedAt: new Date().toISOString() }));
      const provider = new FakeProvider();

      const reaper = makeReaper({ store, provider });
      await reaper.sweepOnStartup();

      expect(provider.getCallIds).toEqual([]);
    });

    it("does not gate on age — even a just-created non-terminal record is reconciled immediately at startup", async () => {
      const store = new CallStore(tempDir());
      await store.save(
        makeRecord({ id: "rec-7", providerCallId: "CA-FRESH", status: "dialing", createdAt: new Date().toISOString() })
      );
      const provider = new FakeProvider();
      provider.setStatus("CA-FRESH", "no-answer");

      const reaper = makeReaper({ store, provider });
      await reaper.sweepOnStartup();

      expect((await store.get("rec-7"))?.status).toBe("no-answer");
    });
  });

  describe("periodic sweep", () => {
    it("never touches a record with an active session in this process (phantom guard)", async () => {
      vi.useFakeTimers();
      const store = new CallStore(tempDir());
      const oldCreatedAt = new Date(Date.now() - (MAX_DURATION_SEC + 200) * 1000).toISOString();
      await store.save(makeRecord({ id: "rec-live", providerCallId: "CA-LIVE", status: "in-progress", createdAt: oldCreatedAt }));
      const provider = new FakeProvider();
      provider.setStatus("CA-LIVE", "completed"); // even if the provider says it's over...

      const reaper = makeReaper({ store, provider, hasActiveSession: (id) => id === "rec-live" });
      reaper.start();
      await vi.advanceTimersByTimeAsync(60_000);

      // ...the record must be untouched: still in-progress, provider never even queried.
      expect((await store.get("rec-live"))?.status).toBe("in-progress");
      expect(provider.getCallIds).toEqual([]);
    });

    it("skips a stale record still within the maxDurationSec + 120s grace window", async () => {
      vi.useFakeTimers();
      const store = new CallStore(tempDir());
      const recentCreatedAt = new Date(Date.now() - 30_000).toISOString(); // well within grace
      await store.save(makeRecord({ id: "rec-young", providerCallId: "CA-YOUNG", status: "in-progress", createdAt: recentCreatedAt }));
      const provider = new FakeProvider();
      provider.setStatus("CA-YOUNG", "completed");

      const reaper = makeReaper({ store, provider });
      reaper.start();
      await vi.advanceTimersByTimeAsync(60_000);

      expect((await store.get("rec-young"))?.status).toBe("in-progress");
      expect(provider.getCallIds).toEqual([]);
    });

    it("reconciles a stale record with no active session once past the grace window", async () => {
      vi.useFakeTimers();
      const store = new CallStore(tempDir());
      const oldCreatedAt = new Date(Date.now() - (MAX_DURATION_SEC + 200) * 1000).toISOString();
      await store.save(makeRecord({ id: "rec-stale", providerCallId: "CA-STALE2", status: "in-progress", createdAt: oldCreatedAt }));
      const provider = new FakeProvider();
      provider.setStatus("CA-STALE2", "busy");

      const reaper = makeReaper({ store, provider });
      reaper.start();
      await vi.advanceTimersByTimeAsync(60_000);
      // The interval callback kicks off real fs I/O (via CallStore) that
      // fake timers don't control; hop to real timers briefly so it can
      // settle (same idiom as manager.test.ts's duration-timer tests).
      vi.useRealTimers();
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect((await store.get("rec-stale"))?.status).toBe("busy");
    });

    it("stop() prevents any further sweeps", async () => {
      vi.useFakeTimers();
      const store = new CallStore(tempDir());
      const oldCreatedAt = new Date(Date.now() - (MAX_DURATION_SEC + 200) * 1000).toISOString();
      await store.save(makeRecord({ id: "rec-stopped", providerCallId: "CA-STOP", status: "in-progress", createdAt: oldCreatedAt }));
      const provider = new FakeProvider();
      provider.setStatus("CA-STOP", "busy");

      const reaper = makeReaper({ store, provider });
      reaper.start();
      reaper.stop();
      await vi.advanceTimersByTimeAsync(120_000);

      expect((await store.get("rec-stopped"))?.status).toBe("in-progress");
    });
  });
});
