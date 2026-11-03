# Buddy voice

Hold to talk, release to send. Buddy speaks its caption aloud while it points, and goes quiet the moment you talk, press Esc, say "stop" or ask again; a click (you doing the step) never cuts her off.

## Pieces

| File | What |
|---|---|
| `VoiceCore.swift` | `VoiceInput` / `VoiceOutput` protocols, `VoiceError`, `VoiceConfig` (models, speaking style, key), `PCMConverter` |
| `RealtimeTranscriber.swift` | Streaming speech to text over `wss://api.openai.com/v1/realtime?intent=transcription`, model `gpt-live-transcribe` (partials as you speak) |
| `VoiceInputs.swift` | `MicVoiceInput` (AVAudioEngine) and `FileVoiceInput` (wav/aiff/m4a/mp3, for tests) |
| `OpenAISpeech.swift` | Streaming text to speech, `POST /v1/audio/speech`, model `gpt-4o-mini-tts`, in the answering assistant's registry `liveVoice` (Nova `marin`, Astra `ballad`: the voice names Relay's GPT-Live calls use), sentences fetched in parallel, played as chunks arrive |
| `VoiceController.swift` | `VoiceController` (push to talk + speak + barge-in) and `HoldHotKey` (tap vs hold on one global hotkey) |
| `VoiceTest.swift` | `--voice-test`, `--voice-say [--as astra]`, `--voice-barge` checks |

Overrides: `RELAY_BUDDY_STT_MODEL`, `RELAY_BUDDY_TTS_MODEL`. The voice is not configurable here: it is the assistant's `liveVoice` in `~/Eva/.omp/assistant/agents.json`. The key comes from `OPENAI_API_KEY` or the same env file Brain uses.

`gpt-4o-mini-tts` is on OpenAI's deprecation list (shutdown 2027-01-06). Its replacement is the Realtime API (`gpt-realtime-2.1-mini`), which is not served by `/v1/audio/speech`; only `OpenAISpeech` needs to change for that, the `VoiceOutput` protocol stays.

## Microphone permission (needed once)

The app asks the first time you hold the talk key. If you decline, or it never asks, open System Settings > Privacy & Security > Microphone and switch on Relay (Assist started by the packaged Relay.app; Relay Assist when run standalone). The responsible app's Info.plist must carry `NSMicrophoneUsageDescription` (Relay's electron-builder.yml and Assist's Resources/Info.plist both do), otherwise macOS ends the process the moment the mic is touched. Keep the signing identity stable (build.sh and relay-desktop-deploy.ts do) so the grant survives rebuilds.

## Testing without a microphone

```
tools/voice-test.sh stt "where is the bevel tool"   # say -> m4a -> streaming transcript
tools/voice-test.sh tts "Click Bevel, then drag to size it."   # -> /tmp/buddy-say.wav, plays it
tools/voice-test.sh barge                            # speak, cut at 1.2 s, prints stop latency
```

The app binary accepts the same flags (`RelayBuddy --voice-test q.m4a`) once main.swift calls `VoiceTest`.
