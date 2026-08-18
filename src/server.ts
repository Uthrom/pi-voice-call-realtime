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
import { resolvePublicUrl } from "./tunnel.js";
import type { Tunnel } from "./tunnel.js";

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
  handle: Pick<Awaited<ReturnType<typeof startServer>>, "drainActiveSession" | "close">;
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
      // Give an in-flight call its own bounded chance to finish through its
      // normal path (see drainActiveSession's doc comment) before anything
      // is torn down under it.
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
    // no handle to.
    await Promise.all([closeWss(wss), closeServer(publicServer)]).catch(() => {
      // Best-effort: publicServer is already being torn down; a failure
      // here must not mask the real error below.
    });
    throw err;
  }

  /**
   * Shutdown-time drain of whichever call is currently streaming (see
   * `activeSession`/`activeRun` above), honoring both of this task's
   * binding controller notes:
   *
   * 1. A bare `close()` resolves before an in-flight call's teardown
   *    completes (Task 12's note) — a daemon that exited right after
   *    close() would lose that call's last finalize/transcript/summary
   *    writes. This asks the call to end gracefully
   *    (`manager.endCall(id, "shutdown")` — safe to call even if the
   *    manager is already independently tearing the same call down, since
   *    endCall is itself an idempotent no-op on an already-terminal
   *    record) and awaits the *session's* own completion signal
   *    (`activeRun`, i.e. `CallSession.run()` — resolves only once the
   *    record is persisted terminal with transcript/summary saved).
   * 2. That wait is bounded by `drainTimeoutMs` (10s in production) so
   *    shutdown itself can never hang forever. Reconciling the brief's
   *    one-line "finalize any active call as interrupted" with note 1: a
   *    call that finishes draining within the bound keeps whatever status
   *    its normal endCall("shutdown") path produced — it is NOT forced to
   *    "interrupted". Only once the bound elapses do we attempt to force
   *    the record to "interrupted" — and even then, `manager.finalize` is
   *    itself a no-op against an already-terminal record (the common case:
   *    the manager-level finalize from endCall usually completes almost
   *    immediately even when the *session's* own trailing async work —
   *    transcript flush, summarization — is what's actually slow), so this
   *    never clobbers a call that already finalized normally. The
   *    force-finalize call is deliberately fire-and-forget (not awaited)
   *    here: it can itself still be queued behind a slow provider call
   *    inside CallManager's own serialized lock, and must never become a
   *    second way for this function — and therefore shutdown — to hang
   *    past its own bound.
   */
  async function drainActiveSession(): Promise<void> {
    const session = activeSession;
    const runPromise = activeRun;
    if (!session || !runPromise) return;

    const gracefulEnd = manager.endCall(session.id, "shutdown").catch((err: unknown) => {
      console.warn(`[server] shutdown endCall(${session.id}) failed:`, err instanceof Error ? err.message : err);
    });
    const drained = Promise.all([gracefulEnd, runPromise]).then(() => true as const);

    const timedOut = await Promise.race([drained.then(() => false as const), delay(drainTimeoutMs).then(() => true as const)]);

    if (timedOut) {
      console.warn(
        `[server] shutdown drain timed out after ${drainTimeoutMs}ms for call ${session.id}; force-finalizing as interrupted`
      );
      manager.finalize(session.id, "interrupted").catch((err: unknown) => {
        console.warn(`[server] force-finalize(interrupted) failed for ${session.id}:`, err instanceof Error ? err.message : err);
      });
    }
  }

  return {
    manager,
    publicServer,
    controlServer,
    drainActiveSession,
    async close() {
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
 * Daemon entrypoint: loadConfig -> resolvePublicUrl (static override or a
 * spawned cloudflared/ngrok tunnel) -> startServer -> print the (secret-free)
 * startup banner -> wire SIGINT/SIGTERM to the shared shutdown sequence
 * (drain -> close -> tunnel.close -> exit). Not unit-tested itself — it's
 * thin composition over pieces (formatBanner, createShutdownHandler,
 * resolvePublicUrl, startServer) that are each tested on their own; only
 * runs at all when this file is executed directly (see the import.meta.url
 * guard below), never when it's merely imported by tests.
 */
async function main(): Promise<void> {
  const cfg = loadConfig();
  const { url: publicUrl, tunnel } = await resolvePublicUrl(cfg);
  // Threading the resolved URL back through cfg.serve.publicUrl (rather
  // than overriding startServer's `publicUrl` dep directly) is the wiring
  // startServer already anticipated — see its own `publicUrl` default's
  // comment ("Task 14 wires that up").
  const runtimeCfg: Config = { ...cfg, serve: { ...cfg.serve, publicUrl } };

  const handle = await startServer(runtimeCfg);
  console.log(formatBanner(runtimeCfg, publicUrl));

  const shutdown = createShutdownHandler({ handle, tunnel });
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err: unknown) => {
    console.error("[pi-voice] fatal startup error:", err);
    process.exitCode = 1;
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

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}
