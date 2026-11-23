# Result: Run the Deepgram call over PCM and register its engine

## Implemented
- `apps/linux/src/call/deepgramCall.ts`: `DeepgramCall` (a `PcmCall`), `deepgramInstructions`, `deepgramLayer(env)`. The machine's `session` actor forks one Effect fiber (open, report ready, feed events to the call); cleanup interrupts it and the scope closes the socket.
- Bridge: Isaac's finals since the last handover (fallback `arguments.question`) go to `thread.turn(voiceTurn(text))` once on `ask_assistant`, with an immediate `FunctionCallResponse`; settled reply sentences (`ReplySpeech`, `[[details]]`, `SILENCE_MARKER`) go back as `InjectAgentMessage` (`queue`); a refused line retries at the next `AgentAudioDone`. `UserStartedSpeaking` while the agent speaks: `gen += 1`, `call.flush`, in-flight replies ignored. First agent audio counts as speaking.
- Registered: `"deepgram"` in the `ProviderId` enum (`host-config.ts`, 1 line) and one entry plus import in `VOICE_ENGINE_LAYERS` (`voice/engines.ts`). No caller touched (`live/service.ts`, `call/service.ts`, `session.ts`, `main.ts` unchanged by this issue).
- `test/deepgram-call.test.ts` (14 cases).

## Why This Approach
The call is `LiveCall`'s shape on the PCM transport: same thread bridge, Deepgram bundles ears/LLM/voice so no `VoiceStack`. The machine owns lifecycle and phone-visible state.

## Reused
- `ReplySpeech`, `voiceTurn`, `liveInstructions`, `clockLine`, `memoryBrief`, `recentTurns`, `TURN_START_GRACE_MS`, the `observe` pattern of `VoiceCall`/`LiveCall`; `CallService`'s existing `call.flush`/`call.audio` contract.

## Actual Complexity
- Production LOC added: 393 (`deepgramCall.ts` 391, `engines.ts` +2, `host-config.ts` +1 net of change)
- Production LOC deleted: 0
- Test LOC added: 249
- Files touched: 4 (+ `test/deepgram-fake.ts` from 02)

## Budget
- Expected production LOC: 300
- Maximum production LOC: 380
- Actual production LOC: about 393 (over the issue maximum by about 13; 02-04 together 740 of 780; parent total 985 of 1000, no cap changed; 15 LOC of headroom remain)
- Expected files: 4
- Actual files: 4

## Review Callouts
- REVIEW_AFTER checkpoint: Isaac reviews this result before 05. Replies are spoken verbatim through `InjectAgentMessage` `queue`. Whether Deepgram queues, refuses or drops it mid-turn on a real call is only visible in the real smoke (05); a refusal retries once at idle.
- A muted phone sends no frames; the session's `KeepAlive` keeps Deepgram's socket open. A half-heard utterance at mute time is not reset (Deepgram has no reset command).
- Muting, hang-up before connect and the cap all end through the machine; late events after the end are guarded (no sends to a stopped actor).
- Production LOC is at 985 of the 1000 parent cap.

## Open Questions Resolved
- Q7 → verbatim queue (agent decision, unchanged; revisit after smoke).

## Verification
- `npx vitest run test/deepgram-call.test.ts test/deepgram.test.ts test/voice-engines.test.ts test/deepgramCall.machine.test.ts test/machine-docs.test.ts test/live.test.ts test/call.test.ts` (apps/linux) — PASS (79 tests)
- `npx vitest run` (apps/linux) — 1070/1070 tests pass; `canvas-pacing.test.ts` cannot load (`bun:test`), pre-existing
- `npx tsc --noEmit -p tsconfig.json` (apps/linux), changed files — PASS
- `npx eslint` on the new and changed files — PASS (4 errors remain in untouched lines of `host-config.ts`, `main.ts`, `live.test.ts`)
- `bun build --compile --target=bun-darwin-arm64 src/main.ts` — PASS (897 modules)
