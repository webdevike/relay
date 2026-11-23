# Result: Add the Effect voice-engine seam, the GPT-Live layer and the substitution proof

## Implemented
- `effect@4.1.5` (exact) in `apps/linux/package.json` and `pnpm-lock.yaml`.
- `apps/linux/src/voice/engines.ts`: `VoiceEngine` union by transport, `PcmCall`/`PcmCallDeps`/`CallLike`, `VoiceEngines` (`Context.Service`, `select(agent)`), `gptLiveLayer`, `engineLayer`, `VOICE_ENGINE_LAYERS` (total over `ProviderId`), `resolveVoiceEngines` (`Effect.runSync` over `Layer.build`), `composeVoiceEngines` (env, then host.json, then default).
- `host-config.ts`: `ProviderId` enum (`gpt-live`), `DEFAULT_PROVIDER`, optional `voice.provider`.
- `LiveService` takes `engines`; webrtc engine with no key keeps the old text and log, a pcm engine answers `ended` + `fallback` ("This host uses PCM calls").
- `CallService` takes `engines` and a nullable `voice`: a pcm engine's `open` first, local `VoiceCall` when there is no engine call or `start()` resolves false, today's "This host cannot take calls" otherwise. `main.ts` builds it whenever there is an assistant.
- `CallThread` gains optional `rows`/`memory`; `main.ts` supplies the same lambdas as the live thread.
- `live.test.ts`/`live-standin.ts` setup moved to `engines` (assertions unchanged); `voice-engines.test.ts` added.

## Why This Approach
One small service both callers read; `LiveCall`, `OpenAiLive`, `VoiceCall`, `session.ts` untouched. `CallLike` is the shape the service already used from `VoiceCall`.

## Reused
- `openAiKey`, `OpenAiLive`, `LiveApi`, the `CallService`/`LiveService` frame handling, `SessionClock`.

## Actual Complexity
- Production LOC added: 206
- Production LOC deleted: 31
- Test LOC added: 201
- Files touched: 11 (nix/hashes.json not touched: Linux/Nix only)

## Budget
- Expected production LOC: 175
- Maximum production LOC: 200 (rebalanced 2026-11-23 from 220 when docs started counting; parent cap unchanged at 1000)
- Actual production LOC: 197 added after the budget pass (206 before: `voice/engines.ts` trimmed by 9)
- Expected files: 12
- Actual files: 11

## Review Callouts
- Effect 4.1.5 names confirmed from `node_modules/effect`: `Context.Service<Self, Shape>()("id")`, `Layer.sync`/`Layer.succeed`, `Layer.build` + `Effect.scoped` + `Effect.runSync`.
- `nix/hashes.json` `.root` must be recomputed with `nix/update-hashes.sh` on Linux/Nix or CI; not runnable here.
- The call `start()` fallback registers the local call under the same socket after the PCM call reports false; the PCM call must not call `onEnded` or send frames in that case (contract in `PcmCall`).

## Open Questions Resolved
- Q5 → host-wide (agent decision, unchanged).
- Q1, Q2 → Isaac's "Approve the plan" (2026-11-23), recorded by the parent.

## Verification
- `npx vitest run test/voice-engines.test.ts test/live.test.ts test/call.test.ts` (apps/linux) — PASS (50 tests)
- `npx tsc --noEmit -p tsconfig.json` (apps/linux), changed files — PASS; unrelated errors in `expo-sound.test.ts`, `machine-docs.test.ts` (duplicate hoisted xstate 5.32.6 vs 5.33.0) and desktop imports are not from this change
- `npx eslint` on the new and changed files — PASS for new code; 4 errors in `host-config.ts:137`, `main.ts:1169,1671`, `live.test.ts:231` are in untouched lines
- `bun build --compile --target=bun-darwin-arm64 src/main.ts` — PASS (894 modules, effect bundled)
- `npx vitest run` (apps/linux) — 1038/1040; failures are `canvas-pacing.test.ts` (needs `bun:test`) and one different file-watcher test per run (`catchup`, `workspace-mirror`), none touching this code
