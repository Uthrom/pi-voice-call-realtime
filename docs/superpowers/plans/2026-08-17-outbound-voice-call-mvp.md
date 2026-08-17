# Outbound Voice-Call MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A locally-run voice-bridge daemon plus a pi extension that lets a pi agent place real outbound phone calls (Twilio Media Streams ↔ OpenAI Realtime, μ-law passthrough) and get the transcript + outcome back as the tool result.

**Architecture:** Standalone Node daemon owns Twilio REST, the public webhook/media-WS surface, the OpenAI Realtime session, transcripts, and the tunnel; a thin pi extension calls the daemon's localhost control API and blocks until the call completes. Core telephony/realtime modules are ported from the MIT-licensed [openclaw-voice-call-realtime](https://github.com/TristanBrotherton/openclaw-voice-call-realtime) and slimmed to outbound-only.

**Tech Stack:** TypeScript (ESM, strict), Node ≥ 20, runtime deps only `ws` + `zod`; dev: `typescript`, `tsx`, `vitest`, `@types/ws`, `@types/node`. No Twilio SDK, no express.

**Spec:** `docs/superpowers/specs/2026-08-17-pi-voice-call-outbound-design.md`

**Execution notes:** Orchestrator + code review = Opus-class model; task implementors = Sonnet (user's directive, 2026-08-17). One deliberate deviation from spec §5: post-call summaries call OpenAI chat-completions directly with `fetch` (same API key as Realtime) instead of adding `@earendil-works/pi-ai` — zero extra deps; the spec has been amended.

## Global Constraints

- Node ≥ 20, `"type": "module"`, TypeScript strict; all imports use `.js` extensions (ESM).
- Runtime dependencies: exactly `ws` and `zod`. The pi extension file may additionally import from pi's own environment (`@sinclair/typebox`).
- Audio is G.711 μ-law 8kHz end-to-end. Never transcode: Twilio `media` payload base64 ↔ Buffer ↔ OpenAI `audio/pcmu` base64. No resampling code anywhere.
- Public HTTP surface is ONLY `POST /voice/webhook` and WS upgrade `GET /voice/stream`; every other path on the public listener returns 404. Control API binds `127.0.0.1` only, requires `Authorization: Bearer <controlToken>`.
- Default ports: public 3334, control 3335. Data dir: `~/.pi-voice/` (override with env `PI_VOICE_HOME` — all tests use a temp dir).
- Limits (config defaults): `maxDurationSec: 900`, `maxConcurrentCalls: 1`, `dailyCallCap: 20`. Ring timeout 30s.
- Secrets (API keys, tokens) never appear in model prompts, transcripts, or logs.
- Ported files keep a header comment: `// Adapted from openclaw-voice-call-realtime (MIT) — https://github.com/TristanBrotherton/openclaw-voice-call-realtime`.
- Reference sources are fetched into `.reference/` (gitignored) via `curl -s https://raw.githubusercontent.com/TristanBrotherton/openclaw-voice-call-realtime/main/<path> -o .reference/<name>`.
- Commit after every task (at minimum); conventional-commit style messages.

---

### Task 1: Project scaffold + config loader

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `src/config.ts`
- Modify: `.gitignore` (append `.reference/` and `.pi-voice/`)
- Test: `test/config.test.ts`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `loadConfig(opts?: { home?: string; env?: Record<string, string | undefined> }): Config` and the `Config` type — used by every later task. Exact shape:

```ts
export interface Config {
  home: string; // data dir, default ~/.pi-voice
  twilio: { accountSid: string; authToken: string; fromNumber: string };
  openai: { apiKey: string; realtimeModel: string; voice: string };
  summaryModel: string; // default "gpt-4o-mini"
  serve: {
    controlPort: number;   // 3335
    publicPort: number;    // 3334
    publicUrl?: string;    // static override; when absent tunnel provides it
    tunnel: "cloudflared" | "ngrok" | "none";
    controlToken: string;  // required, no default
  };
  limits: { maxDurationSec: number; maxConcurrentCalls: number; dailyCallCap: number };
  defaults: { callerIdentity: string; amdPolicy: "leave-message" | "hangup" };
}
```

- [ ] **Step 1: Scaffold package**

`package.json`:

```json
{
  "name": "pi-voice-call-realtime",
  "version": "0.1.0",
  "type": "module",
  "license": "MIT",
  "engines": { "node": ">=20" },
  "scripts": {
    "start": "tsx src/server.ts",
    "build": "tsc",
    "test": "vitest run",
    "call": "tsx scripts/call.ts"
  },
  "dependencies": { "ws": "^8.18.0", "zod": "^3.23.8" },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "@types/ws": "^8.5.10",
    "tsx": "^4.19.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

`tsconfig.json`: `"strict": true`, `"module": "NodeNext"`, `"moduleResolution": "NodeNext"`, `"target": "ES2022"`, `"outDir": "dist"`, `"rootDir": "."`, include `src`, `extension`, `scripts`, `test`. `vitest.config.ts`: default export with `test: { include: ["test/**/*.test.ts"] }`. Append to `.gitignore`: `.reference/` and `.pi-voice/`. Run `npm install`.

- [ ] **Step 2: Write failing config tests**

`test/config.test.ts`:

```ts
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
});
```

- [ ] **Step 3: Run tests — expect FAIL** (`npm test` → cannot resolve `../src/config.js`)

- [ ] **Step 4: Implement `src/config.ts`**

Zod schema mirroring `Config`; `fromNumber` validated with `/^\+[1-9]\d{6,14}$/`; defaults via `.default(...)`; read `<home>/config.json` (missing file → same treatment as `{}` so env-only setups still validate); env overlay for `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `OPENAI_API_KEY`, `PI_VOICE_CONTROL_TOKEN`; `home` resolves from `opts.home ?? env.PI_VOICE_HOME ?? join(os.homedir(), ".pi-voice")`. Wrap ZodError into `Error` with the offending path in the message (so `/controlToken/` matches).

- [ ] **Step 5: Run tests — expect PASS**

- [ ] **Step 6: Commit** — `feat: project scaffold and config loader`

---

### Task 2: Call types + persistent call store

**Files:**
- Create: `src/types.ts`, `src/store.ts`
- Test: `test/store.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces (used by manager, webhook, control API, extension):

```ts
// src/types.ts
export type CallStatus =
  | "queued" | "dialing" | "ringing" | "answered" | "in-progress"
  | "completed" | "no-answer" | "busy" | "failed" | "canceled" | "interrupted";

export const TERMINAL_STATUSES: ReadonlySet<CallStatus>; // completed, no-answer, busy, failed, canceled, interrupted

export type AmdPolicy = "leave-message" | "hangup";

export interface CallParams {
  to: string;
  objective: string;
  talkingPoints: string[];
  callerIdentity: string;
  voice?: string;
  maxDurationSec?: number;
  amdPolicy?: AmdPolicy;
}

export interface CallOutcome { outcome: string; details?: string }

export interface CallRecord {
  id: string;                // crypto.randomUUID()
  providerCallId?: string;   // Twilio CallSid
  params: CallParams;
  status: CallStatus;
  streamToken: string;       // crypto.randomBytes(16).toString("base64url")
  createdAt: string;         // ISO 8601
  answeredAt?: string;
  endedAt?: string;
  amdResult?: "human" | "machine";
  outcome?: CallOutcome;
  summary?: string;
  transcriptPath?: string;
  error?: string;
}

// src/store.ts
export class CallStore {
  constructor(dataDir: string);            // writes <dataDir>/calls/<id>.json
  async save(rec: CallRecord): Promise<void>;
  async get(id: string): Promise<CallRecord | undefined>;
  async findByProviderCallId(sid: string): Promise<CallRecord | undefined>;
  async list(): Promise<CallRecord[]>;     // newest first by createdAt
  async countCreatedToday(now?: Date): Promise<number>; // local-time day window
}
```

- [ ] **Step 1: Write failing tests** — `test/store.test.ts` with a temp dir: save→get round-trip preserves all fields; `get` of unknown id → undefined; `findByProviderCallId` finds after `providerCallId` set + re-save; `list` sorts newest first; `countCreatedToday` counts a just-created record as 1 and a record with `createdAt` shifted to yesterday as 0. (Write the records via the public API; shift dates by constructing the record object directly.)
- [ ] **Step 2: Run — expect FAIL**
- [ ] **Step 3: Implement** — `node:fs/promises`, `mkdir` recursive on first save, atomic write (`writeFile` to `<id>.json.tmp` then `rename`).
- [ ] **Step 4: Run — expect PASS**
- [ ] **Step 5: Commit** — `feat: call record types and persistent store`

---

### Task 3: Call manager state machine

**Files:**
- Create: `src/manager.ts`
- Test: `test/manager.test.ts`

**Interfaces:**
- Consumes: `CallStore`, `CallRecord`, `CallParams`, `TERMINAL_STATUSES` (Task 2); `TelephonyProvider` (defined here, implemented in Task 5).
- Produces:

```ts
// in src/manager.ts (provider contract lives here to avoid a cycle)
export interface TelephonyProvider {
  createCall(opts: {
    to: string; from: string; answerUrl: string;
    statusCallbackUrl: string; amdCallbackUrl: string; timeoutSec: number;
  }): Promise<{ providerCallId: string }>;
  hangupCall(providerCallId: string): Promise<void>;
  getCall(providerCallId: string): Promise<{ status: string }>;
}

export type ProviderCallEvent =
  | { type: "initiated" | "ringing" | "answered"; providerCallId: string }
  | { type: "completed"; providerCallId: string; providerStatus: string } // raw Twilio CallStatus
  | { type: "amd"; providerCallId: string; result: "human" | "machine" };

export class CallManager extends EventEmitter {
  constructor(opts: {
    store: CallStore; provider: TelephonyProvider;
    limits: Config["limits"]; urls: { answerUrl: string; statusCallbackUrl: string; amdCallbackUrl: string };
    fromNumber: string; now?: () => number;
  });
  async initiateCall(params: CallParams): Promise<CallRecord>; // throws CapacityError / DailyCapError
  async handleProviderEvent(evt: ProviderCallEvent): Promise<void>;
  async endCall(id: string, reason: string): Promise<void>;    // provider hangup + finalize
  async finalize(id: string, status: CallStatus, error?: string): Promise<void>;
  getActive(): CallRecord | undefined;                          // in-memory active call
  getByStreamToken(token: string): CallRecord | undefined;
}
// emits: "status" (rec: CallRecord), "answered" (rec), "amd" (rec, result), "ended" (rec)
export class CapacityError extends Error {}
export class DailyCapError extends Error {}
```

Transition map (anything else is ignored with a warn log, never a throw): `queued→dialing` (createCall success), `dialing→ringing→answered→in-progress`, `answered` is set on the `answered` provider event, `in-progress` when the media stream attaches (Task 12 calls `finalize`-adjacent method `markStreaming(id)` — add it: sets `in-progress`). `completed` event maps providerStatus: `completed→completed`, `busy→busy`, `no-answer→no-answer`, `failed→failed`, `canceled→canceled`. Duration timer: on `answered`, `setTimeout(maxDurationSec)` → `endCall(id, "duration-cap")` → status `completed`. Timer cleared on any terminal transition; `unref()` the timer.

- [ ] **Step 1: Write failing tests** — fake provider (`createCall` returns `{providerCallId:"CA1"}`, records hangup calls); fake timers (`vi.useFakeTimers()`). Cases: (a) initiate persists a `dialing` record with streamToken and returns it; (b) second initiate while one active throws `CapacityError`; (c) `countCreatedToday` ≥ cap throws `DailyCapError` (seed store with 20 records); (d) event sequence initiated→ringing→answered→completed lands `completed` with `answeredAt`/`endedAt` set and emits `ended`; (e) `completed` with providerStatus `no-answer` from `ringing` → status `no-answer`; (f) after `answered`, advancing fake time past `maxDurationSec` calls provider `hangupCall` and finalizes; (g) `getByStreamToken` returns the active record and returns undefined after terminal.
- [ ] **Step 2: Run — expect FAIL**
- [ ] **Step 3: Implement `src/manager.ts`** per the map above. Active call tracked in a private field; `initiateCall` sets it, terminal transitions clear it. All transitions `await store.save`.
- [ ] **Step 4: Run — expect PASS**
- [ ] **Step 5: Commit** — `feat: outbound call state machine with caps and duration timer`

---

### Task 4: Twilio webhook signature validation (port)

**Files:**
- Create: `src/webhook-security.ts`
- Reference: `curl -s https://raw.githubusercontent.com/TristanBrotherton/openclaw-voice-call-realtime/main/src/webhook-security.ts -o .reference/webhook-security.ts`
- Test: `test/webhook-security.test.ts`

**Interfaces:**
- Consumes: nothing from our code (pure function + small cache class).
- Produces:

```ts
export function validateTwilioSignature(opts: {
  authToken: string; signature: string | undefined;
  url: string;                       // full public URL as Twilio saw it
  params: Record<string, string>;    // parsed form body
}): boolean;
export class ReplayCache {           // dedupe repeated webhook deliveries
  constructor(ttlMs?: number);       // default 5 min
  seen(key: string): boolean;        // true if already seen (and marks it)
}
export function publicUrlFor(publicUrl: string, path: string): string; // join without double slashes
```

- [ ] **Step 1: Fetch reference file** (command above; `mkdir -p .reference` first).
- [ ] **Step 2: Write failing tests** — compute a valid signature in-test exactly as Twilio does:

```ts
import { createHmac } from "node:crypto";
function sign(authToken: string, url: string, params: Record<string, string>): string {
  const data = url + Object.keys(params).sort().map(k => k + params[k]).join("");
  return createHmac("sha1", authToken).update(data).digest("base64");
}
```

Cases: valid signature accepted; tampered param rejected; missing signature rejected; `ReplayCache.seen` false then true for same key, false again after ttl (fake timers); `publicUrlFor("https://x.example/", "/voice/webhook")` → `"https://x.example/voice/webhook"`.
- [ ] **Step 3: Run — expect FAIL**
- [ ] **Step 4: Port** — from `.reference/webhook-security.ts` take the HMAC-SHA1 construction and replay-dedupe logic; drop OpenClaw config plumbing, proxy-header reconstruction (`trustedProxyIPs`, `allowedHosts`) and multi-provider branches — our tunnel gives us the exact public URL so we validate against `publicUrlFor(config.serve.publicUrl, path)` directly. Keep the attribution header comment.
- [ ] **Step 5: Run — expect PASS**
- [ ] **Step 6: Commit** — `feat: port Twilio signature validation and replay cache`

---

### Task 5: Twilio provider + mock provider (port)

**Files:**
- Create: `src/providers/twilio.ts`, `src/providers/mock.ts`, `src/providers/guarded-json-api.ts`
- Reference: fetch `src/providers/twilio.ts`, `src/providers/mock.ts`, `src/providers/shared/guarded-json-api.ts` from the reference repo into `.reference/`
- Test: `test/twilio-provider.test.ts`

**Interfaces:**
- Consumes: `TelephonyProvider` (Task 3).
- Produces: `class TwilioProvider implements TelephonyProvider` with `constructor(opts: { accountSid: string; authToken: string; fetchImpl?: typeof fetch })`; `class MockProvider implements TelephonyProvider` which records every call in a public `calls: unknown[]` array, returns `providerCallId: "MOCK-1"`-style ids, and exposes `emit`-ready helpers used by Task 12's integration test.

- [ ] **Step 1: Fetch reference files.**
- [ ] **Step 2: Write failing tests** — inject `fetchImpl` capturing requests. Cases: `createCall` POSTs `https://api.twilio.com/2010-04-01/Accounts/ACxxx/Calls.json` with `Authorization: Basic ${base64("ACxxx:tok")}`, form-encoded body containing `To`, `From`, `Url`, `StatusCallback`, `StatusCallbackEvent=initiated ringing answered completed`, `Timeout=30`, `MachineDetection=DetectMessageEnd`, `AsyncAmd=true`, `AsyncAmdStatusCallback`; response `{"sid":"CA123"}` → returns `{providerCallId:"CA123"}`; non-2xx response throws with Twilio error message included; `hangupCall` POSTs `Status=completed` to `/Calls/CA123.json`.
- [ ] **Step 3: Run — expect FAIL**
- [ ] **Step 4: Port** — keep the reference repo's raw-REST approach and its SSRF-guarded fetch wrapper (`guarded-json-api.ts` — port with our error type, keep the "only https, no redirects to private ranges" guards); strip transfer, inbound TwiML, `<Say>` fallback and multi-provider registry. Implement `MockProvider` fresh (~30 lines).
- [ ] **Step 5: Run — expect PASS**
- [ ] **Step 6: Commit** — `feat: port Twilio REST provider; add mock provider`

---

### Task 6: Public webhook server (answer TwiML + status/AMD callbacks)

**Files:**
- Create: `src/webhook.ts`, `src/server.ts` (skeleton)
- Test: `test/webhook.test.ts`

**Interfaces:**
- Consumes: `CallManager` (Task 3), `validateTwilioSignature`/`ReplayCache`/`publicUrlFor` (Task 4), `Config` (Task 1).
- Produces:

```ts
// src/webhook.ts
export function createPublicHandler(deps: {
  manager: CallManager; authToken: string; publicUrl: () => string; replay: ReplayCache;
}): (req: IncomingMessage, res: ServerResponse) => Promise<void>;
// Routes: POST /voice/webhook?kind=answer|status|amd  — everything else 404.

// src/server.ts (this task: assembly only, no realtime wiring yet)
export async function startServer(cfg: Config, overrides?: Partial<Deps>): Promise<{
  close(): Promise<void>; publicServer: http.Server; controlServer: http.Server; manager: CallManager;
}>;
```

Behavior — `kind=answer`: look up record by `CallSid`, respond `content-type: text/xml` with

```xml
<?xml version="1.0" encoding="UTF-8"?>
<Response><Connect><Stream url="wss://HOST/voice/stream"><Parameter name="token" value="TOKEN"/></Stream></Connect></Response>
```

(HOST from `publicUrl()`, TOKEN = record.streamToken; unknown CallSid → `<Response><Hangup/></Response>`). `kind=status`: map `CallStatus` form field → `manager.handleProviderEvent` (`initiated|ringing` → same-named, `in-progress` → `answered`, terminal values → `{type:"completed", providerStatus}`). `kind=amd`: `AnsweredBy` starting with `machine` → `{type:"amd", result:"machine"}`, `human` → `"human"`, others ignored. Invalid signature → 403 before any processing; replayed delivery (key = signature+CallSid+CallStatus) → 200 with no side effects; body size cap 100KB.

- [ ] **Step 1: Write failing tests** — start `startServer` on ephemeral ports (`publicPort: 0`) with `MockProvider` and a temp home; initiate a call through the manager; POST real form bodies with computed valid signatures (reuse `sign()` from Task 4 tests via a small `test/helpers.ts`). Cases: answer TwiML contains the stream URL + token; unknown CallSid → Hangup TwiML; status `in-progress` transitions record to `answered`; bad signature → 403 and record unchanged; `GET /anything` → 404; replayed status POST processed once.
- [ ] **Step 2: Run — expect FAIL**
- [ ] **Step 3: Implement** — plain `node:http`; parse form bodies with `URLSearchParams`; `startServer` wires config→store→manager→handler, control server responds only `GET /health` → `{ok:true}` for now (Task 13 completes it).
- [ ] **Step 4: Run — expect PASS**
- [ ] **Step 5: Commit** — `feat: public webhook server with TwiML answer and status/AMD handling`

---

### Task 7: DTMF synthesis (port)

**Files:**
- Create: `src/dtmf.ts`
- Reference: fetch `src/dtmf.ts` into `.reference/`
- Test: `test/dtmf.test.ts`

**Interfaces:**
- Produces: `generateDtmfMulaw(digits: string, opts?: { toneMs?: number; gapMs?: number }): Buffer` (defaults 120ms tone, 80ms gap, 8kHz μ-law) and `MULAW_SILENCE = 0xff`.

- [ ] **Step 1: Fetch reference file.**
- [ ] **Step 2: Write failing tests** — `generateDtmfMulaw("5")` length = `(120+80) * 8` bytes; `"55"` twice that; tone segment bytes are not all `MULAW_SILENCE` while gap segment bytes are; unknown character throws; empty string → empty Buffer.
- [ ] **Step 3: Run — expect FAIL**
- [ ] **Step 4: Port** (near-verbatim: dual-tone sine synthesis + linear→μ-law encode; keep attribution comment).
- [ ] **Step 5: Run — expect PASS**
- [ ] **Step 6: Commit** — `feat: port DTMF mu-law synthesis`

---

### Task 8: Twilio media-stream bridge (port)

**Files:**
- Create: `src/media-stream.ts`
- Reference: fetch `src/media-stream.ts` into `.reference/`
- Test: `test/media-stream.test.ts`

**Interfaces:**
- Consumes: `ws` (WebSocket server socket).
- Produces:

```ts
export interface MediaStreamHandlers {
  onStart(info: { streamSid: string }): void;
  onAudio(mulaw: Buffer): void;     // caller → AI
  onStop(): void;
}
export class MediaStreamConnection {
  constructor(socket: WebSocket, handlers: MediaStreamHandlers);
  sendAudio(mulaw: Buffer): void;                       // AI → caller (media event)
  sendClear(): void;                                    // flush Twilio playback buffer
  async waitForPlayoutDrained(timeoutMs?: number): Promise<void>; // sendMark + await matching mark event (default 10s)
  close(): void;
  readonly streamSid: string | undefined;
}
```

Twilio wire format handled: incoming `{"event":"connected"}`, `{"event":"start","start":{"streamSid":...}}`, `{"event":"media","media":{"payload":"<base64 mulaw>"}}`, `{"event":"mark","mark":{"name":...}}`, `{"event":"stop"}`; outgoing `{"event":"media","streamSid","media":{"payload"}}`, `{"event":"mark","streamSid","mark":{"name"}}`, `{"event":"clear","streamSid"}`.

- [ ] **Step 1: Fetch reference file.**
- [ ] **Step 2: Write failing tests** — in-process `ws` `WebSocketServer` on an ephemeral port; test client plays the Twilio side. Cases: start event surfaces streamSid and fires `onStart`; media payload reaches `onAudio` as the decoded Buffer; `sendAudio` produces a valid outgoing media frame (client asserts base64 round-trip); `sendClear` frame shape; `waitForPlayoutDrained` resolves when the client echoes the mark name back, rejects/resolves-with-timeout if never echoed (fake timers not needed — use 50ms timeout); `stop` fires `onStop`.
- [ ] **Step 3: Run — expect FAIL**
- [ ] **Step 4: Port** — from `.reference/media-stream.ts` keep frame parsing, mark bookkeeping, and drain logic; strip the OpenClaw session-manager coupling, inbound-call branches, and their provider abstraction (we bind it directly in Task 12).
- [ ] **Step 5: Run — expect PASS**
- [ ] **Step 6: Commit** — `feat: port Twilio media-stream bridge with playout drain`

---

### Task 9: OpenAI Realtime session (port)

**Files:**
- Create: `src/realtime.ts`, `src/managed-realtime.ts`
- Reference: fetch `src/providers/openai-realtime-conversation.ts` and `src/providers/managed-realtime-conversation.ts` into `.reference/`
- Test: `test/realtime.test.ts`

**Interfaces:**
- Consumes: `ws` client.
- Produces:

```ts
export interface RealtimeToolDef { name: string; description: string; parameters: object }
export interface RealtimeCallbacks {
  onAudioDelta(mulaw: Buffer): void;
  onSpeechStarted(): void;                                   // caller barge-in signal
  onTranscript(e: { role: "assistant" | "caller"; text: string }): void;
  onToolCall(e: { name: string; callId: string; args: Record<string, unknown> }): void;
  onClosed(reason: string): void;
}
export class RealtimeSession {
  constructor(opts: {
    apiKey: string; model: string; voice: string; instructions: string;
    tools: RealtimeToolDef[]; callbacks: RealtimeCallbacks; urlOverride?: string;
  });
  async connect(): Promise<void>;      // resolves after session.update acked (session.updated)
  appendAudio(mulaw: Buffer): void;    // input_audio_buffer.append
  createResponse(): void;              // kick off greeting / next reply
  cancelResponse(): void;              // response.cancel
  sendToolResult(callId: string, output: string, respond?: boolean): void;
  updateInstructions(text: string): void; // session.update (AMD voicemail switch)
  close(): void;
  readonly ended: boolean;
}
export class ManagedRealtimeSession { /* same public surface; wraps RealtimeSession with reconnect (5 attempts, exponential backoff from 500ms), idle timeout 120s, max session 2h */ }
```

Session config sent on connect (GA shape, ported): `{type:"session.update", session:{ type:"realtime", output_modalities:["audio"], audio:{ input:{ format:{type:"audio/pcmu"}, turn_detection:{type:"server_vad", threshold:0.5, silence_duration_ms:800} }, output:{ format:{type:"audio/pcmu"}, voice } }, instructions, tools }}`. Events consumed: `response.output_audio.delta` (+ legacy `response.audio.delta`) → `onAudioDelta`; `input_audio_buffer.speech_started` → `onSpeechStarted`; `response.output_item.done` with `item.type==="function_call"` → `onToolCall(JSON.parse(item.arguments))`; `conversation.item.input_audio_transcription.completed` → caller transcript; `response.output_audio_transcript.done` (+ legacy `response.audio_transcript.done`) → assistant transcript. Tool result: `conversation.item.create` `{type:"function_call_output", call_id, output}` then `response.create` unless `respond === false`.

- [ ] **Step 1: Fetch reference files.**
- [ ] **Step 2: Write failing tests** — fake Realtime server: `WebSocketServer` that on connect asserts the `Authorization` header, replies `session.updated` to `session.update`, then scripts events. Cases: `connect()` resolves only after `session.updated`; session.update carries `audio/pcmu` in both directions and our tools; `appendAudio` frames base64 correctly; scripted `response.output_audio.delta` reaches `onAudioDelta` decoded; scripted `input_audio_buffer.speech_started` fires `onSpeechStarted` and a subsequent `cancelResponse()` sends `response.cancel`; scripted function_call item fires `onToolCall` with parsed args and `sendToolResult` emits `function_call_output` + `response.create`; server close fires `onClosed`. ManagedRealtimeSession: first connect fails (server refuses once) → reconnects and succeeds (assert 2 connection attempts).
- [ ] **Step 3: Run — expect FAIL**
- [ ] **Step 4: Port** — keep event handling incl. legacy fallbacks and reconnect/backoff policy; strip OpenClaw config indirection and their in-call tool definitions (ours arrive from Task 10). Default URL `wss://api.openai.com/v1/realtime?model=<model>`, header `Authorization: Bearer <apiKey>`.
- [ ] **Step 5: Run — expect PASS**
- [ ] **Step 6: Commit** — `feat: port OpenAI Realtime session with managed reconnect`

---

### Task 10: Call brain — prompt assembly + in-call tools

**Files:**
- Create: `src/call-brain.ts`
- Test: `test/call-brain.test.ts`

**Interfaces:**
- Consumes: `CallParams`, `CallRecord`, `CallOutcome` (Task 2), `RealtimeToolDef` (Task 9), `generateDtmfMulaw` (Task 7).
- Produces:

```ts
export function buildInstructions(params: CallParams, opts?: { voicemail?: boolean }): string;
export function inCallTools(): RealtimeToolDef[]; // end_call, send_dtmf, note_outcome
export interface ToolActions {
  endCall(reason: string): Promise<void>;
  sendDtmf(digits: string): void;                  // injects synthesized audio into media stream
  noteOutcome(outcome: CallOutcome): void;
}
export function handleToolCall(
  e: { name: string; callId: string; args: Record<string, unknown> },
  actions: ToolActions
): Promise<{ output: string; respond: boolean }>;  // end_call → respond:false
```

`buildInstructions` includes, in order: role ("You are a voice assistant making a phone call on behalf of {callerIdentity}"), the objective verbatim, numbered talking points, behavior rules (concise spoken sentences; disclose being an AI assistant if asked directly; never invent commitments beyond the objective; if the person is uninterested or asks to stop, wrap up politely and call `end_call`; when the objective is resolved call `note_outcome` immediately, then say goodbye and call `end_call`), and with `voicemail: true` a replacement closing section: leave one concise voicemail covering the objective and a callback name, then `end_call`. It must never contain API keys or config values.

- [ ] **Step 1: Write failing tests** — instructions contain identity, objective, each talking point, and the AI-disclosure rule; voicemail variant mentions leaving a message and omits the conversational back-and-forth section; `inCallTools()` returns the three tools with JSON-schema `parameters` (assert `end_call.parameters.properties.reason.type === "string"` etc.); `handleToolCall` dispatch: `end_call` → calls `actions.endCall` and returns `respond: false`; `send_dtmf` with `{digits:"1"}` → `actions.sendDtmf("1")`, respond true; `note_outcome` → `actions.noteOutcome({outcome, details})`, output `"noted"`; unknown tool → output contains `"unknown tool"`, respond true, no action called; malformed args (missing `digits`) → error output, no throw.
- [ ] **Step 2: Run — expect FAIL**
- [ ] **Step 3: Implement** (~120 lines, pure functions).
- [ ] **Step 4: Run — expect PASS**
- [ ] **Step 5: Commit** — `feat: voice-actor prompt assembly and in-call tool handling`

---

### Task 11: Transcript store + post-call summarizer

**Files:**
- Create: `src/transcript.ts`, `src/summary.ts`
- Test: `test/transcript.test.ts`, `test/summary.test.ts`

**Interfaces:**
- Consumes: `CallRecord` (Task 2), `Config` (Task 1).
- Produces:

```ts
// transcript.ts — markdown file per call at <home>/transcripts/<callId>.md
export class TranscriptWriter {
  constructor(dataDir: string, callId: string, meta: { to: string; objective: string });
  add(role: "assistant" | "caller" | "system", text: string): void; // buffered
  async flush(): Promise<string>;   // writes file, returns absolute path
  get entries(): ReadonlyArray<{ role: string; text: string; at: string }>;
}
// summary.ts
export async function summarizeCall(opts: {
  apiKey: string; model: string;
  objective: string; transcript: string; notedOutcome?: CallOutcome;
  fetchImpl?: typeof fetch;
}): Promise<{ outcome: string; summary: string }>;
```

`summarizeCall` POSTs `https://api.openai.com/v1/chat/completions` with `response_format: {type:"json_object"}`, a system prompt ("Summarize this phone call against its objective; reply as JSON {\"outcome\": one short line, \"summary\": 2-4 sentences}"), and the transcript (truncated to 12,000 chars). If `notedOutcome` exists it is passed in the prompt and echoed as `outcome` on API failure; with neither, API failure returns `{outcome:"unknown", summary:"Summary unavailable: <error>"}` — it never throws.

- [ ] **Step 1: Write failing tests** — TranscriptWriter: entries accumulate with timestamps; `flush` writes markdown containing meta header + `**assistant:**`/`**caller:**` lines; flush on empty transcript still writes a file noting "no conversation". summarizeCall: stub fetch asserting model/messages/response_format and returning a JSON body → parsed result; API 500 with notedOutcome → outcome preserved, summary mentions failure; API 500 without → `outcome: "unknown"`.
- [ ] **Step 2: Run — expect FAIL**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run — expect PASS**
- [ ] **Step 5: Commit** — `feat: transcript writer and post-call summarizer`

---

### Task 12: Full call loop wiring (mock integration)

**Files:**
- Modify: `src/server.ts` (wire media WS upgrade → bridge → realtime → brain → transcript → summary)
- Create: `src/call-session.ts`
- Test: `test/call-loop.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 3–11.
- Produces:

```ts
// src/call-session.ts — one instance per answered call; the composition root of the audio path
export class CallSession {
  constructor(deps: {
    record: CallRecord; manager: CallManager; media: MediaStreamConnection;
    realtimeFactory: (opts: ConstructorParameters<typeof RealtimeSession>[0]) => ManagedRealtimeSession | RealtimeSession;
    config: Config; summarize: typeof summarizeCall;
  });
  async run(): Promise<void>; // resolves when the call is fully finalized
}
```

Wiring inside `CallSession.run()` / `server.ts`:
1. `server.ts` handles `upgrade` on `/voice/stream`, validates `?token`/`<Parameter>` via `manager.getByStreamToken` (invalid → socket destroy), constructs `MediaStreamConnection` + `CallSession`, calls `manager.markStreaming(id)`.
2. Realtime session created with `buildInstructions(record.params)` + `inCallTools()`; on connect, `createResponse()` so the AI greets first.
3. Handler graph: `media.onAudio → rt.appendAudio`; `rt.onAudioDelta → media.sendAudio`; `rt.onSpeechStarted → rt.cancelResponse() + media.sendClear()` — suppressed while ending; `rt.onTranscript → transcript.add`; `rt.onToolCall → handleToolCall` with actions: `endCall` = set ending mode → `rt` stops cancelling → `media.waitForPlayoutDrained()` → `manager.endCall(id, reason)`; `sendDtmf` = `media.sendAudio(generateDtmfMulaw(digits))`; `noteOutcome` = stored on record.
4. AMD: `manager.on("amd")` — machine + policy `hangup` → `manager.endCall`; machine + `leave-message` → `rt.updateInstructions(buildInstructions(params, {voicemail:true}))` + `createResponse()`.
5. Teardown (from either side: `media.onStop`, `rt.onClosed`, or manager `ended`): flush transcript, `summarizeCall` (config key/model, noted outcome), save summary/outcome/transcriptPath on the record, finalize status if not already terminal (stream died without callback → `interrupted`).

- [ ] **Step 1: Write failing integration test** — boot `startServer` with `MockProvider`, `realtimeFactory` pointed at the Task 9 fake server via `urlOverride`, summarizer fetch stubbed, temp home, ports 0. Script: initiate call → simulate Twilio: POST status `in-progress` (signed) → open a WS client to `/voice/stream` with the record's token, send `start` + a few `media` frames → fake realtime replies scripted audio delta + transcript + `note_outcome` + `end_call` function calls → assert: client received media frames back, then a `clear`-free ordered goodbye (mark → drain), WS closes, record ends `completed` with `outcome.outcome === "reservation confirmed"`, transcript file exists and contains the scripted lines, summary saved. Second case: WS opened with a bad token is destroyed before any frame. Third: simulate AMD `machine` with policy `hangup` → record ends without realtime traffic.
- [ ] **Step 2: Run — expect FAIL**
- [ ] **Step 3: Implement `call-session.ts` + server wiring.**
- [ ] **Step 4: Run — expect PASS** (this is the milestone-3/4 gate: the whole loop works without external services)
- [ ] **Step 5: Commit** — `feat: end-to-end call session wiring with mock integration test`

---

### Task 13: Control API (initiate/status/transcript/end)

**Files:**
- Create: `src/control-api.ts`
- Modify: `src/server.ts` (mount full control handler)
- Test: `test/control-api.test.ts`

**Interfaces:**
- Consumes: `CallManager`, `CallStore`, `Config`.
- Produces (JSON over `127.0.0.1:<controlPort>`, all requests need `Authorization: Bearer <controlToken>`):
  - `POST /calls` body `CallParams` → 201 `CallRecord`; 409 `{error:"call-in-progress"}` on `CapacityError`; 429 `{error:"daily-cap-reached"}` on `DailyCapError`; 400 zod-validation message.
  - `GET /calls/:id` → `CallRecord` | 404. `GET /calls/active` → active record | 204.
  - `GET /calls/:id/transcript` → `text/markdown` file contents | 404 if none yet.
  - `POST /calls/:id/end` → 200 after `manager.endCall(id, "operator")`.
  - `GET /health` → `{ok:true, activeCall: string | null, publicUrl: string | null}` (health is the ONLY unauthenticated route).

- [ ] **Step 1: Write failing tests** — boot server (mock provider, temp home); cases: missing/wrong bearer → 401 (except /health); POST /calls validates body (missing objective → 400 naming the field); happy initiate → 201 with id + status `dialing`; second initiate → 409; GET unknown id → 404; end → record terminal; daily cap seeded → 429.
- [ ] **Step 2: Run — expect FAIL**
- [ ] **Step 3: Implement** — zod schema for `CallParams` (E.164 `to`, non-empty `objective`, `talkingPoints` default `[]`, `callerIdentity` default from config).
- [ ] **Step 4: Run — expect PASS**
- [ ] **Step 5: Commit** — `feat: localhost control API`

---

### Task 14: Tunnel automation + daemon entrypoint

**Files:**
- Create: `src/tunnel.ts`
- Reference: fetch `src/tunnel.ts` into `.reference/`
- Modify: `src/server.ts` (resolve public URL at startup; log a startup banner)
- Test: `test/tunnel.test.ts`

**Interfaces:**
- Produces:

```ts
export interface Tunnel { url: string; close(): Promise<void> }
export async function resolvePublicUrl(cfg: Config, spawnImpl?: typeof spawn): Promise<{ url: string; tunnel?: Tunnel }>;
// cfg.serve.publicUrl set → returned as-is (validated https). tunnel:"none" without publicUrl → throws with setup guidance.
// "cloudflared": spawn `cloudflared tunnel --url http://127.0.0.1:<publicPort>`, parse the https://*.trycloudflare.com URL from stderr (120s timeout).
// "ngrok": spawn `ngrok http <publicPort> --log stdout --log-format json`, parse the public url line.
```

- [ ] **Step 1: Fetch reference file.**
- [ ] **Step 2: Write failing tests** — static publicUrl passthrough; `tunnel:"none"` + no publicUrl → throws mentioning `publicUrl`; cloudflared: fake `spawnImpl` returning a ChildProcess-like EventEmitter that writes a trycloudflare URL line to stderr → resolved url; process exiting before a URL → rejects with the captured output; http (non-https) publicUrl → throws.
- [ ] **Step 3: Run — expect FAIL**
- [ ] **Step 4: Port/implement** — adapt `.reference/tunnel.ts` spawn/parse logic to the interface above; `server.ts` main() (guarded by `import.meta.url` check): loadConfig → resolvePublicUrl → startServer → banner with public URL, control port, from-number; SIGINT/SIGTERM → close tunnel + servers, finalize any active call as `interrupted`.
- [ ] **Step 5: Run — expect PASS**
- [ ] **Step 6: Commit** — `feat: tunnel automation and daemon entrypoint`

---

### Task 15: pi extension (`voice_call` tool)

**Files:**
- Create: `extension/client.ts` (testable logic), `extension/voice-call.ts` (pi wiring)
- Test: `test/extension-client.test.ts`

**Interfaces:**
- Consumes: control API contract (Task 13), `CallParams`/`CallRecord` shapes (duplicated as local types in `extension/client.ts` — the extension must be loadable standalone by pi with no import from `src/`).
- Produces:

```ts
// extension/client.ts
export interface VoiceCallResult {
  status: string; outcome?: string; details?: string; summary?: string;
  durationSec?: number; transcriptPath?: string; error?: string;
}
export class VoiceBridgeClient {
  constructor(opts: { baseUrl: string; token: string; fetchImpl?: typeof fetch; sleepImpl?: (ms: number) => Promise<void> });
  async initiateAndWait(params: CallParamsInput, opts?: { pollMs?: number; overallTimeoutMs?: number }): Promise<VoiceCallResult>;
  async getStatus(callId?: string): Promise<CallRecordLike | undefined>;
  async getTranscript(callId: string): Promise<string>;
  async endCall(callId: string): Promise<void>;
  async health(): Promise<{ ok: boolean } | undefined>;   // undefined when daemon unreachable
}
```

`initiateAndWait`: POST /calls; poll GET /calls/:id every `pollMs` (default 2000) until `TERMINAL_STATUSES`-equivalent set; overall timeout default `maxDurationSec*1000 + 60_000` → then POST end + return `{status:"interrupted", error:"client-timeout"}`. Daemon unreachable on initiate → throw `Error("voice-bridge daemon not reachable at <baseUrl> — start it with 'npm start' in the pi-voice-call-realtime directory")`.

`extension/voice-call.ts`: default-export `(pi) => { ... }` registering tool `voice_call` (TypeBox schema: `action` enum `initiate_call|get_status|get_transcript|end_call`; params per spec §2.2) and command `/call-status`. Reads `~/.pi-voice/config.json` for controlPort/controlToken (same file the daemon uses). `initiate_call` returns the `VoiceCallResult` as pretty-printed JSON text; errors return as tool error text, never throws through pi.

- [ ] **Step 1: Write failing tests for `VoiceBridgeClient`** — stubbed fetch + instant sleep: initiate 201 then polls `dialing→answered→completed` → result carries summary/outcome/duration (computed from `answeredAt`/`endedAt`); 409 → error result `call-in-progress` without polling; poll timeout path calls end and returns `interrupted`; connection refused (fetch rejects `ECONNREFUSED`) → the actionable error message; `health()` undefined on refusal.
- [ ] **Step 2: Run — expect FAIL**
- [ ] **Step 3: Implement both files.** (`voice-call.ts` is thin wiring over the client; it is exercised live in Task 16, not unit-tested.)
- [ ] **Step 4: Run — expect PASS**
- [ ] **Step 5: Commit** — `feat: pi extension exposing voice_call tool`

---

### Task 16: Smoke-test CLI + docs

**Files:**
- Create: `scripts/call.ts`
- Modify: `README.md` (replace status section with real setup + usage), `docs/superpowers/specs/2026-08-17-pi-voice-call-outbound-design.md` (§5 dependency note, if not already amended)
- Test: manual (this task has no new unit tests; full suite must stay green)

**Interfaces:**
- Consumes: `VoiceBridgeClient` (Task 15).

- [ ] **Step 1: Implement `scripts/call.ts`** — args `--to <E.164> --objective <text> [--talking-point <text> ...] [--identity <text>] [--dry-run]`; loads config for token/port; `--dry-run` prints the would-be POST body and exits 0 without calling; otherwise runs `initiateAndWait` printing status transitions as they change and the final result JSON. Exit 1 with the actionable message when the daemon is down.
- [ ] **Step 2: Verify dry-run** — `npm run call -- --to +15555550100 --objective "test" --dry-run` prints the JSON body; full `npm test` green; `npm run build` clean.
- [ ] **Step 3: Rewrite README** — sections: What is this (2 paragraphs + architecture diagram from spec §2), Prerequisites (Twilio account + number, OpenAI key, cloudflared, Node 20, pi), Setup (`~/.pi-voice/config.json` full example with placeholder creds), Running the daemon, Installing the pi extension (symlink `extension/voice-call.ts` into `~/.pi/agent/extensions/`), Smoke test (the `npm run call` line, noting it places a real billable call), Limits & safety defaults, Credits (openclaw-voice-call-realtime, MIT), Roadmap (Phase 2 Dialpad inbound).
- [ ] **Step 4: Commit** — `feat: smoke-test CLI and setup docs` — and push.

---

## Self-Review (completed at planning time)

1. **Spec coverage:** §2.1 daemon → Tasks 6, 13, 14; §2.2 extension → Task 15; §3 call flow → Tasks 3, 5, 6, 8, 9, 12; §4 voice actor/AMD → Tasks 10, 12; §5 port inventory → Tasks 4, 5, 7, 8, 9, 14 (reference-repo manager/transcript logic folded into fresh Tasks 3/11 where our slimmed shape diverges enough that porting exceeds rewriting); §6 config → Task 1; §7 error handling → Tasks 3 (caps/timer), 9 (reconnect), 12 (interrupted/teardown), 15 (daemon-unreachable); §8 security → Tasks 4, 6, 13 (token-gated WS, 404 surface, bearer auth, secret hygiene in Task 10 prompt rules); §9 testing → per-task TDD + Task 12 integration + Task 16 smoke; §10 milestones 1–6 map to Tasks 1–3 / 4–6 / 7–9 / 10–12 / 13–15 / 16; §11 needs no code.
2. **Placeholder scan:** clean — every step names exact files, commands, and behavior; ported files carry explicit keep/strip lists and locked target export signatures.
3. **Type consistency:** `TelephonyProvider`/`ProviderCallEvent` defined once (Task 3) and consumed by Tasks 5, 6, 12; `RealtimeToolDef`/callbacks defined in Task 9, consumed by 10, 12; `CallRecord`/`CallParams` from Task 2 everywhere; extension deliberately re-declares wire types locally (documented in Task 15).
