// Adapted from openclaw-voice-call-realtime (MIT) — https://github.com/TristanBrotherton/openclaw-voice-call-realtime
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import type { Config } from "./config.js";

export interface Tunnel {
  url: string;
  close(): Promise<void>;
}

// cloudflared prints its assigned quick-tunnel URL to stderr once the
// tunnel is up; there is no other signal (no exit code, no stdout) that it's
// ready. 120s per the brief — generous enough for a cold Cloudflare edge
// negotiation, bounded so a daemon start-up can't hang forever if
// cloudflared is stuck.
const CLOUDFLARED_TIMEOUT_MS = 120_000;
const TRYCLOUDFLARE_URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

// ngrok has no equivalent "quick tunnel" cold-start cost — 30s is already
// generous for a local process to report its own assigned URL.
const NGROK_TIMEOUT_MS = 30_000;

/**
 * Resolves the public HTTPS URL Twilio will use to reach this daemon's
 * webhook, and — when a tunnel provider spawned a process to get it —
 * the {@link Tunnel} handle to shut that process back down at daemon exit.
 *
 * - `cfg.serve.publicUrl` set: returned as-is (must be https — Twilio
 *   requires HTTPS webhook URLs); no process is spawned.
 * - `cfg.serve.tunnel === "none"` with no `publicUrl`: throws with setup
 *   guidance (there is no way to reach this daemon from Twilio otherwise).
 * - `"cloudflared"` / `"ngrok"`: spawns the corresponding CLI (via
 *   `spawnImpl`, real `child_process.spawn` by default — a fake
 *   ChildProcess-like EventEmitter can be injected for tests) pointed at
 *   `cfg.serve.publicPort`, and parses the assigned public URL out of its
 *   own log output.
 */
export async function resolvePublicUrl(
  cfg: Config,
  spawnImpl: typeof spawn = spawn
): Promise<{ url: string; tunnel?: Tunnel }> {
  if (cfg.serve.publicUrl) {
    if (!cfg.serve.publicUrl.startsWith("https://")) {
      throw new Error(
        `serve.publicUrl must be an https URL (Twilio requires HTTPS webhooks) — got "${cfg.serve.publicUrl}"`
      );
    }
    return { url: cfg.serve.publicUrl };
  }

  if (cfg.serve.tunnel === "none") {
    throw new Error(
      'serve.tunnel is "none" but no serve.publicUrl is configured — Twilio has no way to reach this daemon. ' +
        'Either set serve.publicUrl to a static https URL that forwards to this machine, or set serve.tunnel to ' +
        '"cloudflared" or "ngrok" in ~/.pi-voice/config.json to have one started automatically.'
    );
  }

  if (cfg.serve.tunnel === "cloudflared") {
    return spawnCloudflared(cfg.serve.publicPort, spawnImpl);
  }

  return spawnNgrok(cfg.serve.publicPort, spawnImpl);
}

function spawnCloudflared(
  port: number,
  spawnImpl: typeof spawn
): Promise<{ url: string; tunnel: Tunnel }> {
  return new Promise((resolve, reject) => {
    // --protocol http2: the default QUIC transport is blocked or degraded on
    // some networks, which manifests as intermittent edge 502s on webhooks
    // and a hard 502 on EVERY WebSocket upgrade (Twilio error 31920 — the
    // media stream never attaches and calls drop ~1s after answer). Observed
    // live 2026-08-18; HTTP/2 transport avoids QUIC entirely.
    const proc = spawnImpl("cloudflared", ["tunnel", "--url", `http://127.0.0.1:${port}`, "--protocol", "http2"], {
      stdio: ["ignore", "pipe", "pipe"]
    });

    let output = "";
    const settle = onceSettler();

    const timer = setTimeout(() => {
      settle(() => {
        proc.kill("SIGTERM");
        reject(
          new Error(
            `cloudflared did not report a public URL within ${CLOUDFLARED_TIMEOUT_MS / 1000}s. Captured output:\n${output}`
          )
        );
      });
    }, CLOUDFLARED_TIMEOUT_MS);
    timer.unref?.();

    // cloudflared logs its assigned quick-tunnel URL to stderr, not stdout.
    proc.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      const match = TRYCLOUDFLARE_URL_RE.exec(output);
      if (match) {
        settle(() => {
          clearTimeout(timer);
          resolve({ url: match[0], tunnel: makeProcessTunnel(match[0], proc) });
        });
      }
    });

    proc.on("error", (err: NodeJS.ErrnoException) => {
      settle(() => {
        clearTimeout(timer);
        reject(
          new Error(
            `failed to start cloudflared: ${err.message}. Is cloudflared installed and on PATH? ` +
              "See https://developers.cloudflare.com/cloudflared/downloads/"
          )
        );
      });
    });

    proc.on("close", (code: number | null) => {
      settle(() => {
        clearTimeout(timer);
        reject(new Error(`cloudflared exited (code ${code}) before reporting a public URL. Captured output:\n${output}`));
      });
    });
  });
}

function spawnNgrok(port: number, spawnImpl: typeof spawn): Promise<{ url: string; tunnel: Tunnel }> {
  return new Promise((resolve, reject) => {
    const proc = spawnImpl("ngrok", ["http", String(port), "--log", "stdout", "--log-format", "json"], {
      stdio: ["ignore", "pipe", "pipe"]
    });

    let output = "";
    let lineBuffer = "";
    const settle = onceSettler();

    const timer = setTimeout(() => {
      settle(() => {
        proc.kill("SIGTERM");
        reject(
          new Error(`ngrok did not report a public URL within ${NGROK_TIMEOUT_MS / 1000}s. Captured output:\n${output}`)
        );
      });
    }, NGROK_TIMEOUT_MS);
    timer.unref?.();

    // ngrok (--log stdout --log-format json) emits one JSON object per
    // line; the tunnel's public URL appears on the "started tunnel" line.
    proc.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      output += text;
      lineBuffer += text;
      const lines = lineBuffer.split("\n");
      lineBuffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) continue;
        let log: Record<string, unknown>;
        try {
          log = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue; // non-JSON startup chatter — not every line is a log record
        }
        const url = typeof log.url === "string" ? log.url : undefined;
        if (url) {
          settle(() => {
            clearTimeout(timer);
            resolve({ url, tunnel: makeProcessTunnel(url, proc) });
          });
          return;
        }
      }
    });

    proc.on("error", (err: NodeJS.ErrnoException) => {
      settle(() => {
        clearTimeout(timer);
        reject(
          new Error(`failed to start ngrok: ${err.message}. Is ngrok installed and on PATH? See https://ngrok.com/download`)
        );
      });
    });

    proc.on("close", (code: number | null) => {
      settle(() => {
        clearTimeout(timer);
        reject(new Error(`ngrok exited (code ${code}) before reporting a public URL. Captured output:\n${output}`));
      });
    });
  });
}

/** Runs the first settle callback only — every provider races 3-4 event sources (data/error/close/timeout) that must resolve/reject the outer promise exactly once. */
function onceSettler(): (fn: () => void) => void {
  let done = false;
  return (fn: () => void) => {
    if (done) return;
    done = true;
    fn();
  };
}

function makeProcessTunnel(url: string, proc: ChildProcess): Tunnel {
  return {
    url,
    async close(): Promise<void> {
      proc.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        proc.once("close", () => resolve());
        // Fallback: don't let a wedged tunnel process hang daemon shutdown
        // indefinitely if it doesn't honor SIGTERM promptly.
        const t = setTimeout(resolve, 2000);
        t.unref?.();
      });
    }
  };
}
