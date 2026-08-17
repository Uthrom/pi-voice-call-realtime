import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";

function homeWith(json: object): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-voice-"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), JSON.stringify(json));
  return dir;
}

const minimal = {
  twilio: { accountSid: "ACxxx", authToken: "tok", fromNumber: "+15550001111" },
  openai: { apiKey: "sk-test" },
  serve: { controlToken: "secret" }
};

describe("loadConfig", () => {
  it("applies defaults over a minimal config", () => {
    const cfg = loadConfig({ home: homeWith(minimal), env: {} });
    expect(cfg.serve.controlPort).toBe(3335);
    expect(cfg.serve.publicPort).toBe(3334);
    expect(cfg.serve.tunnel).toBe("cloudflared");
    expect(cfg.openai.realtimeModel).toBe("gpt-realtime");
    expect(cfg.openai.voice).toBe("alloy");
    expect(cfg.summaryModel).toBe("gpt-4o-mini");
    expect(cfg.limits).toEqual({ maxDurationSec: 900, maxConcurrentCalls: 1, dailyCallCap: 20 });
    expect(cfg.defaults.amdPolicy).toBe("leave-message");
  });

  it("lets env vars override file credentials", () => {
    const cfg = loadConfig({
      home: homeWith(minimal),
      env: { TWILIO_AUTH_TOKEN: "env-tok", OPENAI_API_KEY: "sk-env" }
    });
    expect(cfg.twilio.authToken).toBe("env-tok");
    expect(cfg.openai.apiKey).toBe("sk-env");
  });

  it("throws a readable error when controlToken is missing", () => {
    const bad = { ...minimal, serve: {} };
    expect(() => loadConfig({ home: homeWith(bad), env: {} }))
      .toThrow(/controlToken/);
  });

  it("rejects a non-E.164 fromNumber", () => {
    const bad = { ...minimal, twilio: { ...minimal.twilio, fromNumber: "5550001111" } };
    expect(() => loadConfig({ home: homeWith(bad), env: {} })).toThrow(/E\.164|fromNumber/);
  });

  it("throws a readable error when controlToken is an empty string", () => {
    const bad = { ...minimal, serve: { controlToken: "" } };
    expect(() => loadConfig({ home: homeWith(bad), env: {} })).toThrow(/controlToken/);
  });

  it("does not let an empty-string env var wipe out a valid file credential", () => {
    const cfg = loadConfig({
      home: homeWith(minimal),
      env: { PI_VOICE_CONTROL_TOKEN: "", TWILIO_AUTH_TOKEN: "" }
    });
    expect(cfg.serve.controlToken).toBe("secret");
    expect(cfg.twilio.authToken).toBe("tok");
  });
});
