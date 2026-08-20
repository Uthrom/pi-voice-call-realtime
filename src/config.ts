import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { ReasoningEffort } from "./types.js";

const E164 = /^\+[1-9]\d{6,14}$/;

const configSchema = z.object({
  twilio: z.object({
    accountSid: z.string().min(1, "twilio.accountSid is required"),
    authToken: z.string().min(1, "twilio.authToken is required"),
    fromNumber: z.string().regex(E164, "fromNumber must be in E.164 format (e.g. +15550001111)")
  }),
  openai: z.object({
    apiKey: z.string().min(1, "openai.apiKey is required"),
    realtimeModel: z.string().default("gpt-realtime"),
    voice: z.string().default("alloy"),
    reasoningEffort: z
      .enum(["minimal", "low", "medium", "high", "xhigh"], {
        errorMap: () => ({ message: "reasoningEffort must be one of: minimal, low, medium, high, xhigh" })
      })
      .optional()
  }),
  summaryModel: z.string().optional(), // legacy alias for summary.model
  summary: z
    .object({
      model: z.string().optional(),
      baseUrl: z.string().optional(),
      apiKey: z.string().optional()
    })
    .default({}),
  serve: z.object({
    controlPort: z.number().default(3335),
    publicPort: z.number().default(3334),
    publicUrl: z.string().optional(),
    tunnel: z.enum(["cloudflared", "ngrok", "none"]).default("cloudflared"),
    controlToken: z
      .string({ required_error: "serve.controlToken is required" })
      .min(1, "serve.controlToken is required")
  }),
  limits: z
    .object({
      maxDurationSec: z.number().default(900),
      maxConcurrentCalls: z.number().default(1),
      dailyCallCap: z.number().default(20)
    })
    .default({}),
  defaults: z
    .object({
      callerIdentity: z.string().default("pi"),
      amdPolicy: z.enum(["leave-message", "hangup"]).default("leave-message")
    })
    .default({})
});

export interface Config {
  home: string; // data dir, default ~/.pi-voice
  twilio: { accountSid: string; authToken: string; fromNumber: string };
  // reasoningEffort: only for 2.1+ realtime models (sent as session
  // reasoning.effort when set; "minimal" recommended for phone calls).
  openai: { apiKey: string; realtimeModel: string; voice: string; reasoningEffort?: ReasoningEffort };
  // Post-call summarization endpoint; any OpenAI-compatible chat-completions
  // server works. All fields resolved at load time: model defaults to
  // "gpt-4o-mini", baseUrl to the official OpenAI API, apiKey to openai.apiKey.
  summary: { model: string; baseUrl: string; apiKey: string };
  serve: {
    controlPort: number; // 3335
    publicPort: number; // 3334
    publicUrl?: string; // static override; when absent tunnel provides it
    tunnel: "cloudflared" | "ngrok" | "none";
    controlToken: string; // required, no default
  };
  limits: { maxDurationSec: number; maxConcurrentCalls: number; dailyCallCap: number };
  defaults: { callerIdentity: string; amdPolicy: "leave-message" | "hangup" };
}

export function loadConfig(opts?: { home?: string; env?: Record<string, string | undefined> }): Config {
  const env = opts?.env ?? process.env;
  const home = opts?.home ?? env.PI_VOICE_HOME ?? join(homedir(), ".pi-voice");

  const configPath = join(home, "config.json");
  const raw: unknown = existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf-8")) : {};

  const withEnvOverlay = applyEnvOverlay(raw, env);

  const result = configSchema.safeParse(withEnvOverlay);
  if (!result.success) {
    const messages = result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
    throw new Error(`Invalid config: ${messages.join("; ")}`);
  }

  const { summaryModel, summary, ...rest } = result.data;
  return {
    home,
    ...rest,
    summary: {
      model: summary.model ?? summaryModel ?? "gpt-4o-mini",
      baseUrl: summary.baseUrl ?? "https://api.openai.com/v1",
      apiKey: summary.apiKey ?? rest.openai.apiKey
    }
  };
}

// Env vars overlay the file config only when set to a non-empty string, so an
// accidentally-blank env var (e.g. `export PI_VOICE_CONTROL_TOKEN=` in a
// wrapper script) falls back to the file value instead of silently wiping
// out a valid credential.
function applyEnvOverlay(raw: unknown, env: Record<string, string | undefined>): unknown {
  const base = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const twilio = (typeof base.twilio === "object" && base.twilio !== null ? base.twilio : {}) as Record<
    string,
    unknown
  >;
  const openai = (typeof base.openai === "object" && base.openai !== null ? base.openai : {}) as Record<
    string,
    unknown
  >;
  const serve = (typeof base.serve === "object" && base.serve !== null ? base.serve : {}) as Record<
    string,
    unknown
  >;
  const summary = (typeof base.summary === "object" && base.summary !== null ? base.summary : {}) as Record<
    string,
    unknown
  >;

  return {
    ...base,
    twilio: {
      ...twilio,
      ...(env.TWILIO_ACCOUNT_SID ? { accountSid: env.TWILIO_ACCOUNT_SID } : {}),
      ...(env.TWILIO_AUTH_TOKEN ? { authToken: env.TWILIO_AUTH_TOKEN } : {})
    },
    openai: {
      ...openai,
      ...(env.OPENAI_API_KEY ? { apiKey: env.OPENAI_API_KEY } : {})
    },
    serve: {
      ...serve,
      ...(env.PI_VOICE_CONTROL_TOKEN ? { controlToken: env.PI_VOICE_CONTROL_TOKEN } : {})
    },
    summary: {
      ...summary,
      ...(env.SUMMARY_API_KEY ? { apiKey: env.SUMMARY_API_KEY } : {})
    }
  };
}
