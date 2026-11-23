# Result: Run the real smoke per provider and document Siri scope and the next-provider recipe

## Implemented
- `docs/relay/voice-providers.md` (new, 71 lines): provider selection, key paths, engine table, fallback table, Siri/Action Button under each provider (Q2 recorded), the Next provider recipe, smoke pointers.
- Real calls run against an isolated loopback host (details below). No production source changed.
- `apps/linux/test/call-smoke.ts` (+27/-7 test lines): `--greeting` and `--barge-speaking N`. The unmodified tool cannot drive a provider that speaks first: it treated the greeting as the reply (`done` at the greeting's end, before the question) and keyed its barge on a "second distinct line", which Deepgram's `speaking` states never carry. Repro (`call-smoke.ts --agent smoke --wav ask.wav` against the isolated host with `RELAY_VOICE_PROVIDER=deepgram`): outcome `done` at 1.4 s, timeline listening, speaking, listening, ended, `heard: null`. The local-call default path is unchanged.
- `.scratch/relay-effect-voice-providers/smoke/` (throwaway, not production): `host.ts` (isolated host), `run.sh` (starts and stops only its own host), `evidence/` (redacted reports, host logs, delegation ledgers, reply transcripts; no audio, no keys).

## Why This Approach
The live host, real paired devices, Nova and Astra chats were never touched. `host.ts` builds the same objects `main.ts` does: `composeVoiceEngines(null, { agentHome, env })` (provider from `$RELAY_VOICE_PROVIDER`), the real `CallService`, `LiveService`, `RelayServer` and `AssistantService`/`AssistantThreads`. Isolation: temp dir under `/tmp/relay-smoke-*`; `XDG_CONFIG_HOME` pointed there (device store, assistant store), and the host refuses to start unless it is `/tmp/relay-smoke-*`; temp agent home whose `secrets/{deepgram,openai}.env` are symlinks to `~/Eva/secrets/` (keys read by path; `run.sh` unsets `DEEPGRAM_API_KEY`/`OPENAI_API_KEY` for the host); port 0; no input, push, Bonjour or canvas; one throwaway device the smoke clients write into the temp store. The assistant is a deterministic fixture behind the real `AssistantService`: a fake `AgentProvider` records each delegated turn to `delegations.jsonl` and, after `--reply-ms`, streams `Marker alpha N received. The fixture reply is ready.` plus a `[[details]]` line `DETAILS-ONLY-N must not be spoken.`. The utterances are macOS `say` (Samantha) speech. Each reply audio file was transcribed once with Deepgram prerecorded STT (key read from the file inside a subshell, never printed) to prove what was spoken.

## Reused
- `call-smoke.ts` (Deepgram), `live-smoke.ts` and `live-host-check.ts` (GPT-Live), `live_phone.py` (aiortc phone, venv `/tmp/live-e2e-venv`), `FileDeviceStore`, the `assistant.test.ts` fake-provider pattern.

## Actual Complexity
- Production LOC added: 71 (`docs/relay/voice-providers.md`, a doc the measure tool counts as production; no source)
- Production LOC deleted: 0
- Test LOC added: 27 (`call-smoke.ts`, 7 deleted)
- Files touched: 2 (+ throwaway `.scratch` harness)

## Budget
- Expected production LOC: 0
- Maximum production LOC: 70 (Isaac 2026-11-23: docs count toward the 1000 cap, which stays; issue maxima rebalanced to sum 1000)
- Actual production LOC: 69, all in the required doc (71 before; one sentence restating `engines.ts` dropped). Parent `measure` after the budget pass: 990 of 1000 (was 1056).
- Expected files: 1
- Actual files: 2 (`call-smoke.ts` is the one extra the plan allowed)

## Review Callouts
- **Cap decision needed (Isaac):** the doc is required by AC4 and AC10. Smallest correction: record that docs do not count toward production LOC, or raise the parent hard cap by up to 71 for the doc. Trimming the doc to the 15 LOC of headroom drops the recipe or the Siri section. No cap was changed.
- **Results (real providers, isolated host, 2026-11-23):**

| Scenario | Result | Evidence |
|---|---|---|
| Deepgram normal turn, key by path | PASS. Greeting, heard the question verbatim, delegation reached the fixture (`delegations.jsonl`), reply injected, audio after question 4.88 s. Spoken: "Hey, what's up? Checking on that. Marker Alpha one received. The fixture reply is ready." `DETAILS-ONLY` not spoken. Speech end to transcript 1.17 s, to first audio 1.75 s, first reply sentence 1.5 s after delegation | `dg-normal-path/` |
| Deepgram >60 s assistant turn (75 s) | PASS. Call stayed up through 75 s of `thinking` (no KeepAlive drop), reply then spoken, hang-up clean, `ended after 88 s` | `dg-long/` |
| Deepgram barge during the reply | PASS. `flushes: 1`, host logged `barge-in`; spoken "Marker Alpha one received." then cut, agent answered the interruption ("Sure. Go ahead with your question.") and did not finish the stale reply | `dg-barge-reply/` |
| Deepgram late reply (9 s) while the user spoke | PASS. Agent answered the new question first, the delegated reply was then queued and spoken, nothing lost or repeated | `dg-late-reply/` |
| Clean hangup | PASS. After `call.end` the host's only socket is its listener (`host-sockets.txt` in every run), one `ended after N s` line, one terminal `ended` state | all `dg-*` |
| Deepgram no key | PASS. `call.start` ran the local `VoiceCall` (`connecting`, `listening`), no Deepgram attempt | `dg-nokey/` |
| Deepgram rejected key (`DEEPGRAM_API_KEY=invalid-test-key`, real Deepgram 401) | PASS. `Deepgram unavailable (Deepgram connection failed); falling back`, then the local call listened | `dg-badkey/` |
| Declined `live.start` under Deepgram | PASS. `ended` with "This host uses PCM calls", 26 ms after `live.start` on loopback (2 ms for the no-key GPT decline). The iPhone's extra wait is its own SDP offer build and the network; not measured | `dg-live-declined/`, `gpt-nokey/` |
| GPT-Live through the host (`live-host-check.ts`, real `LiveService` and OpenAI) | PASS. `live.answer` 0.7 s, `session.started`, delegated "Please ask my assistant to check the status of the Alpha project", reply spoken "Marker alpha 1 received. The fixture reply is ready.", `OK: delegated and answered`, session closed, 18 s billed | `gpt-host-check/` |
| GPT-Live full report (`live-smoke.ts`, unchanged, in-process `LiveCall` against the isolated thread) | PASS. press to answer 1.34 s, first audio 4.9 s, delegation 0.9 s after speech end, answer audio 3.5 s after speech end, thread rows correct, 17 s billed | `gpt-live-smoke/out/report.json` |
| GPT-Live no key | PASS. `live.start` answered `ended`, "No OpenAI key on this host", `fallback` | `gpt-nokey/` |

- Chosen Deepgram voice: `aura-2-thalia-en` (unchanged from 02); ears `nova-3`, think `gpt-4o-mini`. Not compared with other voices.
- **Q7:** verbatim `queue` held. Deepgram queued replies mid-turn and after the user's interruption; no `InjectionRefused`, lost line or Deepgram warning appeared in any run. Decision stays.
- **Observation, not a blocker:** between the assistant going idle and the injected reply's first audio, the call reports `listening` for 150-200 ms, then `speaking` (`dg-normal-path` timeline `thinking, listening, speaking`). `turnDone` sends `agent.done` as soon as the thread idles. Smallest correction, if wanted: in `deepgramCall.ts`, skip `agent.done` while a reply line was injected and `AgentAudioDone` has not followed. About 3 LOC; not made (review-after, caps).
- **Not verified:** `[[details]]` and `SILENCE_MARKER` with a streaming (non-settled) reply on a real call (the fixture settles in one change); GPT barge-in (`live-smoke.ts --barge` not run, outside 05's scope); multi-turn Deepgram memory across calls; the Deepgram Voice Agent history field with a long thread; a hang-up while `connecting` or a mid-call socket drop on a real Deepgram call (covered by 03/04 unit tests); other aura-2 voices.
- **Harness limits:** the fixture assistant is not Nova or Astra, so latency of a real assistant turn and tool use are not measured. The local-call fallback scenarios use a silent stand-in `VoiceStack` (`--local-stub`) instead of `eva-realtime` and `pocket-tts` (not started, per the isolation rule); they prove the host switched to `VoiceCall` and the phone saw its states, not local speech quality. The test host binds `0.0.0.0` on a random port (`server.ts` hardcodes it) for under two minutes per run and accepts only its throwaway random device secret.
- **Early runs (provenance):** `dg-long`, and the first normal and barge runs, used the inherited `DEEPGRAM_API_KEY` in the host environment (the Eva shell sets it), same key as the file. `run.sh` then unset it so the `secrets/` path is what the host reads; `dg-normal-path` and everything after used the path. `dg-long`'s `run.sh` tail broke because the script was edited while it ran; its client report and host log were collected by hand and the one test host it left was stopped by pid.
- **Nix hash, unresolved:** `nix/hashes.json` `.root` must be recomputed with `nix/update-hashes.sh` on Linux/Nix or CI (from 01); not runnable on this Mac. `effect` added a dependency to the lockfile, so the Nix build is expected to fail until it is.
- **On-device Siri, unverified:** no iPhone, no Siri, no Action Button, no OTA, no lock-screen start. The doc states the foreground-fallback path from code (`LiveCallIntents.swift`, `LiveCallEngine.swift`); the host half is proven by the decline above.
- Processes started here: the isolated hosts, `live_phone.py` and `bun` clients; all exited or were stopped by pid (`pgrep` of `smoke/host.ts` and `live_phone` shows none).

## Open Questions Resolved
- Q2 stays `HUMAN_DECIDED`: foreground fallback, documented.
- Q7 stays `AGENT_DECIDED`: verbatim queue, confirmed by the real smoke.

## Verification
- `bun .omp/tools/eva-spec.ts check .scratch/relay-effect-voice-providers` (from `~/Eva`) — PASS ("Valid")
- `bun ~/Eva/.omp/tools/eva-spec.ts measure .scratch/relay-effect-voice-providers` (from the worktree) — production 1056 added, 31 deleted; tests 723 added; 21 files; flags the parent hard cap (cause above)
- `npx eslint test/call-smoke.ts`, `npx tsc --noEmit -p tsconfig.json` (apps/linux) — no findings
- Real runs: `.scratch/relay-effect-voice-providers/smoke/run.sh <scenario> <provider|none> <reply-ms> [--no-keys] [--local-stub] -- bun test/<tool>.ts --agent smoke ...` from `apps/linux`; exact commands in `smoke/evidence/batch2.sh` and the table above.
- Secret scan: neither key value occurs in any evidence file (`grep -rlF`, 0 hits each).
