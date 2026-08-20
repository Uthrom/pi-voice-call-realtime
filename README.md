# pi-voice-call-realtime

Give a locally running [pi](https://pi.dev) coding agent the ability to place real outbound phone calls. Ask pi to book a table, chase a vendor, or confirm an appointment — it dials out through Twilio, holds a natural voice conversation via the OpenAI Realtime API, and reports the transcript and outcome back into the pi session, all from one agent tool call.

## How it works

Two long-lived pieces work together: a **voice-bridge daemon** that owns the Twilio client, the public webhook/media-stream surface, the OpenAI Realtime session, and transcripts; and a thin **pi extension** that registers a `voice_call` tool and talks to the daemon over a localhost control API. The daemon outlives any single pi session, so calls survive session restarts and the public webhook URL stays stable.

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

## Prerequisites

- **Node.js ≥ 20**
- A **Twilio account** with an outbound-voice phone number (Account SID + Auth Token)
- An **OpenAI API key** with access to the Realtime API
- **[cloudflared](https://developers.cloudflare.com/cloudflared/downloads/)** on `PATH` (default tunnel provider; `ngrok` or a self-managed URL also work)
- **[pi](https://pi.dev)** installed

## Setup

### 1. Install

```bash
git clone https://github.com/Uthrom/pi-voice-call-realtime.git
cd pi-voice-call-realtime
npm install
```

### 2. Configure

Create `~/.pi-voice/config.json` (override the location with the `PI_VOICE_HOME` env var). Replace every placeholder with your own values — never commit real credentials:

```json
{
  "twilio": {
    "accountSid": "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    "authToken": "your_twilio_auth_token_here",
    "fromNumber": "+15555550100"
  },
  "openai": {
    "apiKey": "sk-proj-REPLACE_WITH_YOUR_OPENAI_API_KEY"
  },
  "serve": {
    "controlToken": "REPLACE_WITH_A_LONG_RANDOM_TOKEN"
  }
}
```

Generate `serve.controlToken` with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

That minimal file is all you need. Optional settings and their defaults:

| Setting | Default | Notes |
|---|---|---|
| `openai.realtimeModel` | `"gpt-realtime"` | Voice conversation model |
| `openai.voice` | `"alloy"` | Realtime voice |
| `openai.reasoningEffort` | unset | For 2.1+ realtime models: `"minimal"`/`"low"`/`"medium"`/`"high"`/`"xhigh"`. `"minimal"` recommended for phone calls; leave unset on pre-2.1 models (they reject the field) |
| `summary.model` | `"gpt-4o-mini"` | Post-call summary model |
| `summary.baseUrl` | `"https://api.openai.com/v1"` | Any OpenAI-compatible chat-completions server |
| `summary.apiKey` | `openai.apiKey` | Separate key for the summary endpoint |
| `serve.controlPort` | `3335` | Localhost control API |
| `serve.publicPort` | `3334` | Webhook/media listener behind the tunnel |
| `serve.tunnel` | `"cloudflared"` | `"cloudflared"`, `"ngrok"`, or `"none"` (then set `serve.publicUrl`) |
| `limits.maxDurationSec` | `900` | Hard per-call cap, enforced daemon-side |
| `limits.maxConcurrentCalls` | `1` | |
| `limits.dailyCallCap` | `20` | |
| `defaults.callerIdentity` | `"pi"` | How the agent introduces itself |
| `defaults.amdPolicy` | `"leave-message"` | Or `"hangup"` when a machine answers |

Post-call summaries can run against any OpenAI-compatible endpoint (a local model, a proxy, a free-tier server) instead of OpenAI — for example:

```json
"summary": {
  "model": "llama-3.3-70b",
  "baseUrl": "https://my-llm.example.com/v1",
  "apiKey": "whatever-your-server-expects"
}
```

Omitted fields fall back to the defaults above, so `"summary": { "model": "gpt-5-mini" }` alone is also valid.

`twilio.accountSid`, `twilio.authToken`, `openai.apiKey`, and `summary.apiKey` can also be supplied via the `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `OPENAI_API_KEY`, and `SUMMARY_API_KEY` env vars, which override the file when set to a non-empty value.

### 3. Run the daemon

```bash
npm start
```

This starts the control API on `127.0.0.1:<controlPort>` (loopback only, bearer-token authed), the public listener on `<publicPort>` (only the Twilio webhook and media-stream WebSocket are reachable — everything else 404s), and the tunnel. On success it prints a startup banner with the public URL. Keep it running in a terminal, `tmux`, or under a process supervisor — it's meant to outlive any single pi session.

### 4. Install the pi extension

Register the extension by its **absolute path** in `~/.pi/agent/settings.json`:

```json
{
  "extensions": [
    "/absolute/path/to/pi-voice-call-realtime/extension/voice-call.ts"
  ]
}
```

Restart pi and confirm the `voice_call` tool and `/call-status` command appear. For a one-off test without touching settings: `pi -e /absolute/path/to/extension/voice-call.ts`.

### 5. Test it

Sanity-check the request shape first — no daemon needed, no call placed:

```bash
npm run call -- --to +15555550100 --objective "test" --dry-run
```

Then, with the daemon running, place a real call:

> **Cost warning:** this places a real, billable Twilio call and consumes OpenAI Realtime usage (roughly $0.20–0.40/min). Only call numbers you actually intend to reach.

```bash
npm run call -- --to +15555550100 --objective "Confirm tomorrow's 2pm appointment" --talking-point "If asked, this is a test call" --identity "Alex's assistant"
```

It prints status transitions as the call progresses (queued → dialing → ringing → answered → completed), then the final result JSON (`outcome`, `summary`, `transcriptPath`, `durationSec`).

## Stable public URL (optional)

The zero-setup default is a `cloudflared` quick tunnel, which gets a fresh random URL on every daemon restart. (If the boot-time readiness probe warns it can't reach the tunnel, the tunnel may still be fine — DNS for fresh hostnames can lag on the machine running it; restart the daemon for a fresh hostname if calls actually fail.)

For a URL that survives restarts, use a named Cloudflare Tunnel (requires a domain on Cloudflare):

```bash
cloudflared tunnel login
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
cloudflared tunnel run pi-voice    # keep running (launchd/tmux)
```

Then set `"tunnel": "none"` and `"publicUrl": "https://voice.yourdomain.com"` in your config.

## Security & limits

- **Call caps:** 15-minute hard cap per call, 1 concurrent call, 20 calls/day (all configurable). 30-second ring timeout.
- **Public surface:** only the Twilio webhook and media-stream WebSocket are reachable through the tunnel. Webhook requests are HMAC-signature-validated and replay-deduped; the media stream requires a per-call random token.
- **Control API:** binds to `127.0.0.1` only, never routed through the tunnel, bearer-token authed.
- **Secrets:** the Twilio auth token, OpenAI API key, and control token never appear in model prompts, transcripts, or logs.
- **The in-call voice model** has no state-changing tools beyond ending its own call and dialing DTMF; it cannot reach pi, your filesystem, or any other system mid-call.

## Roadmap

1. **Phase 1 (current):** outbound conversation calls from pi via Twilio.
2. **Phase 2:** inbound — Dialpad Call Router forwards calls into the same bridge; caller trust tiers.
3. **Phase 3+:** in-call `ask_assistant` bridge to a fresh pi session, calendar integrations, multi-provider telephony.

## Credits

Core telephony/media techniques — Twilio Media Streams framing, playout-drain/mark handling, μ-law DTMF synthesis, tunnel automation, webhook HMAC validation — are ported and adapted from the MIT-licensed [openclaw-voice-call-realtime](https://github.com/TristanBrotherton/openclaw-voice-call-realtime) by Tristan Brotherton.

## License

[MIT](LICENSE)
