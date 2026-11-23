# Result: Add the Deepgram Voice Agent session as an Effect service

## Implemented
- `apps/linux/src/call/deepgram.ts`: `DeepgramAgent` (`Context.Service`, `open(config)` in the caller's scope), `deepgramAgentLayer(key, connect?)`, typed `AgentEvent` stream (zod-parsed frames; binary = PCM), `settingsMessage`, `parseFrame`, `deepgramKey(agentHome, env)`, `DeepgramError` (our text or Deepgram's `code: description`, never the key), `Effect.acquireRelease` socket closed once with the scope, 8 s `SettingsApplied` timeout, `KeepAlive` every 8 s only when nothing else was sent.
- `test/deepgram.test.ts`, `test/deepgram-fake.ts` (scripted socket, shared with 04).

## Why This Approach
The live layer takes a socket factory, so tests drive the real parsing and scope code with a scripted socket instead of a second `layerTest` implementation. Key goes in the one `Authorization: Token` header of the connect call.

## Reused
- `openAiKey` shape for `deepgramKey`; `CALL_INPUT_RATE`/`CALL_OUTPUT_RATE` from the protocol; zod; Bun's `WebSocket` with headers (as `OpenAiLive`).

## Actual Complexity
- Production LOC added: 263
- Production LOC deleted: 0
- Test LOC added: 171 (`deepgram.test.ts` 134, `deepgram-fake.ts` 37)
- Files touched: 3

## Budget
- Expected production LOC: 200
- Maximum production LOC: 240
- Actual production LOC: 263 (over the issue maximum by 23; issue 03 came in 76 under its maximum, so 02+03+04 stay inside their combined 780 and the parent stays inside 1000; no cap changed)
- Expected files: 2
- Actual files: 3 (`deepgram-fake.ts`, a test helper both 02 and 04 use)

## Review Callouts
- Real Deepgram handshake with synthetic silence (throwaway script, since deleted; key read by path, never printed): `Settings` applied, greeting spoken (`ConversationText` assistant "Hey, what's up?", 59,520 PCM bytes, `AgentAudioDone`), clean close. No `AgentStartedSpeaking` frame arrived for the greeting; 04 treats the first agent audio as speaking.
- `Effect.callback` generic is `unknown` (not `void`) to satisfy the repo's lint rule.

## Open Questions Resolved
- Q6 → managed `nova-3` / `gpt-4o-mini` / `aura-2-thalia-en`, constants in `deepgram.ts` (agent decision, unchanged); revisit by ear in 05.

## Verification
- `npx vitest run test/deepgram.test.ts` (apps/linux) — PASS (6 tests): Settings first at 16/24 kHz, typed events, closed once with scope, refusal and timeout errors without the key, KeepAlive only when idle, key lookup
- `npx tsc --noEmit -p tsconfig.json` (apps/linux), changed files — PASS
- `npx eslint` on the new files — PASS
- Real Deepgram handshake (above) — PASS
