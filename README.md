# pi-voice-call-realtime

A realtime phone voice agent for [pi](https://pi.dev): a pi agent places outbound calls (scheduling, reservations, vendor calls), holds a natural voice conversation via Twilio Media Streams + the OpenAI Realtime API, and reports the outcome back to the pi session. Later phases add inbound calling on a Dialpad number.

**Status:** design phase — see the [Phase 1 design spec](docs/superpowers/specs/2026-08-17-pi-voice-call-outbound-design.md).

## Architecture (Phase 1)

- **voice-bridge daemon** — long-lived Node/TypeScript process owning the Twilio REST client, webhook + media-stream WebSocket endpoints, the OpenAI Realtime session (μ-law passthrough, no transcoding), transcripts, and an auto-managed tunnel.
- **pi extension** — registers a `voice_call` tool in pi sessions; `initiate_call` blocks until the call completes and returns the transcript + outcome to the agent.

Core telephony/media techniques are ported from the MIT-licensed [openclaw-voice-call-realtime](https://github.com/TristanBrotherton/openclaw-voice-call-realtime) by Tristan Brotherton, adapted from OpenClaw plugin packaging to the pi SDK.

## Roadmap

1. **Phase 1 (current):** outbound conversation calls from pi via Twilio.
2. **Phase 2:** inbound — Dialpad Call Router forwards calls into the same bridge; caller trust tiers; Dialpad caller ID.
3. **Phase 3:** in-call `ask_assistant` bridge to pi, richer integrations.

## License

[MIT](LICENSE)
