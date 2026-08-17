# pi Voice-Call Bridge — Phase 1: Outbound Calls (Design Spec)

**Date:** 2026-08-17
**Status:** Draft for review
**Project:** `pi-dialpad-voice-agent-realtime`

## 1. Purpose

Give a locally running [pi](https://pi.dev) agent the ability to place real outbound phone calls and hold natural conversations with the people who answer — scheduling appointments, making reservations, calling vendors — then report the outcome back to the agent.

Architecture and key techniques are ported from the MIT-licensed [TristanBrotherton/openclaw-voice-call-realtime](https://github.com/TristanBrotherton/openclaw-voice-call-realtime) (attribution retained), with pi's SDK/extension API replacing the OpenClaw plugin packaging.

**Phase 1 scope (this spec):** outbound conversation calls via Twilio, initiated from a pi session, running on Dominic's Mac behind a tunnel.

**Explicitly out of scope for Phase 1** (planned later):
- Phase 2: inbound calls (Dialpad Call Router `forward` → this bridge), caller trust tiers, Dialpad-number caller ID verification if not done sooner.
- Phase 3+: in-call `ask_assistant` bridge to a fresh pi session, calendar/Home Assistant integrations, async post-call report push, multi-provider (Telnyx/Plivo).
- Not ported at all: the legacy STT→LLM→TTS "notify" pipeline. "Call and tell them X, then hang up" is implemented as a conversation-mode prompt variant instead.

## 2. Architecture

Two components:

```
┌─────────────────────┐  localhost HTTP   ┌──────────────────────────────┐
│ pi session          │ ────────────────► │ voice-bridge daemon (Node)   │
│  + voice-call.ts    │ ◄──────────────── │  • control API (127.0.0.1)   │
│    extension        │   call result     │  • Twilio REST client        │
└─────────────────────┘                   │  • webhook + media-stream WS │
                                          │  • OpenAI Realtime session   │
                                          │  • transcripts + summaries   │
                                          │  • tunnel manager            │
                                          └──────┬───────────────▲───────┘
                                        TwiML/webhooks     μ-law audio WS
                                                 │               │
                                          ┌──────▼───────────────┴───────┐
                                          │ Twilio ──── PSTN ──── callee │
                                          └──────────────────────────────┘
```

### 2.1 voice-bridge daemon

Long-lived Node/TypeScript (ESM) process. Run via `npm start` during development; launchd unit later. Owns everything with a lifetime longer than a pi session:

- **Control API** — HTTP on `127.0.0.1:<port>` (default 3335). Endpoints: `POST /calls` (initiate), `GET /calls/:id` (status), `GET /calls/:id/transcript`, `POST /calls/:id/end`, `GET /health`. Bearer token auth (random token in config; the pi extension reads the same config). Never exposed through the tunnel.
- **Public webhook surface** — `POST /voice/webhook` (Twilio status callbacks, AMD callbacks, TwiML answer webhook) and `GET /voice/stream` (WebSocket upgrade for Twilio Media Streams). Only these paths are reachable through the tunnel; all other paths on the public listener return 404.
- **Tunnel manager** — ported `tunnel.ts`: auto-start cloudflared (preferred) or ngrok, discover the public URL, use it in TwiML/status-callback URLs. Config may instead supply a static `publicUrl`.

Rationale for a daemon rather than running inside pi's process: calls survive the pi session that started them, the tunnel/webhook URL stays stable, concurrent pi sessions don't fight over ports, and Phase 2 inbound requires an always-on server regardless.

### 2.2 pi extension (`voice-call.ts`)

Loaded from `.pi/extensions/` or `~/.pi/agent/extensions/`. Registers one agent tool:

**`voice_call`** — TypeBox-schema'd, actions:

| Action | Params | Behavior |
|---|---|---|
| `initiate_call` | `to` (E.164), `objective` (what to accomplish), `talking_points[]`, `caller_identity` (who the AI says it's calling for), `voice?`, `max_duration_sec?` | POSTs to daemon; **blocks until the call completes** (poll `GET /calls/:id` every 2s, overall timeout = max duration + 60s), then returns `{outcome, summary, transcript_path, duration, status}`. |
| `get_status` | `call_id?` | Current state of active/most recent call. |
| `get_transcript` | `call_id` | Full transcript text. |
| `end_call` | `call_id` | Hang up now. |

Synchronous initiate is the MVP contract: the pi agent's tool call resolves with the call's outcome, so multi-step tasks ("book a table, then add it to my calendar") flow naturally in one agent turn. pi's `steer` still lets Dominic interject while the tool is waiting.

The extension also registers a `/call-status` command for quick human checks.

## 3. Call flow (happy path)

1. pi agent invokes `voice_call.initiate_call`.
2. Extension → `POST /calls` on the daemon. Daemon validates config/limits (1 concurrent call), creates a call record, generates a per-call stream token.
3. Daemon → Twilio REST `POST /Calls.json`: `To`, `From` (Twilio number or verified caller ID), answer `Url`, `StatusCallback` (initiated/ringing/answered/completed), `Timeout: 30`, async AMD (`MachineDetection: DetectMessageEnd`, `AsyncAmdStatusCallback`).
4. Callee answers → Twilio hits the answer webhook → daemon returns TwiML `<Connect><Stream url="wss://…/voice/stream"><Parameter name="token" …/></Stream></Connect>`.
5. Twilio opens the media WebSocket; daemon validates the stream token, opens the OpenAI Realtime WebSocket (`gpt-realtime`), sends `session.update`: `audio/pcmu` input **and** output (no transcoding), `server_vad` turn detection, voice from config, instructions assembled from objective/talking points/identity/guardrails, in-call tools registered.
6. Audio bridges both directions (base64 μ-law passthrough). Daemon sends an initial `response.create` so the AI speaks first ("Hi, I'm calling on behalf of …").
7. Barge-in: on `input_audio_buffer.speech_started` → `response.cancel` to OpenAI + `clear` event to Twilio.
8. The model conducts the conversation; may call in-call tools (§4).
9. Call ends (model calls `end_call` after goodbye + playout drain via Twilio `mark`; or callee hangs up; or duration cap). Daemon finalizes the transcript, generates a summary + outcome via one cheap LLM call (pi-ai `getModel(...)` with a small model), marks the record complete.
10. Extension poll sees `completed`, returns the result object to the pi agent.

## 4. The voice actor (in-call model)

The realtime model is a tool-poor "voice actor"; the pi agent is the brain that briefed it.

- **System prompt assembly** (`call-brain.ts`, adapted from the reference repo's prompt assembly): identity ("AI assistant calling on behalf of {caller_identity}"), the objective, talking points, honesty rules (must disclose it's an AI if asked), conversational style (concise, phone-appropriate), and hard guardrails (no commitments beyond the objective, no personal data beyond what's provided, wrap up politely if the callee is uninterested).
- **In-call tools** (function calls handled by the daemon):
  - `end_call({reason})` — polite hangup after playout drain.
  - `send_dtmf({digits})` — synthesized μ-law DTMF injected into the stream (ported `dtmf.ts`) for IVR navigation.
  - `note_outcome({outcome, details})` — record structured result (e.g. "reservation confirmed, Thursday 7pm, name Dominic") the moment it's known, so the summary survives even an abrupt hangup.
- **AMD handling:** Twilio async AMD callback → if machine, policy from the initiate params (`amd_policy`: `leave-message` default | `hangup`): leave-message switches the session instructions to deliver a concise voicemail then `end_call`.

## 5. Ported vs. new code

**Ported from openclaw-voice-call-realtime** (file names may be adapted; MIT attribution in LICENSE/NOTICE):

| Source | Purpose | Adaptation |
|---|---|---|
| `providers/twilio.ts` | Twilio REST (initiate, hangup, status, AMD) | Drop transfer/inbound bits for MVP |
| `src/media-stream.ts` | Twilio WS bridge, mark/playout-drain, clear | Near-verbatim |
| `providers/openai-realtime-conversation.ts` | Realtime session, pcmu passthrough, barge-in, tools | Swap tool definitions |
| `providers/managed-realtime-conversation.ts` | Reconnect/backoff, idle & max-session policy | Near-verbatim |
| `src/webhook-security.ts` | Twilio HMAC-SHA1 validation, replay dedupe, proxy URL reconstruction | Slim to Twilio-only |
| `src/dtmf.ts` | μ-law DTMF synthesis | Verbatim |
| `src/tunnel.ts` | cloudflared/ngrok automation | Near-verbatim |
| `src/transcript.ts` | Per-call transcript files | Path change (`~/.pi-voice/transcripts/`) |
| `src/manager/*` (subset) | Call state machine, timers, stale-call reaper | Outbound-only slim-down |
| `providers/mock.ts` | Fake telephony provider | For tests |
| `providers/shared/guarded-json-api.ts` | SSRF-guarded fetch wrapper | Verbatim |

**New code (~1–1.5k LOC):** daemon entry + control API (`server.ts`), pi extension (`voice-call.ts`), prompt assembly (`call-brain.ts`), post-call summarizer (`summary.ts`), Zod config loader (`config.ts`), types.

**Dependencies** (mirroring the reference repo's minimalism): `ws`, `zod`, `@sinclair/typebox`; `@earendil-works/pi-ai` for the summary LLM call; dev: `vitest`, `typescript`, `tsx`. No Twilio SDK. The extension file itself has no deps beyond what pi provides.

## 6. Configuration

`~/.pi-voice/config.json` (Zod-validated) + env fallbacks:

- `twilio`: `accountSid`, `authToken` (env `TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN`), `fromNumber` (the Twilio number; later a verified Dialpad caller ID)
- `openai`: `apiKey` (env `OPENAI_API_KEY`), `realtimeModel` (default `gpt-realtime`), `voice` (default `alloy`), VAD settings
- `summaryModel`: provider/model for post-call summaries (default a small/cheap model)
- `serve`: `controlPort` (3335), `publicPort` (3334), `publicUrl` (optional static), `tunnel` (`cloudflared` | `ngrok` | `none`), control-API bearer token
- `limits`: `maxDurationSec` (900), `maxConcurrentCalls` (1), `dailyCallCap` (20)
- `defaults`: `callerIdentity`, `amdPolicy`

## 7. Error handling

- **No answer / busy / failed:** Twilio status callbacks drive the state machine; tool returns `{status: "no-answer" | "busy" | "failed"}` with no transcript. Ring timeout 30s.
- **AMD machine-detected:** per-call policy (§4).
- **OpenAI WS drop mid-call:** managed reconnect (up to 5 attempts, backoff); callee hears silence during reconnect; if reconnect fails, polite fallback: hang up, mark `interrupted`.
- **Twilio stream drop without terminal callback:** stale-call reaper + disconnect grace (ported) ends phantom calls.
- **Daemon restart mid-call:** call record persisted to disk; on restart, reaper reconciles via Twilio `GET /Calls/:id` and finalizes.
- **Caps:** hard per-call duration cap, concurrency 1, daily call cap — all enforced daemon-side.
- **Extension can't reach daemon:** tool returns an actionable error ("voice-bridge not running — start it with `npm start` in …").

## 8. Security

- Public surface is only `/voice/webhook` + `/voice/stream` through the tunnel; Twilio HMAC-SHA1 signature required on webhooks (replay-deduped); per-call random stream token required on the media WS; connection caps and payload limits ported.
- Control API binds to 127.0.0.1 with bearer token.
- Secrets live in config/env only — never in model prompts. Transcripts stored locally (`~/.pi-voice/`), not logged to stdout by default.
- Outbound-only in Phase 1: inbound webhook variants are rejected.
- The voice actor has no state-changing tools beyond ending its own call and dialing DTMF; it cannot reach pi, JobTread, or any other system in Phase 1.

## 9. Testing

- **Unit (vitest):** ported modules keep their adapted tests (media-stream framing, playout drain, DTMF, webhook security, state machine); new tests for prompt assembly, config, control API, and the extension's poll/timeout logic.
- **Integration:** mock telephony provider + fake Realtime WS server → full call loop without external services (initiate → stream → tool calls → transcript → summary).
- **Live smoke:** `npm run call -- --to <number> --objective "…"` places a real Twilio call (to Dominic's cell) — the manual acceptance test. A `--dry-run` flag prints the would-be Twilio request.

## 10. Milestones (implementation-plan granularity comes next)

1. Project scaffold, config, control API skeleton, ported webhook security. Mock-provider call record lifecycle green.
2. Twilio provider + tunnel + status-callback state machine: real call rings a phone and hangs up.
3. Media stream bridge + Realtime session: two-way conversation on a live call, barge-in working.
4. In-call tools (end_call, DTMF, note_outcome), AMD policy, transcript + summary.
5. pi extension + synchronous initiate flow; end-to-end: prompt pi → phone rings → conversation → outcome lands back in the pi session.
6. Hardening: reaper, reconnects, caps, daily limit; docs (README, setup guide).

## 11. Costs & accounts (Phase 1)

- Twilio: 1 local number (~$1.15/mo) + outbound US voice ~$0.014/min. Optional: verify a Dialpad number as caller ID (free, one verification call).
- OpenAI Realtime (`gpt-realtime`, audio): very roughly $0.20–0.40/min of conversation.
- Cloudflare Tunnel: free.
- Existing: pi (local), OpenAI account, Dialpad (unused until Phase 2 except optional caller ID).
