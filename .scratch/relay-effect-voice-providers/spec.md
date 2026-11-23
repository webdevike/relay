# Relay iPhone call: GPT-Live and Deepgram Voice Agent as Effect-injected voice engines

Status: COMPLETE
Review Mode: CHECKPOINTS
Open Question Policy: AGENT_DEFAULTS
Complexity: 8

## For Isaac

### Outcome

Isaac's iPhone call to Nova or Astra runs on GPT-Live (default, unchanged) or Deepgram Voice Agent. Both are injected by `effect@4.1.5` `Context`/`Layer` at one host composition seam, chosen in host config, with local-call fallback and no app change. A third provider layer is swapped in at that same seam in a test, without touching the callers.

### Proposed Plan

- 01 Add `effect@4.1.5` and the seam: a transport-tagged `VoiceEngines` service, a layer registry, the GPT-Live layer (wrapping the existing `OpenAiLive`), and `LiveService`/`CallService` taking the engine instead of branching. A third test layer proves substitution.
- 02 Deepgram Voice Agent session as an Effect service (scoped socket, typed events, key by path).
- 03 XState machine for the new Deepgram call lifecycle only, plus its generated doc page.
- 04 Deepgram call over the existing PCM transport, and the Deepgram engine layer registered at the seam (config value plus one registry entry, no caller change).
- 05 Real smoke for both providers, Siri/Action Button doc, and the "next provider" recipe doc.

Complexity 8 (target 5, max 13): raised from 5 because Effect is now the injection mechanism for both engines, not one adapter. Budget: at most 1000 production LOC (expected 785), 24 files including tests, docs and lockfile (expected 21 unique files; per-issue counts sum to 23 because 01 and 04 share `host-config.ts` and `voice/engines.ts`; `call-smoke.ts` is the only possible extra), one new dependency (`effect`), three new abstractions (engine service and registry, Deepgram session service, call machine).

Budget note (Isaac, 2026-11-23): docs count toward the production LOC hard cap, which stays 1000. Issue maxima were rebalanced inside it (01 200, 02 240, 03 125 incl. the generated machine doc, 04 365, 05 70; sum 1000) and the code was trimmed to fit; final `measure` 990 of 1000.

### Decisions Needed

- Q2 (HIGH, needs your answer): Siri/Action Button under Deepgram. Recommended: keep the existing foreground fallback and document it. `LiveCallIntents.talk` calls `live.start`, the host declines with `fallback`, iOS asks "Open Relay to call Nova?", you tap, the app runs `call.start` into Deepgram. Cost: one foreground tap, no hands-free lock-screen start. Alternatives: native Swift PCM routing (about 400-600 LOC [INFERENCE], app rebuild) or not offering Deepgram to the intent path. Nothing is cut silently: GPT Siri is unchanged and the Deepgram behaviour is stated in the 05 doc and verified by the 04 decline test, the unchanged native fallback path (read, not run) and the 05 smoke; on-device Siri is not exercised.
- Q1 is settled by your instruction (new Deepgram lifecycle on XState; `LiveCall` and `VoiceCall` are not rewritten, not even for DI).

## Goal

Isaac's iPhone call to an assistant (Nova, Astra) runs on one of two real voice engines chosen per call at host composition: OpenAI GPT-Live (default, unchanged: phone WebRTC direct to OpenAI plus a host sideband) or Deepgram Voice Agent (binary PCM over a host WebSocket, reusing Relay's native PCM call transport and `call.*` protocol). Both are provided to the host as Effect `Layer`s of one `VoiceEngines` `Context` service at a single composition seam; the callers (`LiveService`, `CallService`) depend only on that service and on each engine's declared transport. Both keep the local-call fallback, assistant-thread semantics (delegated turns, replies, one memory thread, transcript continuity), interruption and cleanup. Provider keys never leave the host. Deepgram's new call lifecycle is an XState machine.

Parent source: the request from Nova plus Isaac's revision of 2026-11-23 (no external ticket). Base: `origin/main` 2a78e4a4.

## Acceptance Criteria

- [x] AC1 Default unchanged: with no provider configured, a phone `live.start` runs GPT-Live exactly as today (SDP offer, `live.answer`, sideband, delegation, commentary replies, `live.state`, resume grace, 30 min cap). `live.test.ts` assertions are unchanged; only its `LiveService` construction helper changes to the engine dependency.
- [x] AC2 Both engines are injected by Effect: `effect@4.1.5` `Context.Service` `VoiceEngines` is provided by a `Layer` for GPT-Live (`gptLiveLayer`) and a `Layer` for Deepgram (`deepgramLayer`), resolved once in `main.ts` from a layer registry keyed by the config provider id. Neither engine is constructed by an `if (provider === ...)` branch in `main.ts`, `LiveService`, `CallService` or `session.ts`.
- [x] AC3 Transport-honest boundary: `VoiceEngine` is a tagged union by transport (`webrtc-sideband` carries the `LiveApi`; `pcm-websocket` carries a PCM call opener). There is no unified SDP or PCM API. GPT keeps direct phone WebRTC plus host sideband; Deepgram keeps `call.*` PCM from the host WebSocket. Callers branch on `transport` only, never on a provider id.
- [x] AC4 Substitution proof: a test composes the real `LiveService` and `CallService` with a third test layer (`id: "scripted"`, transport `pcm-websocket`, scripted `PcmCall`) provided at the same seam as the real layers, and a `call.start` runs on it with no change to any caller. The test also runs a `webrtc-sideband` test layer through `live.start`. A recipe doc states exactly what a next supported-transport provider changes (see Next provider).
- [x] AC5 Deepgram works for real: with Deepgram selected a phone `call.start` runs a Deepgram Voice Agent session on the host (PCM16 16 kHz in, PCM16 24 kHz out over `call.audio`, no SDP), hears the user, delegates to the assistant thread and speaks its replies; the key stays host-only.
- [x] AC6 Fallback kept: no key or a failed start falls back to the existing local `VoiceCall` for Deepgram, and to `ended`+`fallback` for GPT-Live; with a pcm engine selected `live.start` declines with `fallback` and `call.start` is served.
- [x] AC7 Assistant-thread semantics and interruption hold for both: heard words reach the thread as `voiceTurn`s, only replies to the call's turns are spoken, `[[details]]` and `SILENCE_MARKER` honoured; user speech over the voice stops playback and drops stale replies (Deepgram: `UserStartedSpeaking` to `call.flush` generation).
- [x] AC8 Cleanup is single-path and tested for the new Deepgram call: hang-up, socket loss, provider drop, failed start and the cap each close the session and every timer once and report one terminal state.
- [x] AC9 Deepgram lifecycle is an XState v5 machine with a generated `docs/state-machines/` page. `LiveCall` and `VoiceCall` lifecycles are not rewritten, including not for DI. Effect appears at the composition seam, in both engine layers, and in Deepgram provider I/O; not inside `LiveCall`, `OpenAiLive` internals, `VoiceCall`, the machine file, or the service method bodies.
- [x] AC10 Siri/Action Button: Isaac's decision (recommended: existing foreground fallback, documented) is implemented and verified as far as the host can: the 04 decline test, the unchanged native fallback path (read in code, not run) and the 05 smoke; on-device Siri is not exercised. GPT path unchanged.
- [x] AC11 Focused automated tests per layer plus a real smoke per provider (GPT-Live with `live-smoke.ts`; Deepgram with `call-smoke.ts`), keys by path only, never printed.

## Constraints

- Planning only until Isaac approves: no production edits, no install, publish, deploy, push or credential use. This revision touches only `.scratch/relay-effect-voice-providers`.
- Isolation: worktree `~/Eva/work/relay-effect-voice-providers`, branch `eva/relay-effect-voice-providers`, from `origin/main` 2a78e4a4.
- Effect: `effect@4.1.5` exact (npm `latest`, verified 2026-11-23). Names in this plan (`Context.Service`, `Layer`, `Scope`, `Stream`, `ManagedRuntime`/`Effect.runSync`, `effect/testing` `TestClock`) come from notes, not an installed copy: issue 01 confirms them from `node_modules/effect` before writing code and adapts. If `Context.Service` or the Layer API differ, adapt names only; if Effect 4.1.5 cannot be installed or does not bundle under `bun build --compile`, stop and ask Isaac. The monorepo has no Effect today: lockfile change plus a Nix hash (`nix/hashes.json`, `nix/update-hashes.sh`, Linux/Nix only).
- Engine layers must build synchronously (key read, factory). Sessions open per call in their own scope, never in layer acquisition, so the host resolves layers once with `Effect.runSync`.
- XState convention (`docs/conventions/state-machines.md`): `<name>.machine.ts` + test + `docs/state-machines/<name>.md`, registered in `apps/linux/test/machine-docs.test.ts`.
- Do not rewrite the existing GPT or local call lifecycles. Wrapping `OpenAiLive` in a Layer and changing what `LiveService`/`CallService` receive in their deps is allowed; changing `LiveCall`, `OpenAiLive` internals or `VoiceCall` is not.
- Keys: `OPENAI_API_KEY` / `<agent home>/secrets/openai.env` (existing); Deepgram key `~/Eva/secrets/deepgram.env` by path only, never copied, logged or echoed.
- No mid-call swap. No mobile or Swift change unless a mandatory finding says otherwise; older installed apps keep working (no protocol change).

## Next provider

A new provider on an already supported transport changes exactly:

1. A new `<provider>.ts` exporting `<provider>Layer(env): Layer<VoiceEngines>` that builds a `VoiceEngine` of an existing transport (and its session code).
2. One literal in the host-config provider enum (`host-config.ts`) and one entry in the `VOICE_ENGINE_LAYERS` registry (`voice/engines.ts`).
3. Its own tests plus a smoke run.

It does not change `LiveService`, `CallService`, `session.ts`, `main.ts`, the protocol or the phone. A provider needing a new transport adds a union variant to `VoiceEngine`, the matching wire frames and one caller case: that is a new design, not a layer swap, and this plan does not pretend otherwise. Issue 04 is the live proof: its diff may touch `voice/engines.ts` and `host-config.ts` by one line each and no caller.

## Spike

### Relevant Existing Code

- `apps/linux/src/call/service.ts: CallService.receive("call.start")` — the PCM engine seam. It builds one `VoiceCall` per sink from `deps.thread/voice/clock`, wires `call.audio`/`call.mute`/`call.end` to `call.audio()/mute()/end()`, `drop(sink)` hangs up, `observe(change)` fans provider changes. `calls.get(sink)` is typed `VoiceCall`; only `id/audio/mute/end/observe` are used, so a second engine only needs that shape.
- `apps/linux/src/call/call.ts: VoiceCall` — local engine. `CallDeps.send` emits `call.state`/`call.audio`/`call.flush`; `gen` counter + `bargeIn()` is the flush protocol; `heard()` -> `thread.turn(voiceTurn(text))`; `observe()` + `awaiting/sawWorking/TURN_START_GRACE_MS/turnDone()` is the thread bridge; `reply()` feeds `ReplySpeech` (`call/speech.ts`: sentence streaming, `plainSpeech`, SILENCE_MARKER and `[[details]]` handling). `CallDeps` has `voice: VoiceStack` (ears+filler+speak) which Deepgram does NOT fit: Deepgram bundles ears, LLM and TTS. `CallThread` has `voice?` (pocket-tts) only.
- `apps/linux/src/live/call.ts: LiveCall` — GPT engine. Has the identical thread bridge (`observe`, `awaiting/sawWorking/turnDone`, `reply` with `spokenPartComplete`, `plainSpeech`, `SILENCE_MARKER`, `MAX_COMMENTARY_CHARS`) plus GPT-only parts: sideband events (`event()`: `session.input_transcript.delta`/`output_transcript.delta` with `start_ms/end_ms`, `session.delegation.created`, `session.started` greeting), `delegate()` (`heard/handedOver/delegatedUpTo/withQuestion/TRANSCRIPT_WAIT_MS`), `tick()`, `close()/CLOSE_WAIT_MS`, `MAX_LIVE_CALL_MS` cap, `resendState()`. Its prompt `liveInstructions(title)` and `liveBrief` (`live/brief.ts`) are reusable text for Deepgram `agent.think.prompt`/context.
- `apps/linux/src/live/service.ts: LiveService` — `api === null` => `ended` + `fallback:true` on `live.start`; resume grace `LIVE_RECONNECT_GRACE_MS` (GPT only; PCM calls die with the socket, `CallService.drop`).
- `apps/linux/src/live/openai.ts: openAiKey(agentHome, env)` — key precedent: `$OPENAI_API_KEY` then `<agentHome>/secrets/openai.env` (`OPENAI_API_KEY=` line). `LiveApi`/`OpenAiLive` is the GPT I/O seam (`create(config, offer)`, `attach(sessionId, events)`).
- `apps/linux/src/main.ts:637-693` — composition: `voice` (`EvaRealtimeVoice`) is null unless `featureOn(config,"voiceLocal", existsSync(voiceRoot))`; `calls` is null when `voice === null`; `liveKey = openAiKey(agentHome)`; `LiveService` always built, `api` null without key; `voice: (agent) => liveVoiceFor(...RELAY_LIVE_VOICE)`. `apps/linux/src/session.ts:943-970` routes `call.*` and `live.*`; a null `calls` answers `call.state ended "This host cannot take calls"` (no fallback flag) — so Deepgram without local voice stack needs `CallService` to exist.
- `apps/linux/src/host-config.ts: HostConfigFile/HostConfig` (zod, `features` record) + `featureOn`; precedent for per-host switches (`RELAY_LIVE_VOICE`, registry `liveVoice` in `assistant/registry.ts: liveVoiceFor`).
- `packages/protocol/src/index.ts:1008-1070` — `CALL_INPUT_RATE=16000`, `CALL_OUTPUT_RATE=24000`, `MAX_CALL_AUDIO_BASE64`, `CallState` (connecting/listening/hearing/thinking/speaking/ended), `LiveState`, `MAX_LIVE_CALL_MS`. Deepgram `Settings.audio` (linear16 16000 in / 24000 out, container none) matches these rates exactly: zero resampling.
- Phone (read, not changed): `apps/mobile/src/call/live.ts: startVoiceCallNow` (native `LiveCall.start` first; `outcome==="fallback"` -> `consumePendingFallback()` -> `startCall`), `runPendingFallback()` (Siri path re-entry), `apps/mobile/src/call/controller.ts` + `apps/mobile/modules/voice-call` (PCM mic base64 in, `call.audio`/`call.flush` playback). `apps/mobile/modules/live-call/ios/LiveCallEngine.swift: start/connect` order: `requireMicrophone` -> `startAudio` -> `makePeer`/offer -> `link.connect` -> `live.start` -> wait `answer`; any `LiveCallFailure.fallback` goes through `finish(run, error, fallback:true)` and returns `.fallback`. The `live.start` host reply `ended`+`fallback` (swift ~549: `frame["fallback"] == true` -> `failWaits(.fallback)`) is handled with no app change.
- `apps/mobile/plugins/intents/LiveCallIntents.swift: talk(to:)` -> `LiveCallEngine.shared.toggle(agent)` -> `.fallback` -> `requestToContinueInForeground("Live calls aren't available right now. Open Relay to call <Name>?")`, declined -> `discardPendingFallback()`. `LiveCallHostLink` sends only `live.*` frames; `VoiceCallModule` (PCM) is a separate JS-driven module the engine does not use.
- Tests/smokes: `apps/linux/test/call.test.ts` (FakeClock/FakeVoice/FakeThread, `VoiceCall`), `live.test.ts` (FakeApi, `LiveCall`+`LiveService`), `call-smoke.ts` (real host `call.*` with WAV mic, `--barge`), `live-smoke.ts`+`live_phone.py`, `machine-docs.test.ts` `MACHINES` list, `apps/linux/src/meetings/key-moments.machine.ts` + `key-moments.ts` (only host machine: `setup()` machine, `fromPromise` actors, `ActorOptions.clock` = `SessionClock` in service, `SimulatedClock` in tests) — the pattern to copy. `apps/linux/package.json` already has `xstate 5.33.0`, no `effect`; `apps/mac-host/build.sh:19` `bun build --compile` bundles deps; `nix/update-hashes.sh` recomputes `.#relay-host.rootPnpmDeps` after any `pnpm-lock.yaml` change (Linux+Nix only).

### Recommended Implementation

Keep GPT and local lifecycles as they are; introduce one small Effect seam both engines plug into, then add Deepgram as the second engine behind it.

1. **Engine boundary (honest, not SDP- or PCM-shaped).** New `apps/linux/src/voice/engines.ts`:
   - `VoiceEngine = WebrtcSidebandEngine | PcmWebSocketEngine`. `WebrtcSidebandEngine { id; transport: "webrtc-sideband"; api: LiveApi | null }` (null = no key). `PcmWebSocketEngine { id; transport: "pcm-websocket"; open: PcmOpen | null }` (null = no key). `PcmOpen(deps: PcmCallDeps): PcmCall`, with `PcmCall` the `VoiceCall` shape the service already uses (`id/audio/mute/end/observe/start`; `CallService.observe` fans provider changes to every call; the map is typed `VoiceCall | PcmCall` and only the pcm branch uses the boolean) where `start(): Promise<boolean>` resolves false if the engine never connected and sent the phone nothing, so `CallService` can fall back silently.
   - `VoiceEngines extends Context.Service<VoiceEngines, { select(agent: string): VoiceEngine }>`: the transport-tagged selection service. Per-agent selection becomes a one-line change inside a layer.
   - `EngineEnv = { agentHome: string | null; env: NodeJS.ProcessEnv }`, `VOICE_ENGINE_LAYERS: Record<ProviderId, (env: EngineEnv) => Layer<VoiceEngines>>`, `resolveVoiceEngines(layer)` (`Effect.runSync` over the layer, returns the plain service value) and `composeVoiceEngines(config, env, registry = VOICE_ENGINE_LAYERS)`, the one function `main.ts` calls once (precedence host.json then `RELAY_VOICE_PROVIDER` then default, registry lookup, resolve), so the seam is testable without `main.ts`. `ProviderId` is the zod enum in `host-config.ts`; `Record<ProviderId, ...>` makes a missing registry entry a type error.
2. **GPT-Live layer.** `gptLiveLayer(env)` builds `{ id: "gpt-live", transport: "webrtc-sideband", api: key === null ? null : new OpenAiLive(key) }` using the existing `openAiKey`. `OpenAiLive`, `LiveApi`, `LiveCall` untouched.
3. **Callers.** `LiveServiceDeps.api` becomes `engines: Pick<VoiceEngine service>`. `live.start`: engine = `select(agent)`; if `transport !== "webrtc-sideband"` or `api === null`, answer `ended` + `fallback: true` (the existing `api === null` path, same log shape). `CallServiceDeps` gets `engines` and a nullable `voice`; `call.start`: a `pcm-websocket` engine with `open !== null` gets `open(...)`; if its `start()` resolves false, or the engine is not pcm or has no key, and `voice !== null`, build the existing `VoiceCall`; with neither, answer `ended` ("This host cannot take calls", today's text). `CallService` is always built when `assistant !== null`; `warm()` guards a null `voice`. No caller mentions a provider id.
4. **Composition.** `main.ts` resolves the provider id once (`host.json voice.provider`, `RELAY_VOICE_PROVIDER` overrides, default `gpt-live`), takes `VOICE_ENGINE_LAYERS[id]`, resolves it, and passes the same `engines` to both services. This one place is the composition seam. Default composes to the same behaviour as today.
5. **Deepgram session = Effect service.** `apps/linux/src/call/deepgram.ts`: `DeepgramAgent` `Context.Service` with `open(config): Effect<AgentSession, DeepgramError, Scope>`; `Effect.acquireRelease` socket (`wss://agent.deepgram.com/v1/agent/converse`, `Authorization: Token <key>`, close and terminate on scope close), `Settings` first, `SettingsApplied` under `Effect.timeout` (~8 s), typed `AgentEvent` stream (zod-parsed JSON; binary = PCM), sanitised `DeepgramError`, `deepgramKey(agentHome, env)` beside it, `layerTest(script)`.
6. **Deepgram call and engine layer.** `call/deepgramCall.ts` (a `PcmCall`) runs the XState machine with `clock: deps.clock` (pattern `meetings/key-moments.ts`); one `fromCallback` actor forks the Effect session and interrupts the fiber on cleanup (socket closes once). Thread bridge inline: `ConversationText` finals, `FunctionCallRequest` (`ask_assistant`, `defer_until_eot`), exact user words to `thread.turn(voiceTurn(text))` once, immediate `FunctionCallResponse`, settled reply spoken sentence by sentence via `InjectAgentMessage`, `UserStartedSpeaking` to `call.flush`. `deepgramLayer(env)` provides `{ id: "deepgram", transport: "pcm-websocket", open }`. Prompt from `liveInstructions(title)`, context from `liveBrief`.
7. **Siri/Action Button.** Unchanged native path: `LiveCallIntents.talk` to `LiveCallEngine.toggle` to `live.start`, declined with `fallback` under a pcm engine, then `requestToContinueInForeground("Live calls aren't available right now. Open Relay to call Nova?")`, then `runPendingFallback` to `startCall` to `call.start`. Recommended and documented in 05; the in-app path pays a declined `live.start` (Live Activity flash, about 0.3-1 s [INFERENCE, measured in smoke]). Native Swift PCM routing is deferred unless Isaac chooses it (Q2).
8. **Effect dependency.** `apps/linux/package.json` `"effect": "4.1.5"` exact, lockfile, `nix/hashes.json` `.root` via `nix/update-hashes.sh` on Linux/Nix or CI (not runnable on this Mac); one local `bun build --compile` check that effect bundles [INFERENCE: pure ESM].
9. **Tests.** `voice-engines.test.ts` (resolver precedence, registry total over `ProviderId`, GPT layer, `live.start`/`call.start` dispatch by transport, key missing falls back, **third-layer substitution**: `scripted` pcm layer through real `CallService`, a test webrtc layer through real `LiveService`, neither caller modified); `deepgram.test.ts`; `deepgramCall.machine.test.ts` + `machine-docs.test.ts`; `deepgram-call.test.ts`. Existing `live.test.ts` assertions and `call.test.ts` stay unchanged; only `LiveService` construction in `live.test.ts` and `live-standin.ts` moves to `engines`.

### Reuse Opportunities

- `CallService` + `call.*` frames + `CallState` + `call.flush` generation + `CALL_INPUT_RATE`/`CALL_OUTPUT_RATE`: whole PCM transport, zero phone change.
- `LiveApi`/`OpenAiLive`/`openAiKey`: wrapped, not changed, by `gptLiveLayer`.
- `ReplySpeech`, `plainSpeech`, `speakable`, `sentences` (`call/speech.ts`), `voiceTurn/spokenPartComplete/SILENCE_MARKER/DETAILS` (`assistant/voice.ts`).
- `liveInstructions`, `liveBrief`, `clockLine` (`live/call.ts`, `live/brief.ts`): Deepgram prompt and context text.
- `VoiceCall` structure as the template for `DeepgramCall`; `meetings/key-moments.ts` + `.machine.ts` and `machine-docs.test.ts` registry as the machine template.
- `RELAY_LIVE_VOICE`/`featureOn` precedent for env plus host.json.
- Phone's `ended`+`fallback` to `consumePendingFallback` to `startCall`, and `runPendingFallback`: Siri and in-app fallback with no change.
- `call-smoke.ts` and `live-smoke.ts` as the two real smokes.

### Things We Should NOT Build

- A unified SDP-and-PCM provider API, or an engine interface that hides transport. The union is tagged by transport on purpose.
- An Effect rewrite of `LiveCall`, `OpenAiLive` internals, `VoiceCall` or the call lifecycles for DI.
- Any protocol change, new frame, mobile UI or Swift change; no `live.*` PCM variant.
- A `VoiceStack`-shaped Deepgram adapter (ears/filler/speak): it would discard Deepgram's turn-taking.
- An Effect-to-XState framework (one `fromCallback` that forks and interrupts a fiber is enough).
- Mid-call swap, failover chains beyond "Deepgram fails to local `VoiceCall`", reconnect or resume grace for Deepgram, a Deepgram SDK, a bespoke TTS/STT client.
- A shared thread-bridge module with one consumer (bridge lives in `deepgramCall.ts`).

### Risks / Unknowns

- R1 (MEDIUM): Effect 4.1.5 API names unverified here (new major; v3 docs differ). 01 reads `node_modules/effect` first; stop and ask if it cannot install or bundle.
- R2 (MEDIUM): Nix hash can only be recomputed on Linux/Nix; CI or the PR waits. `bun --compile` bundling unverified.
- R3 (MEDIUM): Deepgram client-side `FunctionCallRequest` timeout undocumented; mitigated by immediate `FunctionCallResponse` and literal `InjectAgentMessage` replies. Injection while speaking (`queue` vs `InjectionRefused`) and survival across `UserStartedSpeaking` need the real smoke (05).
- R4 (MEDIUM): Deepgram needs continuous audio; muted PCM calls must send silence frames or `KeepAlive` every 8 s.
- R5 (MEDIUM): moving `LiveService` and `CallService` to the engine dependency touches the default path (`main.ts` composition, four `LiveService` construction sites: `main.ts`, `live.test.ts` twice, `live-standin.ts`). Mitigation: `live.test.ts` assertions unchanged, plus a default-composition test that `live.start` still builds a `LiveCall` and `call.start` still builds a `VoiceCall`.
- R6 (MEDIUM): `CallService` becoming always-built changes `session.ts` null-calls behaviour only in message path; the `ended` text for a host with no engine and no voice is kept identical in a test.
- R7 (LOW): declined `live.start` cost under Deepgram (about 0.3-1 s [INFERENCE]); measured in 05; an OTA `welcome.features` skip is not planned.
- R8 (LOW): Deepgram's managed LLM may answer without delegating; the reused `liveInstructions` prompt is the lever, settled by smoke.
- R9 (LOW): secrets: the key is read only in the host; `DeepgramError` is sanitised; never in logs, settings or `welcome`.

### Proposed Atomic Subissues

1. **Effect seam, GPT-Live layer, caller cutover, substitution proof.** `effect@4.1.5`, `voice/engines.ts`, `host-config.ts` enum (`gpt-live` only), `main.ts`, `live/service.ts`, `call/service.ts`, test construction updates, `voice-engines.test.ts` incl. third layer. (~175 LOC.)
2. **Deepgram Voice Agent session as an Effect service.** `call/deepgram.ts` incl. `deepgramKey`, test layer, `deepgram.test.ts`. (~200 LOC; depends on 01.)
3. **Deepgram call XState machine + docs.** (~110 LOC; independent.)
4. **Deepgram call over PCM and `deepgramLayer`.** `deepgramCall.ts`, layer, enum literal and registry entry; no caller change. (~300 LOC; depends on 01, 02, 03.)
5. **Real smoke, Siri scope doc, next-provider doc.** (docs only, 0 production LOC; depends on 04.)

Rough total: ~785 production LOC (docs excluded), 1 dependency, 1 machine, 2 Effect services plus the registry.

## Plan Review

Status: APPROVED

Revision 2 re-reviewed twice by eva-spec-plan-reviewer. Fixes landed: `PcmCall.observe`; `CallThread` rows/memory in 01 so Deepgram can build `liveBrief`; `composeVoiceEngines`/`EngineEnv` so the seam is testable and the substitution test goes through `resolveVoiceEngines(Layer)`; Deepgram machine renamed `deepgramCall.machine`; four `LiveService` construction sites; neutral decline text under a pcm engine; Siri verification wording narrowed; budgets reconciled (785 expected, issue maxima sum to the 1000 cap, 21 unique files, cap 24). Callers branch on transport only; no scope silently cut. Machine approval only; human approval is PENDING.

## Human Feedback

Status: ADDRESSED

### 2026-11-23T16:30:00Z
> Docs COUNT toward the parent production LOC hard cap (1000). `eva-spec measure` reports 1056 (code 985 + docs/relay/voice-providers.md 71). Cap stays 1000, do not raise it. Get the parent to <= 1000 without dropping any acceptance criterion; prefer removing duplication and non-required code over gutting the doc; keep the Siri/Action Button section and the Next provider recipe. No behaviour or protocol change, no new abstractions.

Response: Cap kept at 1000; `measure` now 990. Removed 66 production lines with no behaviour change: `deepgramCall.ts` 391 to 359 (the hand-rolled xstate clock adapter replaced by the `meetings/service.ts` pattern, where the timer id is the `SessionClock.after` cancel; the one-use `agentId` getter; header prose repeated from the doc), `deepgram.ts` 263 to 240 (`DeepgramError` carries `message` directly instead of `reason` plus a getter; one-use `bytes` helper inlined; KeepAlive fork on fewer lines; restating comments), `voice/engines.ts` 112 to 103 (`gptLiveLayer` builds through the existing `engineLayer`; merged duplicate import; the provider recipe in the header now points at the doc), doc 71 to 69 (dropped a sentence restating `engines.ts`). Siri/Action Button section and the provider recipe are unchanged. Issue maxima rebalanced inside 1000 (see the budget note).

## Parent Completion

### Status
COMPLETE

### Acceptance Criteria
- PASS — AC1 `live.test.ts` 21 tests pass with assertions unchanged (construction helper only); default composition resolves `gpt-live` (`voice-engines.test.ts`); GPT-Live host check and `live-smoke.ts` passed in 05 (`smoke/evidence/gpt-host-check`, `gpt-live-smoke`; not rerun in the budget pass, which touched no GPT code path beyond `gptLiveLayer` building through `engineLayer`, covered by `voice-engines.test.ts`).
- PASS — AC2 `composeVoiceEngines` resolves `VOICE_ENGINE_LAYERS[id]` once in `main.ts`; `gptLiveLayer` and `deepgramLayer` are `Layer`s of `VoiceEngines`; no provider-id branch in callers (`voice-engines.test.ts`).
- PASS — AC3 `VoiceEngine = WebrtcSidebandEngine | PcmWebSocketEngine`; `LiveService` and `CallService` branch on `transport` only.
- PASS — AC4 `voice-engines.test.ts` runs a `scripted` pcm layer through the real `CallService` and a `sip` webrtc layer through the real `LiveService`; recipe in `docs/relay/voice-providers.md` § Add a provider on a supported transport.
- PASS — AC5 Real isolated Deepgram smoke rerun after the trim (`smoke/evidence/dg-normal-budget`): heard the question verbatim, delegated to the thread, reply spoken, key read by path.
- PASS — AC6 `voice-engines.test.ts` and `deepgram-call.test.ts` (no key, failed start, pcm decline of `live.start`); real no-key, rejected-key and declined-`live.start` runs in 05 (`dg-nokey`, `dg-badkey`, `dg-live-declined`, `gpt-nokey`).
- PASS — AC7 `deepgram-call.test.ts` (voice turns, details/silence, barge flush and stale-reply drop); real barge smoke rerun (`smoke/evidence/dg-barge-budget`: `flushes: 1`, host `barge-in`).
- PASS — AC8 `deepgram-call.test.ts` and `deepgramCall.machine.test.ts` cover hang-up, socket loss, provider drop, failed start and cap; both reruns end with one `ended after N s` and only the listener socket left.
- PASS — AC9 `deepgramCall.machine.ts` plus `docs/state-machines/deepgram-call.md` (`machine-docs.test.ts` pass); `LiveCall`, `OpenAiLive`, `VoiceCall` untouched.
- PASS — AC10 Foreground fallback implemented and documented (`docs/relay/voice-providers.md` § Siri, Action Button and the lock screen); decline test and 05 smoke; on-device Siri not exercised.
- PASS — AC11 Unit tests per layer (80 in the targeted set); real smokes per provider (GPT in 05, Deepgram rerun here), keys by path, never printed (evidence grep for key material: none).

### Planned Complexity
- Score: 8
- Production LOC: 785 / 1000 (docs count, Isaac 2026-11-23)
- Files: 21 / 24

### Actual Complexity
- Production LOC added: 990
- Production LOC deleted: 31
- Net LOC: 959
- Test LOC added: 723
- Files touched: 21 (per `measure`; `apps/linux/test/call-smoke.ts`, the allowed extra, is a test tool)
- Dependencies added: 1 (`effect@4.1.5`)
- Abstractions added: 3 (`VoiceEngines` service and registry, `DeepgramAgent` session service, `deepgramCall` machine)

### Subissues
- Planned: 5
- Completed: 5
- Added during implementation: none
- Removed or changed: issue maxima rebalanced inside the unchanged 1000 cap after docs started counting (01 200, 02 240, 03 125, 04 365, 05 70)

### Verification
- `npx vitest run test/deepgram-call.test.ts test/deepgram.test.ts test/voice-engines.test.ts test/deepgramCall.machine.test.ts test/machine-docs.test.ts test/live.test.ts test/call.test.ts` (apps/linux) — PASS (7 files, 80 tests)
- `npx tsc --noEmit -p tsconfig.json` (apps/linux) — PASS for changed files (0 errors in `call/deepgram.ts`, `call/deepgramCall.ts`, `voice/engines.ts`); 8 errors remain in files this pass did not touch (`desktop/.../portrait.ts`, `expo-sound.test.ts`, `machine-docs.test.ts:31` duplicate xstate copies, `widget-runtime/theme.ts`)
- `npx eslint src/call/deepgramCall.ts src/call/deepgram.ts src/voice/engines.ts` — PASS
- `bun build --compile --target=bun-darwin-arm64 src/main.ts` — PASS (897 modules)
- `smoke/run.sh dg-normal-budget deepgram 1500 -- bun test/call-smoke.ts --agent smoke --greeting --wav ask.wav ...` — PASS (isolated host, key by path: `done`, heard verbatim, first reply sentence +1527 ms, `ended after 15 s`, listener only)
- `smoke/run.sh dg-barge-budget deepgram 1500 -- bun test/call-smoke.ts --agent smoke --greeting --wav ask.wav --barge barge.wav --barge-speaking 2 ...` — PASS (`flushes: 1`, host `barge-in`, `ended after 19 s`, listener only)
- `bun .omp/tools/eva-spec.ts measure .scratch/relay-effect-voice-providers` — 990 / 1000
- `bun .omp/tools/eva-spec.ts check .scratch/relay-effect-voice-providers` — PASS ("Valid")

### Simplification
- xstate clock adapter replaced by the existing `meetings/service.ts` pattern; `agentId` getter, `bytes` helper and `DeepgramError` message getter removed; `gptLiveLayer` reuses `engineLayer`; duplicated header prose replaced by a pointer to the doc.

### Final Result
Goal achieved inside the approved envelope: 990 of 1000 production LOC with docs counted, 21 of 24 files, every acceptance criterion passing.
