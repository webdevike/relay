# Select the voice provider and route calls on the host

Status: PLANNED
Review Mode: AUTO
Depends on: None
Expected production LOC: 90
Maximum production LOC: 130
Expected files touched: 6

## For Isaac

- Outcome: The host reads which voice provider to use (default GPT-Live) and the Deepgram key, and sends `live.start` and `call.start` to the right engine path.
- Why it matters: Everything else is dead code until the host can choose Deepgram without breaking today's GPT default.
- Proof: With nothing configured, GPT behaves exactly as before. With `voice.provider = deepgram`, `live.start` answers `ended`+`fallback` and `call.start` is accepted even on a host without the local voice stack.

## Why

The provider seam is at the wire (SDP `live.*` vs PCM `call.*`). Selection is one two-way branch resolved at composition and evaluated at each start. It covers AC1, AC3 and the dispatch half of AC4.

## Implement

- `host-config.ts`: add optional `voice: { provider: "gpt-live" | "deepgram" }` to `HostConfigFile`/`HostConfig` (zod). `RELAY_VOICE_PROVIDER` overrides it; default `gpt-live`. Export a resolver `(agent) => provider` evaluated per start (constant today).
- `call/deepgram-key.ts`: `deepgramKey(agentHome, env)` mirroring `openAiKey` (`$DEEPGRAM_API_KEY`, then `<agentHome>/secrets/deepgram.env` `DEEPGRAM_API_KEY=` line; null when absent). Never log the value.
- `main.ts`: build `CallService` when the local voice stack exists OR provider is deepgram with a key; pass provider resolver and key to `LiveService` and `CallService`. Default configuration must compose byte-identically to today.
- `live/service.ts`: when the resolver says deepgram, `live.start` answers `ended` with `fallback: true` (same path as `api === null`) and creates no GPT session.
- `call/service.ts`: accept nullable `voice` (guard `warm()`: `this.deps.voice?.warm()`) and an optional provider/key dependency so the service can exist without the local stack. The engine itself arrives in issue 04; here an unconfigured combination still answers `ended` as today.
- Tests in `apps/linux/test/voice-provider.test.ts` (resolver precedence, key file/env/missing, live decline under deepgram, default GPT path untouched); `live.test.ts` must stay unchanged and green.

## Do Not

- Do not add a `VoiceProvider` interface or registry.
- Do not add a per-agent registry field or any protocol, mobile or Swift change.
- Do not touch `LiveCall`, `OpenAiLive` or `VoiceCall`.

## Open Questions

### Q3: Accept the extra declined `live.start` round trip on Deepgram calls?
Type: IMPLEMENTATION
Importance: MEDIUM
Answer Format: SINGLE_SELECT
Options:
- Accept for v1 and measure in the smoke (issue 05)
- Add an OTA JS skip via a `welcome.features` flag (`voice.pcm-only`) so the app goes straight to `call.start`
Comment: The in-app path runs Live Activity, mic, peer and a host round trip before falling back (est. 0.3-1 s, not measured).
Agent Default: Accept for v1; measure in smoke.
Status: AGENT_DECIDED
Decision: Accept for v1; the OTA skip is not planned unless Isaac asks.

### Q5: Choose the provider host-wide or per agent?
Type: ARCHITECTURE
Importance: LOW
Answer Format: SINGLE_SELECT
Options:
- Host-wide (host.json / env) with a per-start resolver
- Per-agent registry field like `liveVoice`
Comment: None
Agent Default: Host-wide.
Status: AGENT_DECIDED
Decision: Host-wide; the resolver keeps a per-agent field a one-line change later.

## Verify

- `apps/linux/test/voice-provider.test.ts` and unchanged `apps/linux/test/live.test.ts` pass.
- Typecheck of `apps/linux` passes.
