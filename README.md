# pi-voice-call-realtime

## What is this

`pi-voice-call-realtime` gives a locally running [pi](https://pi.dev) coding agent the ability to place real outbound phone calls. Ask pi to book a table, chase a vendor, or confirm an appointment, and it dials out through Twilio, holds a natural voice conversation via the OpenAI Realtime API, and reports the transcript and outcome back into the pi session — all from one agent tool call.

The system is two long-lived pieces working together: a **voice-bridge daemon** that owns the Twilio REST client, the public webhook/media-stream surface, the OpenAI Realtime session, and transcripts; and a thin **pi extension** that registers a `voice_call` tool and talks to the daemon over a localhost control API. The daemon outlives any single pi session, so calls survive session restarts and the public webhook URL stays stable. Core telephony/media techniques (Twilio Media Streams framing, μ-law DTMF, tunnel automation) are ported from the MIT-licensed [openclaw-voice-call-realtime](https://github.com/TristanBrotherton/openclaw-voice-call-realtime) by Tristan Brotherton — see [Credits](#credits).

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

Full design rationale (call flow, error handling, security model) lives in the [Phase 1 design spec](docs/superpowers/specs/2026-08-17-pi-voice-call-outbound-design.md).

## Prerequisites

- A **Twilio account** with a phone number capable of outbound voice, and its Account SID + Auth Token.
- An **OpenAI API key** with access to the Realtime API (`gpt-realtime`).
- **[cloudflared](https://developers.cloudflare.com/cloudflared/downloads/)** on `PATH` (the default tunnel provider — see `serve.tunnel` below for alternatives).
- **Node.js ≥ 20**.
- **[pi](https://pi.dev)** installed, with extension support (`~/.pi/agent/extensions/`).

## Setup

Clone the repo and install dependencies:

```bash
git clone <this-repo-url> pi-voice-call-realtime
cd pi-voice-call-realtime
npm install
```

Create `~/.pi-voice/config.json` (override the location with env var `PI_VOICE_HOME`). Every value below is a placeholder — replace with your own real credentials, never commit real ones:

```json
{
  "twilio": {
    "accountSid": "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    "authToken": "your_twilio_auth_token_here",
    "fromNumber": "+15555550100"
  },
  "openai": {
    "apiKey": "sk-proj-REPLACE_WITH_YOUR_OPENAI_API_KEY",
    "realtimeModel": "gpt-realtime",
    "voice": "alloy"
  },
  "summaryModel": "gpt-4o-mini",
  "serve": {
    "controlPort": 3335,
    "publicPort": 3334,
    "tunnel": "cloudflared",
    "controlToken": "REPLACE_WITH_A_LONG_RANDOM_TOKEN"
  },
  "limits": {
    "maxDurationSec": 900,
    "maxConcurrentCalls": 1,
    "dailyCallCap": 20
  },
  "defaults": {
    "callerIdentity": "pi",
    "amdPolicy": "leave-message"
  }
}
```

Generate `serve.controlToken` with something like:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Notes:
- `twilio.accountSid` / `twilio.authToken` and `openai.apiKey` can instead be supplied via env vars `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `OPENAI_API_KEY`, which override the file when set to a non-empty value.
- `serve.tunnel` can be `"cloudflared"` (default), `"ngrok"`, or `"none"` (in which case set `serve.publicUrl` to a static HTTPS URL you manage yourself, e.g. a reverse proxy).
- **The zero-setup default (`"cloudflared"` quick tunnel) works.** One machine-local gotcha: your OS resolver can negative-cache a fresh trycloudflare hostname before its DNS record lands, making the tunnel look dead *from the machine running it* while Twilio (which uses its own resolvers) reaches it fine. The daemon's boot-time readiness probe therefore resolves via public DNS (1.1.1.1/8.8.8.8) and prints `tunnel verified reachable` on success; if you see the probe-timeout warning instead, the tunnel may still be fine — but a daemon restart gets you a fresh hostname if calls fail. For an always-stable URL that survives restarts, a named Cloudflare Tunnel (needs a domain on Cloudflare) is a nice upgrade:
  ```bash
  cloudflared tunnel login                       # pick your zone in the browser
  cloudflared tunnel create pi-voice
  cloudflared tunnel route dns pi-voice voice.yourdomain.com
  # ~/.cloudflared/config.yml:
  #   tunnel: <tunnel-id>
  #   credentials-file: /Users/you/.cloudflared/<tunnel-id>.json
  #   protocol: http2
  #   ingress:
  #     - hostname: voice.yourdomain.com
  #       service: http://127.0.0.1:3334
  #     - service: http_status:404
  cloudflared tunnel run pi-voice                # keep running (launchd/tmux)
  ```
  Then set `"tunnel": "none"` and `"publicUrl": "https://voice.yourdomain.com"` in `~/.pi-voice/config.json`. Twilio gets a stable URL that survives daemon restarts.
- `limits`, `defaults`, and both ports all have the defaults shown above if omitted — the file only needs `twilio`, `openai`, and `serve.controlToken`.

## Running the daemon

```bash
npm start
```

This starts the control API on `127.0.0.1:<controlPort>` (loopback only, bearer-token authed), the public listener on `<publicPort>` (only `POST /voice/webhook` and the `/voice/stream` WebSocket upgrade — every other path 404s), and auto-starts the configured tunnel. On success it prints a startup banner with the public URL and both ports (never any secret). Keep it running in a terminal, a `tmux`/`screen` session, or under a process supervisor — it's meant to outlive any single pi session.

## Installing the pi extension

Register the extension **by its absolute path** in `~/.pi/agent/settings.json` (add the `"extensions"` key alongside whatever is already there):

```json
{
  "extensions": [
    "/absolute/path/to/pi-voice-call-realtime/extension/voice-call.ts"
  ]
}
```

Do **not** symlink or copy the file into `~/.pi/agent/extensions/` — pi's loader resolves the extension's relative `./client.js` import against the file's apparent location, so a symlinked copy fails at startup with `Cannot find module './client.js'` (observed on pi 0.84.2). Registering the real path keeps both the relative import and the `@sinclair/typebox` import (resolved through this repo's `node_modules`, per pi's parent-`package.json` rule) working.

Restart pi and it will pick up a `voice_call` tool and a `/call-status` command. Both read `~/.pi-voice/config.json` for the control-API token/port, so they only work once the daemon is running (see above). For a quick one-off test without touching settings, `pi -e /absolute/path/to/extension/voice-call.ts` works too.

## Smoke test

> **Cost warning:** running this without `--dry-run` places a real, billable Twilio phone call and consumes OpenAI Realtime API usage for the duration of the conversation (roughly $0.20–0.40/min — see the [design spec's cost section](docs/superpowers/specs/2026-08-17-pi-voice-call-outbound-design.md#11-costs--accounts-phase-1)). Only run it against a number you intend to actually call, with the daemon and your Twilio/OpenAI billing set up as you expect.

Sanity-check the request shape with no daemon running and no call placed:

```bash
npm run call -- --to +15555550100 --objective "test" --dry-run
```

This prints the exact JSON body that would be POSTed to `/calls` and exits — no network calls happen. Once the daemon is running (`npm start`, in another terminal) and you're ready to place a real call:

```bash
npm run call -- --to +15555550100 --objective "Confirm tomorrow's 2pm appointment" --talking-point "If asked, this is a test call" --identity "Dominic's assistant"
```

This is the manual acceptance test from the design spec's §9 testing section: it prints status transitions as the call progresses (queued → dialing → ringing → answered → completed, or a non-answer terminal state), then the final result JSON (`outcome`, `summary`, `transcriptPath`, `durationSec`). Exits 0 on a completed run, 1 if the daemon is unreachable or the result carries an `error`.

## Known limitations / post-setup validation

The pi extension (`extension/voice-call.ts`) was built against pi's published extension docs. Its load path has been verified against a real pi installation (pi 0.84.2): registered via `settings.json`, the extension loads cleanly and `voice_call` appears in the agent's tool list. `extension/client.ts` — where all the logic lives — is unit-tested against a stubbed HTTP layer; `extension/voice-call.ts` is thin wiring that is type-checked and load-tested but not unit-tested, and a full call driven end-to-end through pi (rather than through `npm run call`) has not yet been exercised.

First-run checklist:
1. Register the extension in `settings.json` (above) and start/restart pi.
2. Confirm a `voice_call` tool appears in pi's available tools, and `/call-status` appears as a command.
3. Try `voice_call` with `action: "get_status"` against a running daemon (no call placed, safe/free) to confirm the extension can reach the control API at all.
4. Only then run the billable smoke test above.

If the tool's runtime behavior doesn't match what pi expects, please file an issue with the exact error.

## Limits & safety defaults

- **Call caps:** `maxDurationSec: 900` (15 min hard cap, enforced daemon-side), `maxConcurrentCalls: 1`, `dailyCallCap: 20`. Ring timeout 30s before a call is marked no-answer.
- **Public surface:** only `POST /voice/webhook` and the `GET /voice/stream` WebSocket upgrade are reachable through the tunnel; every other path on the public listener returns 404. Twilio webhook requests are HMAC-SHA1 signature-validated and replay-deduped; the media-stream WS requires a per-call random token.
- **Control API:** binds to `127.0.0.1` only (never routed through the tunnel), requires `Authorization: Bearer <controlToken>` on every route except `GET /health`.
- **Secrets:** Twilio auth token, OpenAI API key, and the control token never appear in model prompts, transcripts, or logs — the daemon's startup banner deliberately omits all three.
- **The in-call voice model** has no state-changing tools beyond ending its own call and dialing DTMF; it cannot reach pi, your filesystem, or any other system mid-call.

## Credits

Core telephony/media techniques — Twilio Media Streams framing, playout-drain/mark handling, μ-law DTMF synthesis, tunnel automation, webhook HMAC validation — are ported and adapted from the MIT-licensed [openclaw-voice-call-realtime](https://github.com/TristanBrotherton/openclaw-voice-call-realtime) by Tristan Brotherton. See [LICENSE](LICENSE) for the full MIT text and attribution.

One deliberate deviation from the original design: post-call summaries call the OpenAI chat-completions API directly with `fetch` (using the same API key as the Realtime session) rather than adding a `pi-ai`-style model-client dependency — this keeps the daemon's runtime dependency surface at exactly `ws` and `zod`.

## Roadmap

1. **Phase 1 (current):** outbound conversation calls from pi via Twilio.
2. **Phase 2:** inbound — Dialpad Call Router forwards calls into the same bridge; caller trust tiers; Dialpad-number caller ID verification.
3. **Phase 3+:** in-call `ask_assistant` bridge to a fresh pi session, calendar/Home Assistant integrations, async post-call report push, multi-provider telephony (Telnyx/Plivo).

## License

[MIT](LICENSE)
