# Run the real smoke per provider and document the Siri scope

Status: PLANNED
Review Mode: REVIEW_AFTER
Depends on: 04
Expected production LOC: 0
Maximum production LOC: 20
Expected files touched: 1

## For Isaac

- Outcome: Recorded real runs for GPT-Live and Deepgram, plus a short doc saying how Siri and the Action Button behave under each provider.
- Why it matters: The unproven Deepgram behaviors (long assistant turn, barge-in, injection while speaking) can only be settled by a real call (AC9, AC10).
- Proof: A results note lists each smoke scenario with pass/fail, and the doc states that Deepgram from Siri needs a foreground tap.

## Why

Automated tests use fakes. Deepgram's function timeout and queueing behavior are undocumented, so a real run decides Q7 and Q6 and measures Q3.

## Implement

- Run `live-smoke.ts` for GPT-Live (default path unchanged).
- Run the existing `call-smoke.ts` unchanged against a host started with `RELAY_VOICE_PROVIDER=deepgram` (it is a `call.*` client of a running host, so no new smoke file): normal turn, a >60 s assistant turn, barge-in (`--barge`), and no-key fallback to the local call. Edit `call-smoke.ts` only if a scenario cannot be driven. Key by path (`~/Eva/secrets/deepgram.env`) only; never print it.
- Record outcomes, chosen aura-2 voice, measured declined `live.start` delay, and any Q7 change in the results note.
- Add a docs page (for example `docs/relay/voice-providers.md`) covering provider selection config, key path, fallback, and Siri/Action Button: `LiveCallIntents.talk` -> `live.start` -> fallback dialog -> foreground -> `call.start`; GPT unchanged; native PCM routing deferred.

## Do Not

- Do not build native Siri PCM routing or any Swift change.
- Do not commit audio, keys or transcripts containing secrets.

## Open Questions

### Q2: Siri and Action Button under Deepgram
Type: PRODUCT
Importance: HIGH
Answer Format: SINGLE_SELECT
Options:
- Foreground handoff, documented (no change)
- Native PCM routing in `LiveCallEngine` (Swift, about 400-600 LOC, app rebuild)
- Do not offer Deepgram to the intent path
Comment: Handoff means a foreground tap instead of a hands-free lock-screen start. Native routing would be a new planned issue.
Agent Default: Foreground handoff, documented.
Status: OPEN
Decision: Pending

## Verify

- Results note shows each smoke scenario for both providers with outcomes and no secrets.
- Docs page exists and matches the code path described.
