import type { CallStore } from "./store.js";
import type { TelephonyProvider } from "./manager.js";
import type { CallRecord, CallStatus } from "./types.js";
import { TERMINAL_STATUSES } from "./types.js";

/**
 * The spec-promised stale-call reaper / restart-reconciliation sweep.
 *
 * This process's in-memory `CallManager.active` is reset on every restart —
 * a call left non-terminal on disk when the process last exited (a crash, a
 * kill -9, a shutdown-drain that itself timed out before its own
 * force-terminal write, etc.) would otherwise sit there forever: nothing
 * ever asks the provider what actually happened to it, and (for a
 * pre-answer terminal callback with no duration timer armed yet) nothing
 * ever un-wedges the single call slot for a genuinely stuck record.
 *
 * Two sweeps, both built on the same per-record reconciliation:
 *  - `sweepOnStartup()`: once, at boot, over EVERY non-terminal record —
 *    a fresh process has no live session for anything yet, so there's no
 *    age gate to apply.
 *  - the periodic sweep armed by `start()`: every 60s, but ONLY for
 *    records with no active session in this process whose `createdAt` is
 *    older than `maxDurationSec + 120s` — the "phantom guard". A call that
 *    is still legitimately within its own allowed duration (plus grace)
 *    must never be touched, even if this same process also happens to be
 *    the one running it.
 *
 * Reconciliation writes go straight through `store.save()`, never through
 * `CallManager` — the manager's single in-memory `active` slot has no
 * concept of a call phantom-left-behind by a previous process instance.
 *
 * Every record is reconciled independently and defensively: one record
 * throwing (a corrupt read, a provider error) must never stop the sweep
 * from reconciling the rest, and must never let a rejection escape to the
 * caller. No secret (API keys, tokens) ever appears in the warn logs this
 * emits — only call/record ids and provider status strings, which already
 * live unredacted in every persisted CallRecord.
 */

const PERIODIC_SWEEP_MS = 60_000;
const PHANTOM_GRACE_SEC = 120;

// Twilio's terminal CallStatus values, mirroring manager.ts's
// COMPLETED_STATUS_MAP (kept local/duplicated rather than imported: that
// map is private to CallManager's webhook-driven event path, and importing
// it here would wrongly imply the reaper flows events through the manager,
// which it deliberately does not — see the class doc comment above).
const PROVIDER_TERMINAL_STATUS_MAP: Readonly<Record<string, CallStatus>> = {
  completed: "completed",
  busy: "busy",
  "no-answer": "no-answer",
  failed: "failed",
  canceled: "canceled"
};

// Twilio's live (non-terminal) CallStatus values — a record with one of
// these AND no active session in this process outlived this process's
// knowledge of it; there's no way left to observe how it actually ended.
const LIVE_PROVIDER_STATUSES: ReadonlySet<string> = new Set(["in-progress", "ringing"]);

export interface ReaperDeps {
  store: CallStore;
  provider: TelephonyProvider;
  maxDurationSec: number;
  /** True if THIS process currently has a live session/active record for this call id — the reaper must never touch it. */
  hasActiveSession: (id: string) => boolean;
  now?: () => number;
}

export interface Reaper {
  /** Reconciles every non-terminal record, unconditionally. Never throws. */
  sweepOnStartup(): Promise<void>;
  /** Arms the periodic (60s, unref'd) sweep. Idempotent — a second call while already running is a no-op. */
  start(): void;
  /** Disarms the periodic sweep, if armed. Idempotent. */
  stop(): void;
}

export function createReaper(deps: ReaperDeps): Reaper {
  const now = deps.now ?? Date.now;
  let timer: NodeJS.Timeout | undefined;

  async function finalize(rec: CallRecord, status: CallStatus, error: string | undefined): Promise<void> {
    const updated: CallRecord = {
      ...rec,
      status,
      endedAt: new Date(now()).toISOString(),
      ...(error !== undefined ? { error } : {})
    };
    await deps.store.save(updated);
  }

  async function reconcileRecord(rec: CallRecord): Promise<void> {
    try {
      if (!rec.providerCallId) {
        await finalize(rec, "failed", "reaper: no providerCallId — call was never created with the telephony provider");
        return;
      }

      let providerStatus: string;
      try {
        const result = await deps.provider.getCall(rec.providerCallId);
        providerStatus = result.status;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await finalize(rec, "interrupted", `reaper: provider.getCall(${rec.providerCallId}) failed: ${message}`);
        return;
      }

      const mapped = PROVIDER_TERMINAL_STATUS_MAP[providerStatus];
      if (mapped) {
        await finalize(rec, mapped, undefined);
        return;
      }

      if (LIVE_PROVIDER_STATUSES.has(providerStatus)) {
        await finalize(
          rec,
          "interrupted",
          `reaper: call was still "${providerStatus}" at the provider with no live session in this process`
        );
        return;
      }

      await finalize(rec, "interrupted", `reaper: unrecognized provider status "${providerStatus}"`);
    } catch (err) {
      // Defensive backstop: finalize()/store.save() itself failing (e.g. a
      // transient disk error) must not take the whole sweep down.
      console.warn(`[reaper] failed to reconcile call ${rec.id}:`, err instanceof Error ? err.message : err);
    }
  }

  async function sweep(opts: { phantomGuard: boolean }): Promise<void> {
    let records: CallRecord[];
    try {
      records = await deps.store.list();
    } catch (err) {
      console.warn("[reaper] store.list() failed:", err instanceof Error ? err.message : err);
      return;
    }

    const nowMs = now();
    const graceSec = deps.maxDurationSec + PHANTOM_GRACE_SEC;

    for (const rec of records) {
      if (TERMINAL_STATUSES.has(rec.status)) continue;
      // Never touch a call this process is actively running — checked
      // before the age gate so it applies to both sweeps identically (at
      // true startup this is always false for every record anyway, since
      // nothing has been initiated yet in this process's lifetime).
      if (deps.hasActiveSession(rec.id)) continue;

      if (opts.phantomGuard) {
        const createdAtMs = Date.parse(rec.createdAt);
        const ageSec = (nowMs - createdAtMs) / 1000;
        if (!(ageSec > graceSec)) continue;
      }

      await reconcileRecord(rec);
    }
  }

  return {
    async sweepOnStartup() {
      await sweep({ phantomGuard: false });
    },
    start() {
      if (timer) return;
      timer = setInterval(() => {
        sweep({ phantomGuard: true }).catch((err: unknown) => {
          console.warn("[reaper] periodic sweep failed:", err instanceof Error ? err.message : err);
        });
      }, PERIODIC_SWEEP_MS);
      timer.unref();
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
    }
  };
}
