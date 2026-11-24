# Voice providers for Relay calls

A phone call to an assistant (Nova, Astra) runs on one engine per host. Two exist: **GPT-Live** (default) and **Deepgram Voice Agent**. Both are `Layer`s of one Effect `VoiceEngines` service, resolved once in `apps/linux/src/main.ts` by `composeVoiceEngines` (`src/voice/engines.ts`).

## Choose the provider

| Where | Value |
|---|---|
| `~/.config/relay/host.json` | `{ "voice": { "provider": "gpt-live" } }` or `"deepgram"` |
| Environment (wins over `host.json`) | `RELAY_VOICE_PROVIDER=deepgram` |
| Neither | `gpt-live` |

An unknown id stops the host at start with the list of known ids. There is no mid-call switch; the next call uses the host's engine.

## Keys (host only)

| Provider | Key | Where the host looks |
|---|---|---|
| GPT-Live | OpenAI | `$OPENAI_API_KEY`, else `<agent home>/secrets/openai.env` |
| Deepgram | Deepgram | `$DEEPGRAM_API_KEY`, else `<agent home>/secrets/deepgram.env` (`DEEPGRAM_API_KEY=...`) |

Keys never reach the phone, the protocol or the logs. Deepgram's `think` step runs `gpt-4o-mini` on Deepgram's side with the voice prompt; the assistant thread still does the real work.

## What each engine is

| | GPT-Live (`webrtc-sideband`) | Deepgram (`pcm-websocket`) |
|---|---|---|
| Phone to engine | WebRTC straight to OpenAI; the host attaches a sideband | PCM16 16 kHz up and 24 kHz down as `call.audio` over the host WebSocket, no SDP |
| Phone frames | `live.start` / `live.answer` / `live.state` / `live.end` | `call.start` / `call.audio` / `call.state` / `call.flush` / `call.end` |
| Host class | `LiveCall` (`live/call.ts`) | `DeepgramCall` (`call/deepgramCall.ts`, lifecycle `deepgramCall.machine.ts`, [diagram](../state-machines/deepgram-call.md)) |
| Voice | `marin` (per assistant via `liveVoiceFor`) | `aura-2-thalia-en` (`SPEAK_MODEL` in `call/deepgram.ts`); ears `nova-3` |
| Delegation | tool call to the assistant thread as a `voiceTurn` | function `ask_assistant`, same thread turn |
| Replies | commentary through the sideband | settled sentences spoken through `InjectAgentMessage` (`queue`) |
| Interruption | OpenAI's own barge-in | `UserStartedSpeaking` while the agent speaks: `call.flush` with a new generation, stale replies dropped |

## Fallback

| Situation | Result |
|---|---|
| GPT-Live, no OpenAI key | `live.start` answered `ended` + `fallback`; the phone starts the local `call.*` call |
| Deepgram, no key | `call.start` runs the local `VoiceCall` |
| Deepgram, key rejected or connect failed | the call logs `Deepgram unavailable ... falling back` and the local `VoiceCall` takes its place; the phone sees `connecting` then `listening` |
| Deepgram selected, phone sends `live.start` | declined at once with `fallback: true` ("This host uses PCM calls") |
| Deepgram fails after it was ready | the call ends with the reason; no switch mid-call |

The local call needs Eva's speech stack (`eva-realtime`, `pocket-tts`); a host without it answers `This host cannot take calls`.

## Assistant-initiated calls

"Call me when it's done" ([call-me.md](call-me.md)): the assistant rings Isaac's phone when work he asked about settles; his tap starts the PCM call with `call.start` + `request`, and `CallService` hands the request's greeting and brief to the call (`CallDeps.opener`): Deepgram speaks it as its `greeting`, the local `VoiceCall` says it first.

## Siri, Action Button and the lock screen

Decision (Isaac, 2026-11-23, Q2): keep the existing foreground fallback.

- **GPT-Live host:** unchanged. `TalkToNovaIntent` / `TalkToAstraIntent` (`apps/mobile/plugins/intents/LiveCallIntents.swift`) call `talk`, `LiveCallEngine` starts the call with `live.start` and it runs hands-free, lock screen included.
- **Deepgram host:** `LiveCallIntents.talk` sends `live.start`; the host declines with `fallback`; `LiveCallEngine` stores a pending fallback and the intent asks to continue in Relay (`ForegroundContinuableIntent`, "Open Relay to call Nova?"); one foreground tap opens the app, whose JS runs `call.start` into Deepgram. Cost: one tap and no hands-free lock-screen start.
- Native PCM routing in `LiveCallEngine` (Swift, app rebuild) is deferred; the decision to build it is Isaac's, and this doc changes with it.
- The host side of this path is exercised by the smoke (decline in 26 ms, then a served `call.start`). The Siri prompt, the foreground tap and the Action Button on a real iPhone are not exercised here.

## Add a provider on a supported transport

A new provider on `webrtc-sideband` or `pcm-websocket` changes exactly:

1. A new `<provider>.ts` exporting `<provider>Layer(env): Layer<VoiceEngines>` that builds a `VoiceEngine` of an existing transport, plus its session code. Layers build synchronously (key read, factory); sessions open per call in their own scope.
2. One literal in `ProviderId` (`apps/linux/src/host-config.ts`) and one entry in `VOICE_ENGINE_LAYERS` (`apps/linux/src/voice/engines.ts`). The record is total over `ProviderId`: a missing entry is a type error.
3. Its own tests plus a smoke run (below).

It does not change `LiveService`, `CallService`, `session.ts`, `main.ts`, the protocol or the phone. A provider that needs a new transport adds a variant to `VoiceEngine`, its wire frames and one caller case: that is a new design, not a layer swap.

## Smoke

`apps/linux/test/call-smoke.ts` (add `--greeting` for a provider that speaks first, `--barge <wav>` and `--barge-speaking N` to talk over the Nth speaking turn after the question), `live-smoke.ts` and `live-host-check.ts` drive a host over its WebSocket. Never point them at the live host: use a throwaway host with its own `XDG_CONFIG_HOME` (devices, assistant store), its own agent home and a scripted assistant. The 2026-11-23 run and its harness are in `.scratch/relay-effect-voice-providers/smoke/` and `results/05-real-smoke-siri-scope.md`.
