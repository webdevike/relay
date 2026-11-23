# Run Deepgram calls over the PCM transport and provide the Deepgram engine layer

Status: COMPLETE
Review Mode: REVIEW_AFTER
Depends on: 01, 02, 03
Expected production LOC: 300
Maximum production LOC: 380
Expected files touched: 4

## For Isaac

- Outcome: With `voice.provider = deepgram`, calling Nova or Astra talks to a Deepgram Voice Agent that hands requests to the assistant thread and speaks replies; failures fall back to the local call. Deepgram is enabled by one enum literal and one registry entry.
- Why it matters: The user-visible feature (AC5-AC8) and the live proof of the "next provider" claim.
- Proof: Host tests show a full call (one `voiceTurn`, reply spoken sentence by sentence, barge-in flushes and drops stale replies, every ending closes once), and the diff touches no caller.

## Why

`deepgramLayer(env)` provides `{ id: "deepgram", transport: "pcm-websocket", open }`; 01's `CallService` already serves pcm engines and falls back when `start()` is false, so no service code changes.

## Implement

- `apps/linux/src/call/deepgramCall.ts`: a `PcmCall` (`id/audio/mute/end/observe/start`). Machine actor with `clock: deps.clock`; one `fromCallback` actor does `Effect.runFork(Effect.scoped(open ...))` and `Fiber.interrupt` on cleanup. `start()` resolves false if the session never opens (nothing sent to the phone).
- Mic base64 to binary PCM; while muted send silence frames (or `KeepAlive`). Agent PCM to `call.audio{gen}`. `UserStartedSpeaking` to `gen += 1`, `call.flush{gen}`, ignore in-flight injected replies.
- `ConversationText` finals accumulate. `FunctionCallRequest` (`ask_assistant`): request = user finals since last hand-over (fallback `arguments.request`), `thread.turn(voiceTurn(text))` once, immediate `FunctionCallResponse`, then the bridge's settled reply via `InjectAgentMessage` sentence by sentence (`ReplySpeech`, `plainSpeech`, `SILENCE_MARKER`, `[[details]]`). Prompt `liveInstructions(title)`, context `liveBrief(title, memory, rows, clock)` using `CallThread.rows`/`memory` added in 01.
- `deepgramLayer(env)` (in `deepgramCall.ts` or `deepgram.ts`); add `"deepgram"` to the `ProviderId` enum in `host-config.ts` and one entry in `VOICE_ENGINE_LAYERS` in `voice/engines.ts`.
- `apps/linux/test/deepgram-call.test.ts` with `FakeClock`/`FakeThread` and `layerTest`: Settings first, one thread turn, immediate function response, injected sentences, silence marker unspoken, barge-in drops late reply, each terminal path closes once with one state, failed open falls back to `VoiceCall`, no key falls back, `live.start` declined with `fallback`.

## Do Not

- No change to `live/service.ts`, `call/service.ts`, `session.ts` or `main.ts` (verify with `git diff --stat`); no `if (provider === ...)` anywhere.
- No `VoiceStack`-shaped adapter, no reconnect grace, no key logging.

## Open Questions

### Q7: How are replies spoken?
Type: IMPLEMENTATION
Importance: MEDIUM
Answer Format: SINGLE_SELECT
Options:
- Verbatim through the `InjectAgentMessage` queue
- Hold the `FunctionCallResponse` and let Deepgram rephrase
Comment: Settled by the real smoke (05).
Agent Default: Verbatim queue.
Status: AGENT_DECIDED
Decision: Verbatim queue; revisit if smoke shows `InjectionRefused` or lost injections.

## Verify

- `deepgram-call.test.ts` passes with unchanged `call.test.ts`, `live.test.ts`, `voice-engines.test.ts`; typecheck passes.
- `git diff --stat` for this issue lists no caller file.
