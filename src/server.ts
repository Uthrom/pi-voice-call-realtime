import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { URL, pathToFileURL } from "node:url";
import { WebSocketServer } from "ws";
import type { Config } from "./config.js";
import { loadConfig } from "./config.js";
import { CallStore } from "./store.js";
import { CallManager } from "./manager.js";
import type { TelephonyProvider } from "./manager.js";
import { TwilioProvider } from "./providers/twilio.js";
import { ReplayCache, publicUrlFor } from "./webhook-security.js";
import { createPublicHandler } from "./webhook.js";
import { createControlHandler } from "./control-api.js";
import { MediaStreamConnection } from "./media-stream.js";
import { RealtimeSession } from "./realtime.js";
import { ManagedRealtimeSession } from "./managed-realtime.js";
import { summarizeCall } from "./summary.js";
import { CallSession } from "./call-session.js";
import type { CallRecord } from "./types.js";
import { TERMINAL_STATUSES } from "./types.js";
import { resolvePublicUrl } from "./tunnel.js";
import type { Tunnel } from "./tunnel.js";
import { createReaper } from "./reaper.js";

const STREAM_PATH = "/voice/stream";

// How long drainActiveSession() (see startServer's returned handle) waits
// for an in-flight call to finish gracefully before giving up and
// force-finalizing it as "interrupted" — see that function's own doc
// comment for the full reconciliation between the brief's one-line
// "finalize any active call as interrupted" and the controller's binding
// note that a call which *did* finish draining in time keeps its normal
// endCall("shutdown") outcome instead.
const DRAIN_TIMEOUT_MS = 10_000;

/**
 * The daemon's startup banner. Deliberately prints only what's needed to
 * operate/debug the daemon (public URL, both ports, the from-number) —
 * never the control token, Twilio auth token, or OpenAI API key.
 */
export function formatBanner(cfg: Config, publicUrl: string): string {
  return [
    "pi-voice-call-realtime is running",
    `  public URL:   ${publicUrl}`,
    `  public port:  ${cfg.serve.publicPort}`,
    `  control port: ${cfg.serve.controlPort} (127.0.0.1 only)`,
    `  from number:  ${cfg.twilio.fromNumber}`
  ].join("\n");
}

/**
 * Builds the SIGINT/SIGTERM handler for main() below. Extracted as a plain
 * function of its inputs (rather than wired directly against `process.on`)
 * so it can be exercised directly in tests — sending real signals into the
 * test-runner process itself is exactly what the brief says to avoid.
 *
 * Idempotent (a second call while the first is still in flight, or after it
 * finished, is a no-op) and never throws: every step is individually
 * try/caught so a failure partway through (e.g. drainActiveSession itself
 * rejecting) still runs the rest of the sequence and still exits, rather
 * than leaving the process hung mid-shutdown with no listeners left to
 * receive a second signal.
 */
export function createShutdownHandler(opts: {
  handle: Pick<Awaited<ReturnType<typeof startServer>>, "drainActiveSession" | "close" | "closeControl">;
  tunnel?: Tunnel;
  exit?: (code: number) => void;
}): (signal: string) => Promise<void> {
  let shuttingDown = false;
  const exit = opts.exit ?? ((code: number) => process.exit(code));

  return async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;

    console.log(`[pi-voice] received ${signal}, shutting down...`);

    try {
      // Stop accepting new work FIRST, before anything else. Without this,
      // a POST /calls landing during the drain below could place a brand
      // new real outbound call whose servers are then closed out from
      // under it moments later. GET /health dying early on the control
      // listener is an acceptable, deliberate side effect.
      await opts.handle.closeControl();
    } catch (err) {
      console.warn("[pi-voice] closeControl() failed during shutdown:", err instanceof Error ? err.message : err);
    }

    try {
      // Give an in-flight call its own bounded chance to finish through its
      // normal path (see drainActiveSession's doc comment) before anything
      // is torn down under it. The public listener (webhooks + the media
      // stream) and the tunnel must both stay up through this — Twilio
      // still needs to reach them for whatever call is in flight — so
      // neither is closed until after this resolves.
      await opts.handle.drainActiveSession();
    } catch (err) {
      console.warn("[pi-voice] drainActiveSession failed during shutdown:", err instanceof Error ? err.message : err);
    }

    try {
      await opts.handle.close();
    } catch (err) {
      console.warn("[pi-voice] close() failed during shutdown:", err instanceof Error ? err.message : err);
    }

    if (opts.tunnel) {
      try {
        await opts.tunnel.close();
      } catch (err) {
        console.warn("[pi-voice] tunnel close() failed during shutdown:", err instanceof Error ? err.message : err);
      }
    }

    exit(0);
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}

// The injectable set of collaborators startServer wires together. Task 12
// extends this with the audio-path composition root's own dependencies:
// `realtimeFactory` (how a call's RealtimeSession/ManagedRealtimeSession is
// constructed — overridden in tests to point at a fake realtime server via
// urlOverride) and `summarize` (call-end summarization).
export interface Deps {
  store: CallStore;
  provider: TelephonyProvider;
  replay: ReplayCache;
  publicUrl: () => string;
  realtimeFactory: (opts: ConstructorParameters<typeof RealtimeSession>[0]) => ManagedRealtimeSession | RealtimeSession;
  summarize: typeof summarizeCall;
  // Task 14: how long drainActiveSession() (see the returned handle) waits
  // for a graceful in-flight call to finish before force-finalizing it as
  // "interrupted" and giving up. Defaults to 10s in production; tests
  // inject a much shorter value to exercise the timeout path without a
  // real multi-second wait — mirrors the existing realtimeFactory
  // connectTimeoutMs/idleTimeoutMs pattern.
  drainTimeoutMs: number;
}

export async function startServer(
  cfg: Config,
  overrides?: Partial<Deps>
): Promise<{
  close(): Promise<void>;
  closeControl(): Promise<void>;
  drainActiveSession(): Promise<void>;
  publicServer: Server;
  controlServer: Server;
  manager: CallManager;
}> {
  const store = overrides?.store ?? new CallStore(cfg.home);
  const provider: TelephonyProvider =
    overrides?.provider ?? new TwilioProvider({ accountSid: cfg.twilio.accountSid, authToken: cfg.twilio.authToken });
  const replay = overrides?.replay ?? new ReplayCache();
  const drainTimeoutMs = overrides?.drainTimeoutMs ?? DRAIN_TIMEOUT_MS;

  const publicServer = createServer();
  await listen(publicServer, cfg.serve.publicPort);
  const publicPort = (publicServer.address() as AddressInfo).port;

  // Default (no static tunnel URL configured yet — Task 14 wires that up):
  // derive from the port we actually bound, so a test using publicPort: 0
  // can independently reconstruct the same URL from publicServer.address().
  const publicUrl = overrides?.publicUrl ?? (() => cfg.serve.publicUrl ?? `http://127.0.0.1:${publicPort}`);

  const urls = {
    answerUrl: publicUrlFor(publicUrl(), "voice/webhook?kind=answer"),
    statusCallbackUrl: publicUrlFor(publicUrl(), "voice/webhook?kind=status"),
    amdCallbackUrl: publicUrlFor(publicUrl(), "voice/webhook?kind=amd")
  };

  const manager = new CallManager({
    store,
    provider,
    limits: cfg.limits,
    urls,
    fromNumber: cfg.twilio.fromNumber
  });

  // Finding 2: reconcile any call left non-terminal on disk by a previous
  // process instance (crash, kill -9, a shutdown-drain that itself timed
  // out) — see reaper.ts's own doc comment for the full rationale. The
  // one-shot startup sweep runs (and is awaited) before the daemon is
  // wired to serve any traffic; the periodic sweep then runs every 60s for
  // the life of the process, guarded so it can never touch a call this
  // process is actually still running.
  const reaper = createReaper({
    store,
    provider,
    maxDurationSec: cfg.limits.maxDurationSec,
    hasActiveSession: (id) => manager.getActive()?.id === id
  });
  await reaper.sweepOnStartup();
  reaper.start();

  const realtimeFactory =
    overrides?.realtimeFactory ??
    ((opts: ConstructorParameters<typeof RealtimeSession>[0]) =>
      // connectTimeoutMs/maxReconnectAttempts are set here (not left at
      // ManagedRealtimeSession's defaults): the managed wrapper's
      // worst-case connect wall time with defaults is ~65s (5 attempts x
      // 10s ack timeout + backoff), far beyond what a live phone call can
      // wait through — see task-9's note for Task 12.
      new ManagedRealtimeSession({ ...opts, connectTimeoutMs: 5000, maxReconnectAttempts: 2 }));
  const summarize = overrides?.summarize ?? summarizeCall;

  const handler = createPublicHandler({
    manager,
    authToken: cfg.twilio.authToken,
    publicUrl,
    replay
  });

  publicServer.on("request", (req, res) => {
    // Defensive backstop: createPublicHandler already catches internally
    // and always resolves (never rejects), so this .catch() should be
    // unreachable. It exists so a future change to webhook.ts can never
    // crash the only public listener via an unhandled promise rejection —
    // the same failure mode this fixes for the handler itself.
    handler(req, res).catch((err: unknown) => {
      console.error("[server] unhandled public handler error:", err);
      if (!res.headersSent) {
        res.writeHead(500).end();
      } else if (!res.writableEnded) {
        res.end();
      }
    });
  });

  // Media-stream WS upgrade: GET /voice/stream?token=<streamToken>. The
  // token is validated synchronously here, before the WS handshake ever
  // completes, so an invalid/unknown token never gets as far as exchanging
  // a single frame (global-constraints.md: the public listener serves
  // nothing beyond the webhook + this one upgrade path).
  const wss = new WebSocketServer({ noServer: true });
  // MVP tracks at most one live call (maxConcurrentCalls=1) — this is the
  // CallSession for whichever call currently has a connected media stream,
  // used only to route the AMD leave-message branch (below) to a live
  // realtime session.
  let activeSession: CallSession | undefined;
  // The promise from that same session's run() — CallSession.run()
  // resolves only once the call is fully finalized (record persisted
  // terminal, transcript flushed, summary saved), which is exactly the
  // signal drainActiveSession() (below) needs to wait on at shutdown; it
  // can't be recovered from `activeSession` alone once run()'s own
  // .catch()/.finally() chain below has already been attached.
  let activeRun: Promise<void> | undefined;
  // AMD leave-message can arrive before any media stream — and therefore
  // any CallSession — has connected at all (Twilio's AMD callback and the
  // <Connect><Stream> negotiation race independently). Stashes that call's
  // id so the upgrade handler below can replay it through
  // CallSession.switchToVoicemail() the moment the session is constructed,
  // mirroring how the hangup branch doesn't need a session to act at all.
  let pendingVoicemailCallId: string | undefined;

  publicServer.on("upgrade", (req, socket, head) => {
    let pathname: string;
    let token: string | null;
    try {
      const requestUrl = new URL(req.url ?? "/", "http://internal");
      pathname = requestUrl.pathname;
      token = requestUrl.searchParams.get("token");
    } catch {
      socket.destroy();
      return;
    }

    if (pathname !== STREAM_PATH) {
      socket.destroy();
      return;
    }

    const rec = token ? manager.getByStreamToken(token) : undefined;
    if (!rec) {
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      // Forwarding closures: MediaStreamConnection's handlers must be
      // supplied at its own construction — necessarily before the
      // CallSession that needs this MediaStreamConnection as one of its
      // own deps can exist. `session` is assigned synchronously right
      // after; these closures only ever run later, asynchronously, off the
      // socket's own event loop, so it's always assigned by then.
      let session: CallSession;
      const media = new MediaStreamConnection(ws, {
        onStart: () => {},
        onAudio: (mulaw) => session.onCallerAudio(mulaw),
        onStop: () => session.onMediaStop()
      });
      session = new CallSession({ record: rec, manager, media, realtimeFactory, config: cfg, summarize });
      activeSession = session;
      if (pendingVoicemailCallId === rec.id) {
        // A machine+leave-message AMD event arrived before this stream
        // connected — replay it now that a session finally exists. If the
        // realtime socket isn't open yet either, switchToVoicemail() itself
        // stashes it again (CallSession-level) and applies it once connect()
        // succeeds.
        pendingVoicemailCallId = undefined;
        session.switchToVoicemail();
      }
      manager.markStreaming(rec.id).catch((err: unknown) => {
        console.warn(`[server] markStreaming(${rec.id}) failed:`, err instanceof Error ? err.message : err);
        // The record can never reach in-progress now — the duration-cap
        // timer never arms, and this session would otherwise run
        // uncapped. Treat it as a wedged call and tear it down rather than
        // let it run forever.
        session.abort();
      });
      const runPromise = session.run();
      activeRun = runPromise;
      runPromise
        .catch((err: unknown) => console.error("[server] call session error:", err))
        .finally(() => {
          if (activeSession === session) activeSession = undefined;
          if (activeRun === runPromise) activeRun = undefined;
        });
    });
  });

  // AMD routing lives here rather than inside CallSession: a "machine" +
  // "hangup" event can arrive before any media stream — and therefore any
  // CallSession — ever connects (Twilio's AMD callback and the
  // <Connect><Stream> negotiation race independently), so the hangup branch
  // must not depend on a live session existing. "leave-message" does need a
  // live realtime session, so that branch is routed to whichever
  // CallSession is currently active for this call.
  manager.on("amd", (rec: CallRecord, result: "human" | "machine") => {
    if (result !== "machine") return;
    const policy = rec.params.amdPolicy ?? cfg.defaults.amdPolicy;
    if (policy === "hangup") {
      manager.endCall(rec.id, "amd-hangup").catch((err: unknown) => {
        console.warn(`[server] endCall(${rec.id}, "amd-hangup") failed:`, err instanceof Error ? err.message : err);
      });
      return;
    }
    if (activeSession?.id === rec.id) {
      activeSession.switchToVoicemail();
    } else {
      // No stream has connected yet for this call — stash it; the upgrade
      // handler above replays it via switchToVoicemail() as soon as the
      // session is constructed.
      pendingVoicemailCallId = rec.id;
    }
  });

  // The full localhost control API (initiate/status/transcript/end); see
  // src/control-api.ts. `GET /health` is the only unauthenticated route.
  const controlHandler = createControlHandler({ manager, store, config: cfg, publicUrl });
  const controlServer = createServer((req, res) => {
    // Defensive backstop, mirroring the identical one on publicServer above:
    // createControlHandler already catches internally and always resolves
    // (never rejects), so this .catch() should be unreachable.
    controlHandler(req, res).catch((err: unknown) => {
      console.error("[server] unhandled control handler error:", err);
      if (!res.headersSent) {
        res.writeHead(500).end();
      } else if (!res.writableEnded) {
        res.end();
      }
    });
  });
  try {
    await listen(controlServer, cfg.serve.controlPort, "127.0.0.1");
  } catch (err) {
    // The public listener is already live at this point (bound and
    // serving webhooks) — if the control port fails to bind (e.g.
    // EADDRINUSE from a second daemon instance), leaving it running would
    // orphan a live, unclosable public listener with a wired CallManager.
    // Close it before propagating the failure so a caller that catches
    // startServer's rejection isn't left with a leaked listener they have
    // no handle to. reaper.start() (above) already armed its periodic
    // timer — stop it too, or it would keep firing against a store/provider
    // this failed startServer() call is otherwise abandoning.
    reaper.stop();
    await Promise.all([closeWss(wss), closeServer(publicServer)]).catch(() => {
      // Best-effort: publicServer is already being torn down; a failure
      // here must not mask the real error below.
    });
    throw err;
  }

  /**
   * Direct, manager-bypassing terminal write for a call whose graceful
   * drain (drainCall, below) didn't finish in time. `CallManager`
   * serializes every mutating operation through a single FIFO lock queue
   * (see manager.ts) — if the reason a drain timed out is a provider call
   * that's genuinely wedged (e.g. Twilio's hangup API hanging with no
   * timeout of its own), any *further* manager-routed call — including
   * `manager.finalize` — would simply queue up behind it and could never
   * actually run before the process exits, making it useless as a "we
   * gave up, mark this terminal" fallback (this was Task 14's original
   * bug: the fallback called `manager.finalize`, fire-and-forget, and so
   * could end up never actually applying). Writing straight through the
   * `store` handle startServer already holds sidesteps the queue entirely
   * — by the time this runs the process is on its way out, so the
   * manager's in-memory state no longer matters.
   *
   * Guarded against clobbering a call that *did* finish finalizing through
   * its normal path in the meantime (the common case: the manager-level
   * finalize from `endCall` often completes almost immediately even when
   * whatever else made the overall drain slow — e.g. summarization — is
   * still running): returns `false` without writing anything when the
   * record is already terminal.
   */
  async function forceTerminalRecord(id: string): Promise<boolean> {
    try {
      const rec = await store.get(id);
      if (!rec || TERMINAL_STATUSES.has(rec.status)) return false;
      const updated: CallRecord = {
        ...rec,
        status: "interrupted",
        endedAt: new Date().toISOString(),
        error: "shutdown-drain-timeout"
      };
      await store.save(updated);
      return true;
    } catch (err) {
      console.warn(`[server] force-terminal write failed for ${id}:`, err instanceof Error ? err.message : err);
      return false;
    }
  }

  // Races `work` (whatever "drained gracefully" means for the caller —
  // see drainActiveSession below) against `drainTimeoutMs`. On timeout,
  // attempts forceTerminalRecord and logs accurately depending on whether
  // it actually had to force a write or found the record already
  // finalized through its normal path (previously this warned
  // "force-finalizing" unconditionally, even on the no-op path).
  async function drainCall(id: string, work: () => Promise<unknown>): Promise<void> {
    const timedOut = await Promise.race([
      work().then(() => false as const),
      delay(drainTimeoutMs).then(() => true as const)
    ]);
    if (!timedOut) return;

    const forced = await forceTerminalRecord(id);
    if (forced) {
      console.warn(
        `[server] shutdown drain timed out after ${drainTimeoutMs}ms for call ${id}; forced a terminal record (interrupted)`
      );
    } else {
      console.warn(
        `[server] shutdown drain timed out after ${drainTimeoutMs}ms for call ${id}; it had already finalized through its normal path`
      );
    }
  }

  /**
   * Shutdown-time drain, honoring both of this task's binding controller
   * notes (createShutdownHandler closes the control listener before
   * calling this, and keeps the public listener/tunnel up throughout it):
   *
   * 1. A bare `close()` resolves before an in-flight call's teardown
   *    completes (Task 12's note) — a daemon that exited right after
   *    close() would lose that call's last finalize/transcript/summary
   *    writes. And a call still in its pre-stream dialing/ringing window
   *    (no CallSession/`activeRun` yet — only a manager-tracked active
   *    record, for up to Twilio's 30s ring timeout) was previously never
   *    drained at all. Both cases are asked to end gracefully via
   *    `manager.endCall(id, "shutdown")` (idempotent no-op if the manager
   *    is already independently tearing the same call down); a call with
   *    a live media stream additionally awaits its CallSession's own
   *    completion signal (`activeRun` — resolves only once the record is
   *    persisted terminal with transcript/summary saved).
   * 2. Bounded by `drainTimeoutMs` (10s in production) so shutdown itself
   *    can never hang forever. A call that finishes draining within the
   *    bound keeps whatever status its normal endCall("shutdown") path
   *    produced — never forced to "interrupted". Only past the bound does
   *    `drainCall` force a terminal record (see forceTerminalRecord above).
   */
  async function drainActiveSession(): Promise<void> {
    const session = activeSession;
    const runPromise = activeRun;

    if (session && runPromise) {
      await drainCall(session.id, () =>
        Promise.all([
          manager.endCall(session.id, "shutdown").catch((err: unknown) => {
            console.warn(`[server] shutdown endCall(${session.id}) failed:`, err instanceof Error ? err.message : err);
          }),
          runPromise
        ])
      );
      return;
    }

    // No live media stream (still dialing/ringing) but the manager still
    // has an active record — the pre-stream window note 2 was flagged
    // for: a real outbound call in flight with no CallSession to drain via
    // the branch above.
    const active = manager.getActive();
    if (!active) return;

    await drainCall(active.id, () =>
      manager.endCall(active.id, "shutdown").catch((err: unknown) => {
        console.warn(`[server] shutdown endCall(${active.id}) failed:`, err instanceof Error ? err.message : err);
      })
    );
  }

  /**
   * Closes only the loopback control listener — the first step of
   * shutdown (see createShutdownHandler), so `POST /calls` (and every
   * other control route) stops accepting new work before the drain below
   * gives whatever call is already in flight a chance to finish. The
   * public listener (webhooks + the media stream) and any tunnel process
   * deliberately stay up through the drain — Twilio still needs to reach
   * them for that in-flight call.
   */
  async function closeControl(): Promise<void> {
    await closeServer(controlServer);
  }

  return {
    manager,
    publicServer,
    controlServer,
    drainActiveSession,
    closeControl,
    async close() {
      // Disarm the periodic reaper sweep first — it's unref'd so it can't
      // keep the process alive on its own, but leaving it armed past
      // close() would mean a stray sweep could still write to `store` (and
      // call the now-possibly-torn-down `provider`) after this handle is
      // considered fully shut down.
      reaper.stop();
      // wss (noServer: true) has no listening socket of its own — closing
      // it only waits for its tracked clients to disconnect, and it never
      // terminates them itself. Without explicitly terminating them first,
      // a call still mid-stream leaves an upgraded socket open that
      // publicServer.close() (which, as the underlying net.Server, also
      // waits for every accepted connection to end) then waits on forever.
      await Promise.all([closeWss(wss), closeServer(publicServer), closeServer(controlServer)]);
    }
  };
}

/**
 * Resolves the public URL/tunnel and starts the server. Extracted from
 * main() so the startup-failure cleanup path below is directly testable
 * without touching real config/env or registering real process signal
 * handlers.
 *
 * If startServer() fails after a tunnel process was already spawned (e.g.
 * EADDRINUSE on the public port — the everyday case of a second daemon
 * instance, or a leftover from a previous run), the spawned cloudflared/
 * ngrok child must be closed here — left running, it's both leaked (never
 * killed) AND its own flowing stdio pipes keep the Node event loop alive,
 * so the fatal-error handler at the bottom of this file would print the
 * error and then hang forever instead of actually exiting.
 */
/**
 * Probe the public URL through the tunnel edge until OUR server answers.
 * Fresh trycloudflare quick tunnels take several seconds to propagate; in
 * that window the edge returns 502 (and WSS upgrades fail with Twilio error
 * 31920) even though cloudflared has already printed the URL — observed live
 * on 2026-08-18: a call placed ~45s after boot lost its answer-webhook
 * media stream and its AMD callback to exactly this. Success = HTTP 404,
 * the one status only our public handler returns for GET /voice/webhook
 * (edge failures return 5xx; a signature-gated POST would be 403).
 * On timeout we warn and continue — a static publicUrl behind a firewall
 * that drops GETs must not brick startup.
 */
export async function waitForTunnelReady(
  publicUrl: string,
  opts?: { timeoutMs?: number; intervalMs?: number; fetchImpl?: typeof fetch }
): Promise<boolean> {
  const timeoutMs = opts?.timeoutMs ?? 30_000;
  const intervalMs = opts?.intervalMs ?? 1_000;
  const fetchFn = opts?.fetchImpl ?? fetch;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetchFn(`${publicUrl}/voice/webhook`, {
        method: "GET",
        signal: AbortSignal.timeout(Math.min(intervalMs * 2, 5_000))
      });
      if (res.status === 404) return true;
    } catch {
      // Edge not routable yet (DNS, connect, or timeout) — keep polling.
    }
    if (Date.now() >= deadline) {
      console.warn(
        `[server] tunnel readiness probe timed out after ${timeoutMs}ms — ` +
          `continuing, but ${publicUrl} may not be reachable from Twilio yet`
      );
      return false;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

export async function bootDaemon(
  cfg: Config,
  spawnImpl?: Parameters<typeof resolvePublicUrl>[1],
  opts?: { tunnelProbe?: Parameters<typeof waitForTunnelReady>[1] }
): Promise<{ handle: Awaited<ReturnType<typeof startServer>>; tunnel?: Tunnel; publicUrl: string }> {
  const { url: publicUrl, tunnel } = await resolvePublicUrl(cfg, spawnImpl);
  const runtimeCfg: Config = { ...cfg, serve: { ...cfg.serve, publicUrl } };

  try {
    const handle = await startServer(runtimeCfg);
    // Only after the listeners are live: wait for the tunnel edge to route
    // to us before declaring readiness, so the first call's webhooks don't
    // land in the propagation window.
    if (await waitForTunnelReady(publicUrl, opts?.tunnelProbe)) {
      console.log(`[server] tunnel verified reachable at ${publicUrl}`);
    }
    return { handle, tunnel, publicUrl };
  } catch (err) {
    await tunnel?.close().catch(() => {
      // Best-effort: startServer's own failure is the real error to
      // propagate below; a failure tearing down the tunnel must not mask it.
    });
    throw err;
  }
}

/**
 * Daemon entrypoint: loadConfig -> bootDaemon (resolvePublicUrl + startServer)
 * -> print the (secret-free) startup banner -> wire SIGINT/SIGTERM to the
 * shared shutdown sequence (closeControl -> drain -> close -> tunnel.close
 * -> exit). Not unit-tested itself — it's thin composition over pieces
 * (formatBanner, createShutdownHandler, bootDaemon) that are each tested on
 * their own; only runs at all when this file is executed directly (see the
 * import.meta.url guard below), never when it's merely imported by tests.
 */
async function main(): Promise<void> {
  const cfg = loadConfig();
  const { handle, tunnel, publicUrl } = await bootDaemon(cfg);
  console.log(formatBanner({ ...cfg, serve: { ...cfg.serve, publicUrl } }, publicUrl));

  const shutdown = createShutdownHandler({ handle, tunnel });
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err: unknown) => {
    console.error("[pi-voice] fatal startup error:", err);
    // A plain process.exitCode assignment only takes effect once the event
    // loop naturally drains — but bootDaemon's own tunnel-cleanup aside, a
    // startup failure can still leave something with flowing stdio/open
    // handles alive (e.g. a listener error handler on the other server).
    // process.exit(1) forces the process down immediately rather than
    // risking a silent hang after printing the error.
    process.exit(1);
  });
}

// Terminates every client currently tracked by a `noServer: true`
// WebSocketServer, then closes it. wss.close() alone only stops it from
// accepting further upgrades and waits for existing clients to disconnect
// on their own — it never terminates them (see WebSocketServer.close's own
// doc comment: "emit the 'close' event when all existing connections are
// closed").
function closeWss(server: WebSocketServer): Promise<void> {
  for (const client of server.clients) {
    client.terminate();
  }
  return new Promise<void>((resolve) => server.close(() => resolve()));
}

function listen(server: Server, port: number, host?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    const onListening = (): void => {
      server.removeListener("error", reject);
      // Node's EventEmitter special-cases "error": emitting it with no
      // listener attached throws, crashing the process. Once bound, the
      // one-shot `reject` listener above is gone — without a replacement,
      // a later runtime error (e.g. EMFILE accepting a new connection)
      // would have nothing listening and take the process down with it.
      server.on("error", (err) => {
        console.error(`[server] listener error on port ${port}:`, err);
      });
      resolve();
    };
    if (host !== undefined) {
      server.listen(port, host, onListening);
    } else {
      server.listen(port, onListening);
    }
  });
}

// Idempotent: server.close() on an already-closed net.Server calls back
// with ERR_SERVER_NOT_RUNNING, which would otherwise make this reject.
// That matters now that closeControl() (below) can close controlServer
// ahead of close() — close() must still be safe to call afterward (both
// the shutdown sequence, which does exactly that, and every pre-existing
// test that just calls close() directly need this to be a harmless no-op
// the second time).
function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}
