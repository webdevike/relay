# Run the real smoke per provider and document Siri scope and the next-provider recipe

Status: PLANNED
Review Mode: REVIEW_AFTER
Depends on: 04
Expected production LOC: 0
Maximum production LOC: 0
Expected files touched: 1

## For Isaac

- Outcome: Recorded real runs for GPT-Live and Deepgram, and one doc covering provider selection, Siri/Action Button under each provider, and what a next supported-transport provider changes.
- Why it matters: Deepgram's long-turn, barge-in and injection behaviour only shows in a real call (AC10, AC11), and the recipe is the written half of the substitution claim (AC4).
- Proof: A results note lists each scenario pass/fail; the doc states that Deepgram from Siri needs one foreground tap.

## Why

Fakes cannot settle Q6, Q7 or the declined `live.start` delay.

## Implement

- Run `live-smoke.ts` for GPT-Live. Run `call-smoke.ts` unchanged against a host with `RELAY_VOICE_PROVIDER=deepgram`: normal turn, a >60 s assistant turn, `--barge`, no-key fallback to the local call. Key by path only (`~/Eva/secrets/deepgram.env`), never printed. Edit `call-smoke.ts` only if a scenario cannot be driven.
- Record outcomes, chosen aura-2 voice, measured declined `live.start` delay and any Q7 change.
- `docs/relay/voice-providers.md`: config and key paths, fallback, engine seam, the Next provider recipe from the spec, and Siri/Action Button: `LiveCallIntents.talk` to `live.start` to fallback dialog to foreground to `call.start`; GPT unchanged; native PCM routing deferred unless Isaac decides otherwise (Q2).
- If Isaac chooses native routing or not offering Deepgram to the intent path, this issue is replanned before 05 runs.

## Do Not

- No Swift or mobile change; no audio, keys or secret-bearing transcripts committed.

## Open Questions

### Q2: Siri and Action Button under Deepgram
Type: PRODUCT
Importance: HIGH
Answer Format: SINGLE_SELECT
Options:
- Existing foreground fallback, documented (recommended)
- Native PCM routing in `LiveCallEngine` (Swift, about 400-600 LOC, app rebuild)
- Do not offer Deepgram to the intent path
Comment: Recommended option costs one foreground tap and no hands-free lock-screen start; nothing else changes and GPT Siri is untouched.
Agent Default: Existing foreground fallback, documented.
Status: HUMAN_DECIDED
Decision: Existing foreground fallback, documented. Isaac replied "Approve the plan" on 2026-11-23 to the Nova proposal; parent recorded this as accepting the recommended option.

## Verify

- Results note shows each scenario for both providers, no secrets; docs page matches the code path.
