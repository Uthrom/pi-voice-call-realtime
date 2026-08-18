import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Config } from "./config.js";
import { CallStore } from "./store.js";
import { CallManager } from "./manager.js";
import type { TelephonyProvider } from "./manager.js";
import { TwilioProvider } from "./providers/twilio.js";
import { ReplayCache, publicUrlFor } from "./webhook-security.js";
import { createPublicHandler } from "./webhook.js";

// The injectable set of collaborators startServer wires together. Kept
// minimal for this task (assembly only, no realtime wiring yet) — a later
// task (media stream / control API) extends this.
export interface Deps {
  store: CallStore;
  provider: TelephonyProvider;
  replay: ReplayCache;
  publicUrl: () => string;
}

export async function startServer(
  cfg: Config,
  overrides?: Partial<Deps>
): Promise<{
  close(): Promise<void>;
  publicServer: Server;
  controlServer: Server;
  manager: CallManager;
}> {
  const store = overrides?.store ?? new CallStore(cfg.home);
  const provider: TelephonyProvider =
    overrides?.provider ?? new TwilioProvider({ accountSid: cfg.twilio.accountSid, authToken: cfg.twilio.authToken });
  const replay = overrides?.replay ?? new ReplayCache();

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

  const handler = createPublicHandler({
    manager,
    authToken: cfg.twilio.authToken,
    publicUrl,
    replay
  });

  publicServer.on("request", (req, res) => {
    void handler(req, res);
  });

  // Task 13 mounts the full control API (initiate/status/transcript/end);
  // for now, just the unauthenticated health check.
  const controlServer = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(404).end();
  });
  await listen(controlServer, cfg.serve.controlPort, "127.0.0.1");

  return {
    manager,
    publicServer,
    controlServer,
    async close() {
      await Promise.all([closeServer(publicServer), closeServer(controlServer)]);
    }
  };
}

function listen(server: Server, port: number, host?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    const onListening = (): void => {
      server.removeListener("error", reject);
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
