import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { spawn } from "node:child_process";
import { resolvePublicUrl } from "../src/tunnel.js";
import type { Config } from "../src/config.js";

// ---- test doubles ----

/**
 * A minimal ChildProcess-like fake: an EventEmitter with `.stdout`/`.stderr`
 * sub-emitters (mirroring the readable-stream `.on("data", ...)` surface
 * tunnel.ts actually touches) and a stubbed `.kill()`. Good enough to drive
 * every code path in tunnel.ts without spawning any real process.
 */
function fakeChildProcess(): EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: ReturnType<typeof vi.fn> } {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
  };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = vi.fn(() => true);
  return proc;
}

function fakeSpawnImpl(proc: ReturnType<typeof fakeChildProcess>): { spawnImpl: typeof spawn; calls: unknown[][] } {
  const calls: unknown[][] = [];
  const spawnImpl = ((...args: unknown[]) => {
    calls.push(args);
    return proc;
  }) as unknown as typeof spawn;
  return { spawnImpl, calls };
}

function baseConfig(overrides: Partial<Config["serve"]> = {}): Config {
  return {
    home: "/tmp/pi-voice-test",
    twilio: { accountSid: "ACxxx", authToken: "tok", fromNumber: "+15550001111" },
    openai: { apiKey: "sk-test", realtimeModel: "gpt-realtime", voice: "alloy" },
    summary: { model: "gpt-4o-mini", baseUrl: "https://api.openai.com/v1", apiKey: "sk-test" },
    serve: {
      controlPort: 3335,
      publicPort: 3334,
      tunnel: "none",
      controlToken: "control-secret",
      ...overrides
    },
    limits: { maxDurationSec: 900, maxConcurrentCalls: 1, dailyCallCap: 20 },
    defaults: { callerIdentity: "pi", amdPolicy: "leave-message" }
  };
}

describe("resolvePublicUrl", () => {
  it("returns a configured static https publicUrl as-is, without spawning anything", async () => {
    const cfg = baseConfig({ publicUrl: "https://static.example.com", tunnel: "cloudflared" });
    const { spawnImpl, calls } = fakeSpawnImpl(fakeChildProcess());

    const result = await resolvePublicUrl(cfg, spawnImpl);

    expect(result.url).toBe("https://static.example.com");
    expect(result.tunnel).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it('throws mentioning "publicUrl" when tunnel is "none" and no publicUrl is configured', async () => {
    const cfg = baseConfig({ tunnel: "none" });
    const { spawnImpl } = fakeSpawnImpl(fakeChildProcess());

    await expect(resolvePublicUrl(cfg, spawnImpl)).rejects.toThrow(/publicUrl/);
  });

  it("throws when the configured static publicUrl is not https", async () => {
    const cfg = baseConfig({ publicUrl: "http://insecure.example.com", tunnel: "none" });
    const { spawnImpl } = fakeSpawnImpl(fakeChildProcess());

    await expect(resolvePublicUrl(cfg, spawnImpl)).rejects.toThrow(/https/i);
  });

  describe("cloudflared", () => {
    it("spawns cloudflared with the local public port and resolves the trycloudflare URL parsed from stderr", async () => {
      const cfg = baseConfig({ tunnel: "cloudflared", publicPort: 4321 });
      const proc = fakeChildProcess();
      const { spawnImpl, calls } = fakeSpawnImpl(proc);

      const resultPromise = resolvePublicUrl(cfg, spawnImpl);

      // Give resolvePublicUrl a tick to spawn and attach its listeners.
      await Promise.resolve();
      proc.stderr.emit(
        "data",
        Buffer.from(
          "2024-01-01T00:00:00Z INF |  https://random-words-1234.trycloudflare.com                                    |\n"
        )
      );

      const result = await resultPromise;

      expect(result.url).toBe("https://random-words-1234.trycloudflare.com");
      expect(result.tunnel?.url).toBe("https://random-words-1234.trycloudflare.com");
      expect(calls[0][0]).toBe("cloudflared");
      expect(calls[0][1]).toEqual([
        "tunnel",
        "--url",
        "http://127.0.0.1:4321",
        "--protocol",
        "http2"
      ]);
    });

    it("rejects with the captured output when the process exits before reporting a URL", async () => {
      const cfg = baseConfig({ tunnel: "cloudflared", publicPort: 4321 });
      const proc = fakeChildProcess();
      const { spawnImpl } = fakeSpawnImpl(proc);

      const resultPromise = resolvePublicUrl(cfg, spawnImpl);
      await Promise.resolve();
      proc.stderr.emit("data", Buffer.from("failed to connect to origin\n"));
      proc.emit("close", 1);

      await expect(resultPromise).rejects.toThrow(/failed to connect to origin/);
    });

    it("rejects with an actionable message when the binary can't be spawned at all", async () => {
      const cfg = baseConfig({ tunnel: "cloudflared", publicPort: 4321 });
      const proc = fakeChildProcess();
      const { spawnImpl } = fakeSpawnImpl(proc);

      const resultPromise = resolvePublicUrl(cfg, spawnImpl);
      await Promise.resolve();
      const err = Object.assign(new Error("spawn cloudflared ENOENT"), { code: "ENOENT" });
      proc.emit("error", err);

      await expect(resultPromise).rejects.toThrow(/cloudflared/i);
    });

    it("rejects if no URL is reported within 120s", async () => {
      vi.useFakeTimers();
      try {
        const cfg = baseConfig({ tunnel: "cloudflared", publicPort: 4321 });
        const proc = fakeChildProcess();
        const { spawnImpl } = fakeSpawnImpl(proc);

        const resultPromise = resolvePublicUrl(cfg, spawnImpl);
        const assertion = expect(resultPromise).rejects.toThrow(/120s|timed out/i);

        await vi.advanceTimersByTimeAsync(120_000);
        await assertion;
        expect(proc.kill).toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("ngrok", () => {
    it("spawns ngrok with the local public port and resolves the URL parsed from a JSON stdout log line", async () => {
      const cfg = baseConfig({ tunnel: "ngrok", publicPort: 4321 });
      const proc = fakeChildProcess();
      const { spawnImpl, calls } = fakeSpawnImpl(proc);

      const resultPromise = resolvePublicUrl(cfg, spawnImpl);
      await Promise.resolve();
      proc.stdout.emit(
        "data",
        Buffer.from(
          `${JSON.stringify({ msg: "started tunnel", addr: "http://localhost:4321", url: "https://abcd1234.ngrok.io" })}\n`
        )
      );

      const result = await resultPromise;

      expect(result.url).toBe("https://abcd1234.ngrok.io");
      expect(result.tunnel?.url).toBe("https://abcd1234.ngrok.io");
      expect(calls[0][0]).toBe("ngrok");
      expect(calls[0][1]).toEqual(["http", "4321", "--log", "stdout", "--log-format", "json"]);
    });

    it("ignores non-JSON / unrelated log lines before the real one", async () => {
      const cfg = baseConfig({ tunnel: "ngrok", publicPort: 4321 });
      const proc = fakeChildProcess();
      const { spawnImpl } = fakeSpawnImpl(proc);

      const resultPromise = resolvePublicUrl(cfg, spawnImpl);
      await Promise.resolve();
      proc.stdout.emit("data", Buffer.from("not json at all\n"));
      proc.stdout.emit("data", Buffer.from(`${JSON.stringify({ msg: "some other log" })}\n`));
      proc.stdout.emit(
        "data",
        Buffer.from(`${JSON.stringify({ msg: "started tunnel", url: "https://xyz.ngrok.io" })}\n`)
      );

      const result = await resultPromise;
      expect(result.url).toBe("https://xyz.ngrok.io");
    });
  });

  describe("Tunnel.close()", () => {
    it("kills the spawned process", async () => {
      const cfg = baseConfig({ tunnel: "cloudflared", publicPort: 4321 });
      const proc = fakeChildProcess();
      const { spawnImpl } = fakeSpawnImpl(proc);

      const resultPromise = resolvePublicUrl(cfg, spawnImpl);
      await Promise.resolve();
      proc.stderr.emit("data", Buffer.from("https://random-words-1234.trycloudflare.com\n"));
      const result = await resultPromise;

      const closePromise = result.tunnel!.close();
      // close() waits for the process's own "close" event (with a fallback
      // timeout) — simulate the process actually exiting.
      proc.emit("close", 0);
      await closePromise;

      expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
    });
  });
});
