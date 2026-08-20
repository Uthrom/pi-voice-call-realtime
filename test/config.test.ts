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
    expect(cfg.summary).toEqual({
      model: "gpt-4o-mini",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test"
    });
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

  it("resolves a partial summary block against defaults and the openai key", () => {
    const cfg = loadConfig({
      home: homeWith({ ...minimal, summary: { model: "my-local-model" } }),
      env: {}
    });
    expect(cfg.summary).toEqual({
      model: "my-local-model",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test"
    });
  });

  it("honors a fully specified summary block", () => {
    const cfg = loadConfig({
      home: homeWith({
        ...minimal,
        summary: { model: "llama-3.3-70b", baseUrl: "https://llm.example.com/v1", apiKey: "sk-own" }
      }),
      env: {}
    });
    expect(cfg.summary).toEqual({
      model: "llama-3.3-70b",
      baseUrl: "https://llm.example.com/v1",
      apiKey: "sk-own"
    });
  });

  it("accepts the legacy top-level summaryModel as summary.model, with summary.model winning when both are set", () => {
    const legacyOnly = loadConfig({
      home: homeWith({ ...minimal, summaryModel: "legacy-model" }),
      env: {}
    });
    expect(legacyOnly.summary.model).toBe("legacy-model");

    const both = loadConfig({
      home: homeWith({ ...minimal, summaryModel: "legacy-model", summary: { model: "explicit-model" } }),
      env: {}
    });
    expect(both.summary.model).toBe("explicit-model");
  });

  it("passes through openai.reasoningEffort, absent by default", () => {
    const none = loadConfig({ home: homeWith(minimal), env: {} });
    expect(none.openai.reasoningEffort).toBeUndefined();

    const cfg = loadConfig({
      home: homeWith({ ...minimal, openai: { ...minimal.openai, reasoningEffort: "minimal" } }),
      env: {}
    });
    expect(cfg.openai.reasoningEffort).toBe("minimal");
  });

  it("rejects an invalid openai.reasoningEffort with a readable error", () => {
    const bad = { ...minimal, openai: { ...minimal.openai, reasoningEffort: "extreme" } };
    expect(() => loadConfig({ home: homeWith(bad), env: {} })).toThrow(/reasoningEffort/);
  });

  it("lets SUMMARY_API_KEY override the summary key without touching openai.apiKey", () => {
    const cfg = loadConfig({
      home: homeWith(minimal),
      env: { SUMMARY_API_KEY: "sk-summary-env" }
    });
    expect(cfg.summary.apiKey).toBe("sk-summary-env");
    expect(cfg.openai.apiKey).toBe("sk-test");
  });
});
