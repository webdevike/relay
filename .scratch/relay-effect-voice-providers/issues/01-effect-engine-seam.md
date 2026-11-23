# Add the Effect voice-engine seam, the GPT-Live layer and the substitution proof

Status: COMPLETE
Review Mode: REVIEW_BEFORE
Depends on: None
Expected production LOC: 175
Maximum production LOC: 220
Expected files touched: 12

## For Isaac

- Outcome: GPT-Live is provided to the host through an Effect 4.1.5 `Layer` of a small transport-tagged `VoiceEngines` service. `LiveService` and `CallService` take that service and branch only on transport. A third test layer plugs in at the same seam with no caller change.
- Why it matters: This is your core ask. It makes the engines interchangeable by Layer and proves it before any Deepgram code exists. It is reviewed first because it adds the dependency and changes the default path's wiring.
- Proof: `live.test.ts` assertions pass unchanged, and a test runs the real `CallService` on a `scripted` third layer and the real `LiveService` on a test webrtc layer, with no caller edit.

## Why

Covers AC1, AC2 (GPT half), AC3, AC4, and the fallback dispatch of AC6.

## Implement

- Install `effect@4.1.5` exact in `apps/linux/package.json`, update `pnpm-lock.yaml`. First read `node_modules/effect` and confirm `Context.Service`, `Layer`, `Effect.runSync`, `Scope`; adapt names. Stop and ask Isaac if it will not install or `bun build --compile` will not bundle it. `nix/hashes.json` `.root` needs `nix/update-hashes.sh` on Linux/Nix or CI; note it for the PR.
- `apps/linux/src/voice/engines.ts`: `VoiceEngine` union (`webrtc-sideband` with `api: LiveApi | null`; `pcm-websocket` with `open: PcmOpen | null`), `PcmOpen`/`PcmCall`/`PcmCallDeps` (the `VoiceCall` shape (`id/audio/mute/end/observe/start`; map typed `VoiceCall | PcmCall`), `start(): Promise<boolean>`), `EngineEnv = { agentHome, env }`, `VoiceEngines` `Context.Service` (`select(agent)`), `VOICE_ENGINE_LAYERS: Record<ProviderId, ...>`, `resolveVoiceEngines(layer)` via `Effect.runSync`, and `composeVoiceEngines(config, env, registry?)` holding the provider-id precedence and registry lookup; `main.ts` only calls it. Layers build synchronously; sessions open per call.
- `gptLiveLayer(env)` wraps existing `openAiKey` and `OpenAiLive`; those files are not changed.
- `host-config.ts`: optional `voice: { provider }` in `HostConfigFile`/`HostConfig` with zod enum `ProviderId` = `"gpt-live"` for now; `RELAY_VOICE_PROVIDER` overrides; default `gpt-live`.
- `live/service.ts`: replace `api` dep by `engines`; decline with `ended` + `fallback: true`: for a webrtc engine with `api === null` keep the existing "No OpenAI key" text and log; for a non-webrtc engine use a neutral text ("This host uses PCM calls") and log.
- `call/service.ts`: add `engines`, make `voice` nullable, guard `warm()`; on `call.start` use a pcm engine's `open`, fall back to `VoiceCall` when `open` is null or `start()` resolves false and `voice !== null`, else `ended` with today's text.
- `main.ts`: always build `CallService` when `assistant !== null`; resolve the layer from the registry once and pass the same `engines` to both services.
- `call/call.ts` `CallThread` gains optional `rows`/`memory` (type only) and the `main.ts` call-thread factory supplies them with the same lambdas the `LiveService` thread uses (`thread.snapshot().messages`, `readThreadMemory`), so Deepgram can build `liveBrief(title, memory, rows, clock)`; `VoiceCall` ignores them (~6 LOC).
- Update `LiveService` construction in `test/live.test.ts` and `test/live-standin.ts` (setup only; assertions unchanged).
- `apps/linux/test/voice-engines.test.ts`: resolver precedence and default; registry total over `ProviderId` (type-level plus runtime keys); GPT layer with and without key; default composition still builds `LiveCall` for `live.start` and `VoiceCall` for `call.start`, and a host with no engine and no voice answers the same `ended` text; **substitution** (through `composeVoiceEngines` with a registry override and through `resolveVoiceEngines(Layer)`, never a hand-built object): provide a `scripted` pcm layer (id `scripted`, scripted `PcmCall`) and a test webrtc layer in place of the registry layer, run real `CallService`/`LiveService`, assert dispatch, silent fallback when `start()` is false, and `live.start` declined under pcm.

## Do Not

- Do not touch `LiveCall`, `OpenAiLive`, `LiveApi`, `VoiceCall` behaviour or `session.ts`.
- Do not branch on a provider id in any caller; do not add a unified SDP/PCM API.
- Do not add Deepgram code or the `deepgram` enum literal here.

## Open Questions

### Q5: Choose the provider host-wide or per agent?
Type: ARCHITECTURE
Importance: LOW
Answer Format: SINGLE_SELECT
Options:
- Host-wide (host.json / env); `select(agent)` makes per-agent a one-line layer change
- Per-agent registry field like `liveVoice`
Comment: None
Agent Default: Host-wide.
Status: AGENT_DECIDED
Decision: Host-wide.

## Verify

- `voice-engines.test.ts` and `live.test.ts` pass; `call.test.ts` unchanged and green; `apps/linux` typecheck passes.
- One local `bun build --compile` bundles effect.
