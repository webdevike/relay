# Run Deepgram calls over the existing PCM call transport

Status: PLANNED
Review Mode: REVIEW_AFTER
Depends on: 01, 02, 03
Expected production LOC: 300
Maximum production LOC: 400
Expected files touched: 3

## For Isaac

- Outcome: With Deepgram selected, calling Nova or Astra from the app talks to a Deepgram Voice Agent that hands requests to the assistant thread and speaks its replies; failures fall back to the local call.
- Why it matters: This is the user-visible feature (AC2, AC4-AC7).
- Proof: Host tests show a full call: heard words become one `voiceTurn`, the reply is spoken sentence by sentence, speaking over it flushes and drops stale replies, and every ending closes the session once.

## Why

Wires the Deepgram session (02) and the machine (03) into `CallService` using the engine selection from 01, and owns the thread bridge (turn delivery, awaiting/sawWorking/`TURN_START_GRACE_MS`, observe, settled reply via `ReplySpeech`/`plainSpeech`, `SILENCE_MARKER`, `[[details]]`) inline in `deepgramCall.ts`, shaped like `VoiceCall` and not shared. No phone, protocol or Swift change.

## Implement

- `apps/linux/src/call/deepgramCall.ts`: same shape as `VoiceCall` (`id/audio/mute/end/observe/start`). Machine actor created with `clock: deps.clock`. One `fromCallback` actor does `Effect.runFork(Effect.scoped(open ... forEach event -> send))` and `Fiber.interrupt` in cleanup (socket closes once).
- Mic: `call.audio` base64 to binary PCM frames. While muted send silence frames (or `KeepAlive`) so Deepgram does not idle out.
- Agent PCM binary to `call.audio{gen}`. `UserStartedSpeaking` to `bargeIn`: `gen += 1`, `call.flush{gen}`, ignore in-flight injected replies.
- `ConversationText` finals accumulate. On `FunctionCallRequest` (`ask_assistant`): request is the user finals since the last hand-over (fallback `arguments.request`), `thread.turn(voiceTurn(text))` once, immediately answer `FunctionCallResponse` ("Working on it; say nothing until the answer arrives."), then speak the bridge's settled reply via `InjectAgentMessage`, sentence by sentence.
- Prompt from `liveInstructions(title)`; context from `liveBrief`; short greeting.
- State mapping to `call.state`; one terminal state for hang-up, socket loss, provider drop, failed start, cap.
- `call/service.ts`: when provider is deepgram and a key exists build `DeepgramCall`; if the session fails to open or no key and `voice !== null`, silently build the existing `VoiceCall`. No change to the local path or default GPT path.
- Tests in `apps/linux/test/deepgram-call.test.ts` using `FakeClock`/`FakeThread` patterns and the `layerTest` Deepgram script: Settings first, one thread turn, immediate function response, reply sentences injected, silence marker not spoken, `[[details]]`, barge-in drops late reply, each terminal path closes once and reports one state, failed start falls back to `VoiceCall`, no key falls back.

## Do Not

- Do not build a `VoiceStack`-shaped adapter or use ears/filler/speak.
- Do not add reconnect or resume grace for Deepgram.
- Do not use Effect in `CallService` or outside `deepgram.ts` and the fiber actor.
- Do not log or send the key.

## Open Questions

### Q7: How are assistant replies spoken?
Type: IMPLEMENTATION
Importance: MEDIUM
Answer Format: SINGLE_SELECT
Options:
- Speak the assistant's text verbatim through the `InjectAgentMessage` queue
- Hold the `FunctionCallResponse` and let the Deepgram model rephrase the reply
Comment: Decided by the real smoke in issue 05 (long turn, injection during speech).
Agent Default: Verbatim via `InjectAgentMessage` queue.
Status: AGENT_DECIDED
Decision: Verbatim queue; revisit if the smoke shows `InjectionRefused` or lost injections.

## Verify

- `apps/linux/test/deepgram-call.test.ts` passes alongside unchanged `call.test.ts` and `live.test.ts`.
- Typecheck of `apps/linux` passes.
