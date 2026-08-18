// pi extension entrypoint — loaded standalone by pi (via jiti) from
// `.pi/extensions/` or `~/.pi/agent/extensions/`, independent of this repo's
// own module graph. Must import NOTHING from `src/`; the wire types it needs
// are re-declared locally in `./client.js` (same isolation rule, documented
// there). `@sinclair/typebox` is the one exception — pi's own environment
// provides it at load time, which is why it's a devDependency here (for
// local type-checking/tests) rather than a runtime `dependency` of this
// package (global-constraints.md: runtime deps are exactly `ws` and `zod`).
//
// This file is deliberately thin: every bit of actual logic (polling,
// timeout handling, error-message mapping, result shaping) lives in
// `VoiceBridgeClient` (./client.ts), which is unit-tested. This file is
// wiring only, exercised live by loading it into a real pi session — there
// is no unit test for it.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Type, type Static } from "@sinclair/typebox";
import { VoiceBridgeClient, type CallParamsInput } from "./client.js";

const voiceCallParams = Type.Object({
  action: Type.Union(
    [
      Type.Literal("initiate_call"),
      Type.Literal("get_status"),
      Type.Literal("get_transcript"),
      Type.Literal("end_call")
    ],
    { description: "Which voice_call operation to perform." }
  ),
  to: Type.Optional(
    Type.String({ description: "Destination phone number in E.164 format, e.g. +15550001111 (initiate_call)." })
  ),
  objective: Type.Optional(Type.String({ description: "What the call should accomplish (initiate_call)." })),
  talking_points: Type.Optional(
    Type.Array(Type.String(), { description: "Key points the AI should raise during the call (initiate_call)." })
  ),
  caller_identity: Type.Optional(
    Type.String({ description: "Who the AI says it's calling on behalf of (initiate_call)." })
  ),
  voice: Type.Optional(Type.String({ description: "Realtime voice override (initiate_call)." })),
  max_duration_sec: Type.Optional(Type.Number({ description: "Hard cap on call length in seconds (initiate_call)." })),
  call_id: Type.Optional(
    Type.String({ description: "Call id — optional for get_status, required for get_transcript/end_call." })
  )
});

type VoiceCallToolInput = Static<typeof voiceCallParams>;

// Minimal structural shape of the pi extension API this file actually
// touches (tool + command registration). Not the full pi SDK surface — pi's
// real extension-context object satisfies this structurally, which is all
// TypeScript needs here.
interface PiToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

interface PiExtensionApi {
  tool(def: {
    name: string;
    description: string;
    parameters: typeof voiceCallParams;
    execute: (input: VoiceCallToolInput) => Promise<PiToolResult>;
  }): void;
  command(def: { name: string; description: string; execute: () => Promise<PiToolResult> }): void;
}

interface VoiceExtensionConfig {
  controlPort: number;
  controlToken: string;
}

const DEFAULT_CONTROL_PORT = 3335; // mirrors config.ts's serve.controlPort default

/**
 * Reads `~/.pi-voice/config.json` (the same file the daemon loads via
 * `loadConfig()`) for just the two fields this extension needs. Read lazily
 * — called from inside each tool/command's `execute`, never at module load —
 * so a missing/invalid config surfaces as a friendly tool error on first use
 * rather than an extension that fails to load at all.
 */
function readVoiceConfig(env: NodeJS.ProcessEnv = process.env): VoiceExtensionConfig {
  const home = env.PI_VOICE_HOME ?? join(homedir(), ".pi-voice");
  const configPath = join(home, "config.json");

  if (!existsSync(configPath)) {
    throw new Error(
      `voice-call config not found at ${configPath} — set up and start the voice-bridge daemon first (see README)`
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(configPath, "utf-8"));
  } catch (err) {
    throw new Error(`voice-call config at ${configPath} is not valid JSON: ${errorMessage(err)}`);
  }

  const serve =
    typeof raw === "object" && raw !== null
      ? ((raw as Record<string, unknown>).serve as Record<string, unknown> | undefined)
      : undefined;
  const controlToken = typeof serve?.controlToken === "string" ? serve.controlToken : undefined;
  if (!controlToken) {
    throw new Error(`voice-call config at ${configPath} is missing serve.controlToken`);
  }
  const controlPort = typeof serve?.controlPort === "number" ? serve.controlPort : DEFAULT_CONTROL_PORT;

  return { controlPort, controlToken };
}

function clientFromConfig(): VoiceBridgeClient {
  const cfg = readVoiceConfig();
  // Control API binds 127.0.0.1 only (global-constraints.md) — never routed
  // through the tunnel.
  return new VoiceBridgeClient({ baseUrl: `http://127.0.0.1:${cfg.controlPort}`, token: cfg.controlToken });
}

function textResult(text: string): PiToolResult {
  return { content: [{ type: "text", text }] };
}

function errorResult(err: unknown): PiToolResult {
  return { content: [{ type: "text", text: errorMessage(err) }], isError: true };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function runVoiceCallAction(client: VoiceBridgeClient, input: VoiceCallToolInput): Promise<string> {
  switch (input.action) {
    case "initiate_call": {
      if (!input.to || !input.objective) {
        throw new Error("initiate_call requires 'to' and 'objective'");
      }
      const params: CallParamsInput = {
        to: input.to,
        objective: input.objective,
        talkingPoints: input.talking_points ?? [],
        callerIdentity: input.caller_identity,
        voice: input.voice,
        maxDurationSec: input.max_duration_sec
      };
      const result = await client.initiateAndWait(params);
      return JSON.stringify(result, null, 2);
    }
    case "get_status": {
      const rec = await client.getStatus(input.call_id);
      return rec ? JSON.stringify(rec, null, 2) : "No active or recent call.";
    }
    case "get_transcript": {
      if (!input.call_id) {
        throw new Error("get_transcript requires 'call_id'");
      }
      return await client.getTranscript(input.call_id);
    }
    case "end_call": {
      if (!input.call_id) {
        throw new Error("end_call requires 'call_id'");
      }
      await client.endCall(input.call_id);
      return `Call ${input.call_id} ended.`;
    }
  }
}

export default function registerVoiceCallExtension(pi: PiExtensionApi): void {
  pi.tool({
    name: "voice_call",
    description:
      "Place and manage outbound phone calls through the local voice-bridge daemon. " +
      "initiate_call blocks until the call completes and returns its outcome.",
    parameters: voiceCallParams,
    execute: async (input) => {
      try {
        const client = clientFromConfig();
        const text = await runVoiceCallAction(client, input);
        return textResult(text);
      } catch (err) {
        return errorResult(err);
      }
    }
  });

  pi.command({
    name: "call-status",
    description: "Show the status of the active or most recent outbound call.",
    execute: async () => {
      try {
        const client = clientFromConfig();
        const rec = await client.getStatus();
        return textResult(rec ? JSON.stringify(rec, null, 2) : "No active or recent call.");
      } catch (err) {
        return errorResult(err);
      }
    }
  });
}
