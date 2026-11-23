# Add the Deepgram Voice Agent session as an Effect service

Status: PLANNED
Review Mode: REVIEW_BEFORE
Depends on: None
Expected production LOC: 170
Maximum production LOC: 230
Expected files touched: 5

## For Isaac

- Outcome: A host-only Deepgram Voice Agent session (scoped WebSocket, typed events, start timeout) built on `effect@4.1.5`, with a scripted test layer.
- Why it matters: It is the real provider I/O for Deepgram, and the only place Effect is used.
- Proof: Tests show the socket opens, `Settings` goes first, events stream in, a start failure or timeout errors, and closing the scope closes the socket once.

## Why

Covers the provider I/O half of AC2, AC7 (socket closed exactly once via scope) and the Effect half of AC8. Adds the repo's only new dependency, so it is reviewed before landing.

## Implement

- First read `node_modules/effect` after install and confirm the 4.x names (`Context.Service`, `Layer`, `Scope`, `Stream`/`Queue`, `effect/testing` `TestClock`); adapt to what is really exported.
- `apps/linux/package.json`: `"effect": "4.1.5"` exact; update `pnpm-lock.yaml`. `nix/hashes.json` `.root` cannot be recomputed on this Mac: record that `nix/update-hashes.sh` must run on Linux/Nix (or CI) and leave that to the PR note. Do one local `bun build --compile` check that effect bundles.
- `apps/linux/src/call/deepgram.ts`: `DeepgramAgent` service with `open(config): Effect<AgentSession, DeepgramError, Scope>`. `Effect.acquireRelease` on the `WebSocket` (`wss://agent.deepgram.com/v1/agent/converse`, `Authorization: Token <key>`; close and terminate on scope close). Send `Settings` first (linear16 16000 in, 24000 out, container none; prompt, one `ask_assistant` function with `defer_until_eot`, managed `open_ai` think model, greeting, context messages from the caller). Wait for `SettingsApplied` under `Effect.timeout` (~8 s) else `DeepgramError`.
- Server JSON parsed with zod into a typed `AgentEvent` stream (`ConversationText`, `UserStartedSpeaking`, `FunctionCallRequest`, `SettingsApplied`, `Error`/`Warning`, close); binary frames become audio PCM events. `AgentSession` exposes `send(pcm)`, `sendJson(message)` (`FunctionCallResponse`, `InjectAgentMessage`), and the event stream. Send `KeepAlive` every 8 s only if frames stop (muted).
- Sanitised `DeepgramError`: never include the key or headers.
- Live layer plus `layerTest(script)` for the call tests. Test in `apps/linux/test/deepgram.test.ts` using the test layer and `TestClock`.

## Do Not

- Do not add a Deepgram SDK or a TTS/STT client.
- Do not use Effect outside this module and its consumer fiber (not in `LiveCall`, `OpenAiLive`, `VoiceCall`, `CallService`).
- Do not build an Effect-to-XState framework.

## Open Questions

### Q4: Effect boundary
Type: ARCHITECTURE
Importance: MEDIUM
Answer Format: SINGLE_SELECT
Options:
- Deepgram provider I/O only
- Also move `OpenAiLive` onto Effect
Comment: None
Agent Default: Deepgram I/O only; GPT code is not touched (AC1).
Status: AGENT_DECIDED
Decision: Deepgram I/O only.

### Q6: Deepgram think model and voice
Type: IMPLEMENTATION
Importance: LOW
Answer Format: FREEFORM
Comment: Default is the managed `open_ai` small model; the aura-2 voice is picked by ear in the smoke (issue 05).
Agent Default: Managed `open_ai` small model, one aura-2 voice chosen in smoke, both constants in `deepgram.ts`.
Status: AGENT_DECIDED
Decision: Use the default; revisit after the smoke.

## Verify

- `apps/linux/test/deepgram.test.ts` passes (Settings first, timeout, error, scope-close closes socket once).
- Typecheck of `apps/linux` passes; `bun build --compile` bundles effect.
