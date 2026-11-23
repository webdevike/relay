# Relay iPhone call: interchangeable GPT-Live and Deepgram Voice Agent providers on Effect

Status: PLANNING
Review Mode: CHECKPOINTS
Open Question Policy: AGENT_DEFAULTS
Complexity: 5

## For Isaac

### Outcome

Isaac's iPhone call to Nova or Astra can run on GPT-Live (default, unchanged) or Deepgram Voice Agent, chosen in host config, with local-call fallback and no app change.

### Proposed Plan

- 01 Choose the provider in host config and route `live.start`/`call.start` (GPT stays default).
- 02 Add the Deepgram Voice Agent session on `effect@4.1.5` (only Effect use).
- 03 Add the XState provider-call machine and its generated doc page.
- 04 Run Deepgram calls over the existing PCM transport (turn bridge inline) with fallback, barge-in and single cleanup.
- 05 Real smoke for both providers and Siri/Action Button documentation.

Complexity 5 (target 5). Budget: at most 900 production LOC (expected 700) and 17 files, one new dependency (`effect`), two new abstractions (machine, Effect service).

### Decisions Needed

- Q1 (HIGH): Should the machine drive only the Deepgram call (default) or also migrate GPT/local calls?
- Q2 (HIGH): Siri/Action Button under Deepgram: foreground handoff and document (default), native Swift routing, or not offered?

## Goal

Isaac's iPhone call to an assistant (Nova, Astra) runs on one of two real, interchangeable voice providers, chosen per call at host composition/config: OpenAI GPT-Live (default, unchanged: phone WebRTC direct to OpenAI plus a host sideband) or Deepgram Voice Agent (binary PCM over a WebSocket, reusing Relay's native PCM call transport and `call.*` protocol). Both keep the existing local-call fallback, the assistant-thread semantics (delegated turns, replies, one memory thread, transcript continuity), interruption, delegate replies and cleanup. Provider keys never leave the host. Built on the latest stable Effect (`effect` 4.1.5, npm dist-tag `latest`, verified 2026-11-23) where it earns its place, with XState owning each call's lifecycle.

Parent source: the request from Nova (no external ticket). Base: `origin/main` 2a78e4a4 (one commit past `work/relay-runtime` ebbfa9af, which is its ancestor).

## Acceptance Criteria

- [ ] AC1 Default unchanged: with no provider configured, a phone `live.start` runs GPT-Live exactly as today (SDP offer, `live.answer`, sideband, delegation to the thread, replies as commentary, `live.state`, resume grace, 30 min cap); existing `live.test.ts` behavior holds.
- [ ] AC2 Deepgram works for real: with the Deepgram provider selected, a phone `call.start` runs a Deepgram Voice Agent session on the host (PCM16 16 kHz in, PCM16 24 kHz out over the existing `call.audio` frames, no SDP), hears the user, delegates to the assistant thread and speaks its replies; the Deepgram key stays host-only.
- [ ] AC3 Provider is chosen per call at host composition/config (default `gpt-live`); no mid-call swap; no mobile UI change; neither provider requires SDP of the other.
- [ ] AC4 Fallback kept: no key or a failed provider start falls back to the existing local call (`call.*` local `VoiceCall`), for both providers; GPT's `ended`+`fallback` path still works.
- [ ] AC5 Assistant-thread semantics preserved for both: heard words reach the thread as `voiceTurn`s (in chat and memory), only replies to the call's turns are spoken, `[[details]]` and `SILENCE_MARKER` honored, the call returns to listening when the turn ends or never starts.
- [ ] AC6 Interruption works for both: user speech over the voice stops playback and drops stale replies (GPT: provider-native; Deepgram: `UserStartedSpeaking` -> `call.flush` generation) and a late reply to an interrupted turn is not spoken.
- [ ] AC7 Cleanup is single-path and tested for both: hang-up, socket loss past grace, provider drop, failed start, and the cap each close the provider session and every timer exactly once and report one terminal state.
- [ ] AC8 Call lifecycle is an XState v5 machine with a generated `docs/state-machines/` page; Effect is used for provider I/O and resource scope per the repo convention (no second convention, one dependency).
- [ ] AC9 Siri/Action Button (non-app) path: scope documented from code evidence; whatever the plan chooses is verified (GPT path unchanged; Deepgram path behavior stated and tested or explicitly deferred by Isaac).
- [ ] AC10 Focused automated tests per provider plus a real smoke plan and run per provider (GPT-Live with the existing `live-smoke.ts`; Deepgram with a real PCM smoke), keys by path only, never printed.

## Constraints

- Planning only until Isaac explicitly approves the plan: no production edits, no install, no publish, deploy, push, or credential use.
- Isolation: worktree `~/Eva/work/relay-effect-voice-providers`, branch `eva/relay-effect-voice-providers`, from `origin/main` 2a78e4a4.
- Effect: `effect@4.1.5` exact (latest stable; dist-tags verified; `prev` is 3.22.5). The monorepo has no Effect today; adding it adds a lockfile change and a Nix fixed-output hash (`nix/hashes.json`, `nix/update-hashes.sh`).
- XState convention (`docs/conventions/state-machines.md`): lifecycle in `<name>.machine.ts` + test + `docs/state-machines/<name>.md`, registered in `apps/linux/test/machine-docs.test.ts`.
- GPT uses direct phone WebRTC + host sideband; do not push audio of GPT through the host. Deepgram uses binary PCM on a WebSocket from the host; do not require SDP of Deepgram.
- Keys: `OPENAI_API_KEY` / `<agent home>/secrets/openai.env` (existing); Deepgram key in `~/Eva/secrets/deepgram.env`, referenced by path, never copied into the repo, logged, or echoed.
- No mid-call hot swap. No mobile UI unless a mandatory finding says otherwise.
- Phone binary compatibility: older installed apps must keep working against the new host (no protocol break; additive only).

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

Smallest coherent change: keep GPT exactly as is; add Deepgram as a second engine behind the existing `call.*` protocol, chosen by `call.start`; make `live.start` decline under Deepgram so the phone's existing fallback lands on `call.start`. No protocol, mobile or Swift change.

1. **Provider contract (not SDP-shaped).** There is no generic provider interface and none is needed. The provider-agnostic seam already exists at the WIRE level: phone speaks `live.*` (SDP/WebRTC engine) or `call.*` (PCM engine); the host picks engine behind each. What is shared between engines is the **thread bridge**: `thread.turn(voiceTurn(text))`, `awaiting/sawWorking/TURN_START_GRACE_MS/turnDone`, `observe()` -> settled reply -> `plainSpeech`/`SILENCE_MARKER`/`[[details]]` -> say, end/cleanup-once, state reporting. Provider-specific: GPT = timeline transcript + `session.delegation.created` + `commentary.append`; Deepgram = `ConversationText` + `FunctionCallRequest` + `InjectAgentMessage` + PCM. The bridge is currently copy-pasted in `VoiceCall` and `LiveCall`; Deepgram would be the third copy. So: one new XState machine `apps/linux/src/call/providerCall.machine.ts` (pure; states `connecting`, `listening`, `hearing`, `thinking`(awaiting; guard sawWorking, delay `turnGrace` 20 s), `speaking`, `ended`; events `provider.ready`, `user.started`, `user.turn`, `thread.working`, `thread.idle`, `reply.say`, `provider.dropped`, `phone.mute`, `hangup`, `cap`; `delays` for grace/cap; one terminal `ended` entry action = close provider scope once + report once). Deepgram's call runtime drives it; `LiveCall` migration onto the same machine is the LAST, optional subissue (risk to AC1; `live.test.ts` is the oracle) — see Decisions.
2. **Deepgram session = Effect module.** `apps/linux/src/call/deepgram.ts` exposes `DeepgramAgent` (`Context.Service`) with `open(config): Effect<AgentSession, DeepgramError, Scope>`. Inside: `Effect.acquireRelease` on the `WebSocket` (`wss://agent.deepgram.com/v1/agent/converse`, `Authorization: Token <key>`, close frame + terminate on scope close), send `Settings` first, wait for `SettingsApplied` bounded by `Effect.timeout` (start timeout ~8 s -> `DeepgramError` -> fallback). Events leave as a `Queue`/`Stream` of typed `AgentEvent` (zod-parsed JSON server messages; binary frames => audio PCM). `KeepAlive` is not needed while mic frames stream (PCM calls always stream audio, including silence; mute still sends frames of silence or nothing: see Risks). Layer: `DeepgramAgent.layer(key)` real; `layerTest(script)` fake for tests. Nothing else in the repo uses Effect.
3. **Bridge actor <-> fiber.** The call runtime (`apps/linux/src/call/deepgramCall.ts`, same constructor shape as `VoiceCall`: `id/audio/mute/end/observe/start`) creates the machine actor with `clock: deps.clock` (like `key-moments.ts`) and invokes a `fromCallback` actor that does `Effect.runFork(Effect.scoped(open ...pipe(forEach event -> parentSend)))` and, in its cleanup, `Fiber.interrupt` (closes the Scope => socket closes exactly once). Mic frames go `audio(pcm)` -> `session.send(Buffer.from(pcm,"base64"))` (muted: drop, same as `VoiceCall.audio`). `AgentEvent.UserStartedSpeaking` -> machine `user.started` -> `bargeIn`: `gen += 1`, `call.flush{gen}`, mark in-flight injected reply ids ignored (VoiceCall semantics). Agent PCM binary -> `call.audio{gen, pcm: base64}` (24 kHz, same as `VoiceCall.pump`). `call.state` mapping: `SettingsApplied`->`listening`; `UserStartedSpeaking`->`hearing`; user `ConversationText`/`FunctionCallRequest`->`thinking{text}`; first agent audio or injected reply->`speaking`; `AgentAudioDone`/idle timer (`playEndsAt` arithmetic from `VoiceCall`)->back to rest. Terminal: one `call.state ended`.
4. **Delegation.** Prompt: `liveInstructions(title)` text reused (rename-free) as `agent.think.prompt`, one client-side function `ask_assistant({ request })` (`defer_until_eot` on), managed `open_ai` think model (no OpenAI key), greeting short, `agent.context.messages` seeded from `liveBrief` rows (History). On `FunctionCallRequest`: request text = the user `ConversationText` finals since the last hand-over (mirrors `heard.slice(handedOver)`, exact user words) falling back to `arguments.request`; `thread.turn(voiceTurn(text))`; **immediately** reply `FunctionCallResponse{id,name,content:"Working on it; say nothing until the answer arrives."}` so no Deepgram function timeout can fire on a long assistant turn (Deepgram client-side function timeout is NOT documented: Risk R3). Replies: `observe()` -> `ReplySpeech` (reuse; sentence by sentence) -> `InjectAgentMessage{behavior:"queue"}` (literal TTS, not LLM paraphrase; `default` is refused mid-turn). Late reply after barge-in: replies already injected at barge-in are ignored (identical to `VoiceCall.bargeIn: ignored.add`); a reply that had not started speaking is still spoken (same as local). `SILENCE_MARKER` and `[[details]]` come free from `ReplySpeech`.
5. **Selection/composition.** `main.ts` resolves `provider = hostConfig.voice?.provider ?? env RELAY_VOICE_PROVIDER ?? "gpt-live"` once (host.json `voice: { provider }` added to `HostConfigFile`/`HostConfig`; env wins like other RELAY_* overrides; "per call" = resolver `(agent) => provider` evaluated at each `call.start`/`live.start`, default constant; no per-agent registry field now). `deepgramKey(agentHome, env)` beside `openAiKey` (mirror: `$DEEPGRAM_API_KEY`, then `<agentHome>/secrets/deepgram.env` `DEEPGRAM_API_KEY=` line; null => fallback). `CallService` gets optional `deepgram` dep and nullable `voice`: on `call.start` with provider deepgram and a key it builds `DeepgramCall`; if `open` fails (or no key) and `voice !== null` it builds the existing `VoiceCall` on the same callId WITHOUT sending `ended` (phone only ever sees one connecting->listening); if no local voice either it sends `ended`+error. `main.ts` builds `CallService` when `voice !== null || deepgram !== null` (today only `voice`). `LiveService`: provider deepgram => `api: null` path (`ended`+`fallback:true`, log line reworded; phone already treats it as plain fallback).
6. **In-app cost of the declined `live.start` (Deepgram only).** `LiveCallEngine.start` runs `activity.start` (Live Activity card), mic permission, `startAudio()` (mic engine), `makePeer`+offer (<= 3 s gather wait, normally ms), host connect, `live.start`, then fallback `finish(...)` (tear down mic/peer/activity) before returning `.fallback`; `startVoiceCallNow` then `consumePendingFallback()` + `startCall`. User-visible: a Live Activity flash, a haptic, and roughly one host round-trip + audio-session teardown (est. 0.3-1 s [INFERENCE: not measured]) before the call connects. Works with zero app change. An OTA-only, non-UI optimisation (OPTIONAL subissue): host adds a `welcome.features` string (e.g. `voice.pcm-only`) and `startVoiceCallNow` skips `native.start` when set; old apps keep the extra attempt.
7. **Siri/Action Button.** Non-app path is `LiveCallIntents.talk` -> `LiveCallEngine.toggle` -> `live.start` -> fallback -> dialog "Live calls aren't available right now. Open Relay to call Nova?" -> foreground -> `runPendingFallback` -> `startCall` -> `call.start` -> Deepgram. Works unchanged under Deepgram but needs the foreground tap (no hands-free lock-screen start, because `VoiceCallModule`/JS `controller.ts` only run in the app); GPT path unchanged. Native routing would require `LiveCallEngine` to capture mic PCM (it already owns an AVAudioEngine in `startAudio`), a second playback/flush path, `call.*` frames in `LiveCallHostLink` (`live.*` only today), lifecycle/Live Activity states for `call.state`, interruption handling, plus Swift tests (`pnpm test:native`) and an iOS rebuild/TestFlight (not OTA): ~400-600 Swift LOC [INFERENCE]. Not mandatory for AC9 ("scope documented ... stated and tested or explicitly deferred"): recommend documenting + a JS-level test of `startVoiceCallNow`-style fallback is NOT needed (no JS change); AC9 verified by host test (`live.start` under Deepgram returns `ended`+`fallback`) and the existing native fallback path; native routing explicitly deferred for Isaac's call.
8. **Effect dependency cost.** `apps/linux/package.json` `"effect": "4.1.5"` exact (+ `pnpm-lock.yaml`; no other app pulls it); `nix/hashes.json` `.root` changes -> run `nix/update-hashes.sh` on Linux/Nix (CI's nix workflow does it on main; cannot be run on this Mac); `bun build --compile` (`apps/mac-host/build.sh:19`) bundles it [INFERENCE: pure ESM, no native addon; verify with one local compile]. Effect boundary: ONLY the Deepgram provider I/O module (Scope/acquireRelease socket, Layer/Context.Service api, `Effect.timeout`, Stream/Queue events). Lifecycle, timers, states, barge-in, cap stay XState with `SessionClock`; no Effect in `LiveCall`, `OpenAiLive`, `VoiceCall`, `CallService`.
9. **Tests.** Machine: `providerCall.machine.test.ts` with `SimulatedClock`/`waitFor`/`can()` (grace, cap, hangup/provider drop/failed start each ending once), registered in `apps/linux/test/machine-docs.test.ts` `MACHINES`, page `docs/state-machines/provider-call.md` generated. Call runtime: `apps/linux/test/deepgram-call.test.ts` using `FakeClock`/`FakeThread` from `call.test.ts` patterns (extract to shared helper only if copied a third time) with `layerTest` Deepgram script (Settings sent first, user ConversationText -> thread.turn exactly once, function response immediate, reply -> InjectAgentMessage queue sentence by sentence, UserStartedSpeaking -> `call.flush` + stale reply dropped, silence marker not said, ended on hang-up/socket drop/provider drop/start timeout/cap with one scope close). Provider-open Effect test with `effect/testing` `TestClock` only for the open-timeout (everything else on `SessionClock`). `CallService` test: provider deepgram + open failure => local `VoiceCall` no `ended`; no key + no voice => `ended` error. `LiveService` test: provider deepgram `live.start` => `ended`+`fallback`. `live.test.ts` unchanged (AC1). Real smokes: GPT = `bun test/live-smoke.ts --agent nova --ask "What time is it?"` (existing, aiortc phone); Deepgram = run host with `RELAY_VOICE_PROVIDER=deepgram` and the existing `bun test/call-smoke.ts --agent astra --wav question.wav --out reply.wav --barge barge.wav` (provider-agnostic `call.*` client; it may assume a filler line, `call-smoke.ts:204`, so adjust the report only if it breaks), key via `DEEPGRAM_API_KEY` loaded from `~/Eva/secrets/deepgram.env` by the shell (path only, never printed).

### Reuse Opportunities

- `CallService` + `call.*` frames + `CallState` + `call.flush` generation + `CALL_INPUT_RATE`/`CALL_OUTPUT_RATE`: whole PCM transport on host and phone, zero phone change.
- `ReplySpeech`, `plainSpeech`, `speakable`, `sentences` (`call/speech.ts`), `voiceTurn/spokenPartComplete/SILENCE_MARKER/DETAILS` (`assistant/voice.ts`): reply -> speech text.
- `liveInstructions`, `liveBrief`, `clockLine`, `WAIT_FILLERS` (`live/call.ts`, `live/brief.ts`): Deepgram prompt/context text.
- `VoiceCall` structure (gen/flush, `playEndsAt`, `MIC_REPORT_MS`, `rmsDb`) as the template for `DeepgramCall`; `key-moments.ts` (`createActor` + `clock: SessionClock` + `fromPromise`) as the host machine template; `machine-docs.test.ts` registry.
- `openAiKey` as the template for `deepgramKey`; `RELAY_LIVE_VOICE`/`featureOn` precedent for env + host.json.
- Phone's existing `ended`+`fallback` -> `consumePendingFallback` -> `startCall` and `runPendingFallback` for Siri: no change.
- `call-smoke.ts` (host PCM smoke) and `live-smoke.ts` (GPT smoke) as the two real smokes.

### Things We Should NOT Build

- A generic `VoiceProvider` interface/registry shared by GPT and Deepgram (they differ at the wire: SDP vs PCM); selection is a two-way branch in `main.ts`/`CallService`.
- Any protocol change, new frame, new mobile UI, or `live.*` PCM variant; no Swift change (native Siri PCM routing deferred).
- A `VoiceStack`-shaped Deepgram adapter (ears/filler/speak): it would discard Deepgram's own turn-taking and add latency.
- Effect inside `LiveCall`, `OpenAiLive`, `VoiceCall` or the machine file; no Effect<->XState "bridge framework", just one `fromCallback` that forks and interrupts a fiber.
- Mid-call provider swap, per-agent registry provider field, multi-provider failover chain beyond "Deepgram fails -> local `VoiceCall`".
- Reconnect/resume grace for Deepgram calls (PCM calls die with the socket today; `LiveService` grace is GPT-only).
- A bespoke Deepgram TTS/STT API client (only the Voice Agent socket); no Deepgram SDK dependency.
- Rewriting `VoiceCall` onto the new machine (out of scope; only `LiveCall` migration is optional).

### Risks / Unknowns

- R1 (HIGH, Isaac): machine scope for AC8. Agent default: new `providerCall.machine.ts` drives the Deepgram call only; `LiveCall` migration is the last optional subissue (guarded by unchanged `live.test.ts`), `VoiceCall` stays. Alternative (migrate all three) triples the diff and risks AC1.
- R2 (HIGH, Isaac): Siri/Action Button under Deepgram needs a foreground tap (dialog says "Live calls aren't available right now"). Agent default: document and defer native PCM routing (Swift rebuild, ~400-600 LOC [INFERENCE]); the alternative is a native ticket.
- R3 (MEDIUM): Deepgram client-side `FunctionCallRequest` timeout is not documented; mitigated by immediate `FunctionCallResponse` + literal `InjectAgentMessage` replies. Needs a real smoke with a long (60 s+) assistant turn. Also `InjectAgentMessage` while the agent is speaking (`queue` vs `InjectionRefused`) and whether queued injection survives `UserStartedSpeaking` need verification in the real smoke.
- R4 (MEDIUM): `effect@4.1.5` API names (`Context.Service`, `Layer`, `Scope`, `Stream`, `effect/testing` `TestClock`) come from the main agent's notes; nothing installed here to confirm. First subissue must read `node_modules/effect` after install and adapt. Effect 4 is a new major (v3 docs differ).
- R5 (MEDIUM): Nix hash (`nix/hashes.json` root) can only be recomputed on Linux with Nix; local Mac cannot, so CI must update it or the PR waits. `bun --compile` bundling of effect unverified.
- R6 (MEDIUM): Deepgram needs continuous audio; muted PCM calls drop frames (`VoiceCall.mute` semantics) which could idle the socket past Deepgram's inactivity timeout: mute must send silence frames or `KeepAlive` every 8 s.
- R7 (MEDIUM): `call.start` path: `CallService` today is built only with the local voice stack; changing the null conditions in `main.ts:653` must keep Isaac's default (GPT, local fallback) byte-identical.
- R8 (LOW): UX cost of the declined `live.start` under Deepgram (Live Activity flash, ~0.3-1 s [INFERENCE]); OTA `welcome.features` skip is optional.
- R9 (LOW): transcript continuity: `ConversationText` finals carry exact words but Deepgram's LLM may delegate on partial context; request = accumulated finals since last hand-over mirrors GPT. Whether Deepgram's managed LLM delegates reliably (vs answering directly) is only knowable by smoke; prompt reuse from `liveInstructions` is the lever.
- R10 (LOW): secrets: key file path `~/Eva/secrets/deepgram.env` is read only by the host process; never in logs (log sanitised `DeepgramError`), settings or `welcome`.

### Proposed Atomic Subissues

1. **Provider selection + Deepgram key + host dispatch.** `host.json voice.provider` / `RELAY_VOICE_PROVIDER` (default `gpt-live`), `deepgramKey`, `main.ts` composition (`CallService` built when voice OR Deepgram), `LiveService` declines (`ended`+`fallback`) under Deepgram; tests for resolver, key, dispatch, AC1 default unchanged. (~90 LOC, `host-config.ts`, `call/deepgram-key` or in `deepgram.ts`, `main.ts`, `live/service.ts`, `call/service.ts` shell.)
2. **Deepgram Voice Agent session as an Effect service.** Add `effect@4.1.5` (+ lockfile, nix hash note), `call/deepgram.ts` (`DeepgramAgent` service/Layer, scoped socket, `Settings`/event schema, start timeout, test layer) + test with `TestClock`; confirm effect 4 API from `node_modules` first. (~170 LOC.)
3. **Provider-call XState machine + docs.** `providerCall.machine.ts`, test, `docs/state-machines/provider-call.md`, `machine-docs.test.ts` registration. (~130 LOC.)
4. **Deepgram call over the PCM transport.** `call/deepgramCall.ts` (mic -> binary, agent PCM -> `call.audio`/`call.flush`/`call.state`, ConversationText + function call -> thread turn, replies -> `InjectAgentMessage`, cleanup once) + `CallService` engine selection and silent fallback to `VoiceCall`; tests incl. interruption, late reply, every terminal path. (~260 LOC; depends on 1-3.)
5. **Real smoke + Siri scope doc.** Run `live-smoke.ts` (GPT) and `call-smoke.ts` with Deepgram (long-turn, barge-in, no-key fallback), record results; document Siri/Action Button behaviour (`docs/`), explicitly defer native PCM routing unless Isaac approves. (docs only; ~0 prod LOC.)
6. **OPTIONAL: migrate `LiveCall` lifecycle/timers onto the machine** (cap, grace, closing, awaiting) with `live.test.ts` as oracle; **OPTIONAL: OTA JS skip of `native.start` via a `welcome.features` flag.** Each only with Isaac's go.

Rough total: ~650 production LOC across ~8 files, 1 dependency (`effect`), 1 machine, 1 Effect service; no protocol/mobile/Swift change.

## Plan Review

Status: APPROVED

Machine approval only; human approval stays PENDING.

### Acceptance coverage

- AC1: 01 (default composes unchanged, `live.test.ts` unchanged) and 04 (`call.test.ts`/`live.test.ts` stay green).
- AC2: 02 (socket/Settings/PCM events) + 04 (mic/agent PCM, delegation, replies); proven for real in 05.
- AC3: 01 (host.json/env resolver, default `gpt-live`, per-start evaluation; no UI/protocol change).
- AC4: 01 (`live.start` declines with `fallback`, same path as `api === null`) + 04 (no key or failed open -> `VoiceCall`); 05 runs the no-key fallback.
- AC5, AC6: 04 (turn bridge, silence marker, `[[details]]`, `UserStartedSpeaking` -> `call.flush`, stale reply dropped).
- AC7: 02 (scope closes socket once) + 03 (one terminal state, one cleanup, cap, grace) + 04 (every terminal path tested).
- AC8: 03 (machine, doc page, `MACHINES` registration) + 02 (Effect only for provider I/O). Wording note below.
- AC9: 05 (Siri/Action Button doc; Q2 decides handoff vs native); GPT path untouched by 01.
- AC10: unit tests in 01-04; 05 runs `live-smoke.ts` (GPT) and `call-smoke.ts` against a Deepgram host.

### AC8 wording

AC8 is kept as written; it says "the call lifecycle is an XState machine" and with default Q1 only the Deepgram call gets the machine, while GPT (`LiveCall`) and local (`VoiceCall`) calls keep their existing lifecycle code. This is not narrowed silently: Q1 (HIGH) stays OPEN and is presented to Isaac with that consequence. Choosing migration reopens planning with a new issue.

### Simplification

- Removed `threadBridge.ts` and its test from 03: a "shared" bridge with one consumer is an abstraction without a second user, and refactoring `VoiceCall`/`LiveCall` onto it is out of scope. The bridge now lives in `deepgramCall.ts` (04). Net: one file, one abstraction, one test file fewer.
- 05 no longer adds `deepgram-smoke.ts`: `call-smoke.ts` is a `call.*` client of a running host, so it drives the Deepgram engine with `RELAY_VOICE_PROVIDER=deepgram` unchanged; edit it only if a scenario cannot be driven.
- Kept separate: 01 (dispatch is independently verifiable and protects AC1 before any Deepgram code exists), 02 (the only dependency/lockfile/Nix change, reviewed first via REVIEW_BEFORE), 05 (needs real keys and an Isaac checkpoint; folding it into 04 would hide the no-prod-code gate). 02 cannot merge into 04 without a ~500 LOC issue.
- Spot-checked against code: `CallService.receive/warm/drop` seam (`call/service.ts`), `main.ts:653-671` null `calls` when no voice stack, `session.ts:947-967` null `calls` answers "cannot take calls" without `fallback`, `LiveService` `api === null` -> `ended`+`fallback` (`live/service.ts:44-46`), `machine-docs.test.ts` `MACHINES`, `nix/hashes.json` `root`. One fix: `CallService.warm()` dereferences `voice`, so 01 guards it when `voice` is nullable.

### Complexity and budget

Score 5. Difficulty is a new Effect 4 major with unverified API names, one 4-state-family machine, and the Deepgram protocol unknowns (function timeout, injection while speaking) that only the real smoke settles. Coupling is low: additive engine behind the existing `call.*` seam, GPT untouched, no protocol/mobile change. Blast radius is limited to hosts with provider `deepgram`, plus a lockfile/Nix hash change. It cannot drop below 5 without removing a stated requirement (real Deepgram, Effect, XState, fallback).

Budget (hard caps): production ≤900 LOC (expected 700: 01 90, 02 170, 03 110, 04 300, 05 0), ≤17 files touched (expected 14, including lockfile, Nix hash and docs; tests excluded from LOC), 1 new dependency (`effect@4.1.5`), 2 new abstractions (`providerCall` machine, `DeepgramAgent` Effect service). Order: 01, 02, 03 (independent) then 04, then 05.

### Open HIGH questions

Q1 (machine scope) and Q2 (Siri/Action Button) remain OPEN for Isaac; agent defaults are recorded in the issues and nothing is implemented before explicit human approval.

## Human Feedback

Status: CLEAR

No open feedback.

## Parent Completion

Pending implementation.
