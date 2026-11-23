# Add the Deepgram Voice Agent session as an Effect service

Status: COMPLETE
Review Mode: AUTO
Depends on: 01
Expected production LOC: 200
Maximum production LOC: 240
Expected files touched: 2

## For Isaac

- Outcome: A host-only Deepgram Voice Agent session (scoped WebSocket, typed events, start timeout, key by path) as an Effect service with a scripted test layer.
- Why it matters: It is the Deepgram I/O the engine layer will provide in 04.
- Proof: Tests show `Settings` first, events stream, a start failure or timeout errors, and closing the scope closes the socket once.

## Why

Covers the provider I/O half of AC5 and the socket half of AC8. Effect `Layer`/`Context` here follows the seam from 01.

## Implement

- `apps/linux/src/call/deepgram.ts`: `DeepgramAgent` `Context.Service` with `open(config): Effect<AgentSession, DeepgramError, Scope>`. `Effect.acquireRelease` on the `WebSocket` (`wss://agent.deepgram.com/v1/agent/converse`, `Authorization: Token <key>`; close and terminate on scope close). Send `Settings` first (linear16 16000 in, 24000 out, container none; prompt, one `ask_assistant` function with `defer_until_eot`, managed `open_ai` think model, greeting, context messages from the caller). Wait for `SettingsApplied` under `Effect.timeout` (~8 s) else `DeepgramError`.
- Server JSON parsed with zod into a typed `AgentEvent` stream (`ConversationText`, `UserStartedSpeaking`, `FunctionCallRequest`, `SettingsApplied`, `Error`/`Warning`, close); binary frames are PCM events. `AgentSession` exposes `send(pcm)`, `sendJson(message)` and the event stream. `KeepAlive` every 8 s only if frames stop.
- `deepgramKey(agentHome, env)` mirroring `openAiKey` (`$DEEPGRAM_API_KEY`, then `<agentHome>/secrets/deepgram.env`); null when absent. Sanitised `DeepgramError`: never the key or headers.
- Live layer plus `layerTest(script)`; test in `apps/linux/test/deepgram.test.ts` with `TestClock`.

## Do Not

- No Deepgram SDK, TTS/STT client, Effect-to-XState framework.
- Do not register the engine or add the config literal here (04).
- Do not log or send the key.

## Open Questions

### Q6: Deepgram think model and voice
Type: IMPLEMENTATION
Importance: LOW
Answer Format: FREEFORM
Comment: Managed `open_ai` small model; aura-2 voice picked by ear in smoke (05).
Agent Default: Managed `open_ai` small model, constants in `deepgram.ts`.
Status: AGENT_DECIDED
Decision: Use the default; revisit after smoke.

## Verify

- `deepgram.test.ts` passes (Settings first, timeout, error, scope-close closes socket once); typecheck passes.
