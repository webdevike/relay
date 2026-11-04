# Relay Meetings: plan

Replace MeetingTranscriber 0.8.1 (pasrom, third party) and the Swift Meeting Drawer (`~/Eva/apps/meeting-drawer`)
with a recorder that lives in Relay. Isaac's answers (2026-11-04): it runs in the background like Relay Assist,
embedded in Relay.app; a call shows up on Relay's Meetings page with a live transcript there (no drawer or panel);
the live transcript and Ask also work on the iPhone.

Phase 1 (this branch, `eva/meetings`) is a spike plus this plan. Nothing ships from it. Spike code: `spike/meetings/`
(capture helper, stand-in ingest socket, ASR/diarization/AEC benchmarks, `results/`).

## What exists today

| Piece | What it does | Fate |
|:--|:--|:--|
| MeetingTranscriber.app | watches Teams/Zoom/Webex window titles (Slack via a WebRTC power assertion + consent prompt), records app audio through a Core Audio tap plus the mic, live captions in `/state.liveCaptions`, after the call: Parakeet v3 (FluidAudio CoreML), diarization, echo removal, a "Name Speakers" step, `claude` summary into `~/Downloads/MeetingTranscriber/protocols/<stem>.md` | replaced |
| `.omp/tools/mt-autoname.ts` (LaunchAgent) | answers the naming step over 127.0.0.1:9876: mic voice = Isaac, Outlook 1:1 attendee for remote labels (claude.ai Microsoft 365 connector), Slack huddle context; adds `**Attendees:**` under `**Time:**` | its pure functions are reused (`lookupMeeting`, `autoMapping`, `withAttendees`, `pickEvent`); the polling loop and the MT API client go |
| `apps/meeting-drawer` (LaunchAgent) | right-edge drawer polling `/state` every 250 ms, word-run echo filter (`Transcript.swift`), Ask box (`claude -p --model sonnet --tools ""`, 3 to 6 s) | replaced by the Meetings page; the echo filter is ported |
| `.omp/tools/meeting-digest.ts`, `meeting-memory.ts` | read protocols, write `work/elysia/meetings.md`, `work/meetings/<stem>.json` (proposals), journal and ledgers | kept; they read one more protocols dir |
| Relay desktop Meetings page (`apps/desktop/src/renderer/meetings/`, `main/eva/meetings-ipc.ts`) | lists `work/meetings/*.json`, shows notes, transcript, proposals with Accept/Dismiss; local files only, so a thin client (MacBook) has none | gains Live + Ask, moves behind the host |
| Relay Assist (`apps/assist`) | Swift helper shipped as `Relay.app/Contents/Helpers/Relay Assist.app`, spawned by `main/assist.ts` so macOS charges its grants to Relay; signed with "Relay Local Signing" by `.omp/tools/relay-desktop-deploy.ts` | the pattern the capture helper copies |

MeetingTranscriber's last job on the Mini (2026-11-02 "Isaac <> Todd") ended in `error: "Empty transcript"` with a
175,846 s duration, and a notification says it stopped without quitting from 3:26 to 3:30 PM. Its live captions keep
only the last two finals and blank after 5 s, which is why the drawer rebuilds the transcript itself.

## Spike results (Mac mini M5 Pro, 48 GB, macOS 27.0.1, 2026-11-04)

### Capture (`spike/meetings/capture`, `results/capture-proof-report.json`)

- `Relay Meetings.app`: accessory app (`LSUIElement`), one Swift file, signed with "Relay Local Signing". Call audio
  through a Core Audio process tap (`CATapDescription(stereoGlobalTapButExcludeProcesses:)`, private, unmuted) on a
  private aggregate device; the mic through `AVAudioEngine`. Both converted to 16 kHz mono s16, written to WAVs and
  streamed to a WebSocket in about 100 ms frames (`u8 track, i64 LE first sample index, s16 LE PCM`; text frames
  `meeting.hello`, `meeting.end`).
- 34 s run with a 30.7 s spoken test file played by `afplay`, launched with `open -g`: app track 34.1 s, -16.5 dBFS
  RMS, peak 26,863, 89% non-zero samples; mic 34.0 s at -40 dBFS. Frontmost app `dev.eva.relay-desktop` before and
  after (no focus taken). Setup 0.26 s.
- Streamed to the stand-in ingest socket (`spike/meetings/ingest/server.ts`): 619 frames, 2.19 MB, zero sample-index
  gaps on both tracks, inter-arrival p50 107 ms / p99 120 ms (app) and 98 / 204 ms (mic). The WAV rebuilt from the
  socket is byte-identical to the helper's own file.
- Content check: Parakeet on the received app track returned the test script word for word except "GUID" heard as
  "git". The macOS output was muted (`output volume:0, muted:true`): the tap captures what the process plays
  regardless of the device's volume, so no audible test sound is needed.
- Call detection without window titles or Accessibility: Core Audio's process list
  (`kAudioHardwarePropertyProcessObjectList`) gives each audio process's bundle id and whether it runs input/output.
  A call = a Teams (`com.microsoft.teams2*`), Zoom (`us.zoom.*`), Webex or Slack (`com.tinyspeck.slackmacgap*`)
  process running mic input. `RelayMeetingCapture list` on the idle Mini listed Teams' and Slack's helper processes
  with no input (no call), as expected. Not yet seen on a live call (no call happened during the spike).
- Permission prompts seen: (1) **"'Relay Meetings' would like access to record your system audio. Relay records the
  call audio of your meetings so it can transcribe them."** [Don't Allow] [Allow]: the System Audio Recording grant
  (`NSAudioCaptureUsageDescription`), separate from Screen Recording. While it is pending, `AudioHardwareCreateProcessTap`
  succeeds and the tap delivers silence, and `AVAudioEngine.inputNode` blocks the main thread. (2) Microphone
  (`NSMicrophoneUsageDescription`); `authorizationStatus` was 3 (authorized) by the second run. Launched with `open`,
  the helper is its own responsible process, so the prompt names it; spawned by Relay (as Assist is) it will name Relay.
- Voice processing (VPIO, Apple's echo canceller on the mic) is not an option: with it on, the tap in the same process
  delivered only zeros (both orders tried), and the mic still carried the whole played script (VPIO only cancels audio
  played through its own unit, not Teams'). `results/capture-vpio-helper.out`.

### Transcription (`spike/meetings/asr`, `results/results-*.json`, `results/full-call-cost.txt`)

Sample: 63 s of the 2026-11-02 Weekly Engineering Team Sync (12:47 to 13:50: Todd on the app track, Isaac's 165-word
update on the mic). Reference = MeetingTranscriber's own `.txt` lines in that window. That transcript is Parakeet v3
too, so "WER vs MT" is agreement with today's engine, not accuracy against a human transcript.

| Engine / strategy | Track | Compute (share of audio time) | Update latency | Final text lag | WER vs MT |
|:--|:--|--:|--:|--:|--:|
| Parakeet v3 (parakeet-mlx) offline | mic | 0.026 | | | 0.053 |
| Parakeet v3 offline | app | 0.014 | | | 0.087 |
| whisper-large-v3-turbo (mlx-whisper) offline | mic | 0.018 | | | 0.179 (drops "um/uh" and repeats MT keeps) |
| Parakeet v3 streaming, default context (256,256), 1 s chunks | mic | 0.33 | p50 299 ms | 20.5 s | 0.146 |
| same, 0.5 s chunks | mic | 1.49 (falls behind real time) | p50 734 ms | 20.5 s | 0.225 |
| Parakeet v3 streaming, context (256,8), 1 s | mic | 0.116 | p50 114 ms | 0.64 s | 0.437 |
| **Utterance windows** (energy VAD closes at 0.6 s quiet or 15 s, open utterance re-decoded every 1 s as the draft) | mic | **0.09** | p50 73 ms, max 198 ms | **0.67 s** | **0.053** |
| Utterance windows | app | 0.017 | p50 54 ms | 0.65 s | 0.217 (23-word reference; it kept "Awesome ... do you" that offline dropped, plus "Mm-hmm. Okay. Hey. No.") |

- Utterance windows match offline quality at under 10% of one GPU's time per track with finals 0.65 s after a pause.
  parakeet-mlx's cache-aware streaming either lags 20 s (default) or loses accuracy (small right context).
- Parakeet loads in 1.5 s once cached (first run 156 s, mostly the 2.5 GB weights download); peak MLX memory 2.3
  to 3.3 GB; Whisper turbo 3.6 GB.
- Whole call (2,413 s): parakeet-mlx 57.7 s (app) + 50.8 s (mic), RTF 0.021 to 0.024. MeetingTranscriber's FluidAudio
  (CoreML, ANE) did the same call in 17.9 s (`stage_timing.jsonl`), about 3x faster and off the GPU.

### Speakers and echo

- Two tracks already separate Isaac (mic) from everyone else (app): free, exact, live.
- Remote speakers, offline: sherpa-onnx (pyannote segmentation 3.0 + TitaNet-small, 4 CPU threads) took 264 s for the
  40 min app track (RTF 0.11) and over-split at threshold 0.7: 65 clusters, 12 with more than 30 s of talk for about 11
  real remote voices; needs a merge pass and tuning. MeetingTranscriber's FluidAudio diarizer took 58 s.
  Options and cost: FluidAudio diarizer in Swift (CoreML, about 0.025 RTF, what MT ships), sherpa-onnx (CPU, 0.11 RTF,
  tune threshold), pyannote 3.1 on MPS (gated Hugging Face model, heavier), streaming Sortformer (4 speakers max) for
  live labels later.
- Mic echo, software AEC with the call track as the reference: WebRTC AEC3 (livekit's `AudioProcessingModule`, 10 ms
  frames) on the capture proof's mic track (speaker echo only) cut it 15.6 dB (-40.0 to -55.6 dBFS) at RTF 0.021 and
  took Parakeet's output from the full ~90-word script to 9 garbled words. Double talk (Isaac over a remote speaker)
  is untested. The drawer's word-run filter (mic words inside 3-word runs the call audio had in the last 8 s) stays as
  the text-level backstop. Headphones make both moot.

## Design

```
 Relay.app (any Mac)                                  Relay Host (the Mini)                       Clients
 ┌──────────────────────────────┐   ticketed binary   ┌──────────────────────────────────┐  meetings.* frames  Relay desktop
 │ Contents/Helpers/            │   WebSocket         │ src/meetings/                     │ ───────────────▶  Meetings page
 │  Relay Meetings.app (Swift)  │ ──────────────────▶ │  ingest  -> spool WAVs            │                   (live + Ask)
 │  detect (Core Audio procs)   │  /meetings/ingest   │  relay-asr worker (Python, MLX):  │
 │  tap + mic -> 16k s16 chunks │                     │   AEC3, VAD utterances, Parakeet  │ ───────────────▶  Relay mobile
 │  local spool, resend on ack  │ ◀── acks ────────── │  live lines -> meeting.live       │                   app/meetings
 └──────────┬───────────────────┘                     │  end: re-pass, diarize, name,     │
            │ stdio JSON lines                        │       summarize, protocol .md     │
 desktop main/meetings-capture.ts (spawn, restart,    └──────────────┬───────────────────┘
 gets the ticket over its host connection)                           │ protocol .md
                                                                     ▼
                                    meeting-digest / meeting-memory (unchanged, one more dir) -> work/meetings/<stem>.json
```

### 1. Capture helper (`apps/meetings-capture`, Swift, `Relay Meetings.app`)

- Shipped like Assist: `relay-desktop-deploy.ts` builds it and ditto's it into `Relay.app/Contents/Helpers/`, signed
  in the same `--deep` pass with "Relay Local Signing". `main/meetings-capture.ts` spawns it with a plain `spawn`
  (no LaunchServices) so Relay stays the responsible process, restarts it after a crash (assist.ts's rules), stops it
  on quit. A separate helper rather than code in Assist: a crash or hang in one cannot take the other down, and
  capture never shares a process with Assist's voice engine (the VPIO finding).
- Detection loop (1 s): Core Audio process list as above. Start when a meeting app's process runs input for 3 s;
  end when none has for 15 s (MT's `endGrace`). Browser calls (Chrome/Arc/Safari helpers holding the mic) are asked,
  not recorded: a desktop notification "Record this call?" (MT parity). Title: the meeting app's front window title
  through `CGWindowListCopyWindowInfo` (titles need Screen Recording, which Relay is granted for Assist; no
  Accessibility); the calendar lookup names it later anyway.
- Recording: process tap scoped to the meeting app's processes (all of Teams' helpers) so notification sounds and
  music stay out; global-minus-self as the fallback when the app's audio process is not found. Mic: default input via
  AVAudioEngine, no voice processing. Both tracks stamped from `mHostTime`, so the host knows the mic offset
  (the spike's first buffers were 86 to 121 ms apart, in either order).
- Transport: desktop main asks the host `meeting.ingest.open` and gets a single-use ticket (the VNC ticket pattern),
  hands the URL to the helper on stdin. Frames as in the spike. The helper spools every chunk to
  `~/Library/Application Support/Relay Desktop/meetings/spool/<id>/{app,mic}.pcm` and drops what the host acked;
  after a disconnect it reconnects with a fresh ticket and resends from the last ack. Host away for the whole call
  (MacBook off the tailnet): upload after, transcript arrives late.
- Health: silence on the app track for 60 s while the meeting app outputs audio = "permission missing or tap broken"
  (the pending-prompt behaviour); surfaced on the Meetings page and as a notification, never silently recorded as
  empty (today's "Empty transcript" failure).
- Info.plist of Relay.app (`electron-builder.yml` `extendInfo`) gains `NSAudioCaptureUsageDescription`; it has
  `NSMicrophoneUsageDescription` already. One-time prompts, both under Relay's name: System Audio Recording, and
  Microphone if Assist's voice has not asked yet.

### 2. Host meetings service (`apps/linux/src/meetings/`)

- Ingest socket `MEETINGS_INGEST_PATH = "/meetings/ingest"`, opened only with a ticket from an authenticated device.
  Writes `$XDG_CONFIG_HOME/relay/meetings/<id>/{app,mic}.wav` plus `meta.json` (app, title, start, device, mic offset).
- `relay-asr` worker: a Python process in a venv under the agent home (Studio's LTX pattern: own process group,
  stdin binary frames, stdout JSON lines), one per host, models kept loaded. Per track: AEC3 on the mic with the app
  track as reference, energy VAD (Silero later if needed), utterance windows (1 s drafts, final at 0.6 s quiet or 15 s),
  Parakeet v3. Drafts and finals carry track, start/end sample, text.
- Live lines go out as `meeting.live` deltas to every device; the host keeps the full transcript (desktop and phone
  can join mid-call and get `meeting.snapshot`). Mic finals pass the ported word-run echo filter; filtered words stay
  in the record with `echo: true` so the end-of-call pass and debugging can see them.
- GPU: the worker shares the GPU with Studio's LTX and Kontext queue. A live meeting pauses new Studio GPU jobs
  (queued ones wait with "Waiting for the meeting to end") and the worker runs at higher priority.
- End of call: stage `transcribing` (full re-pass of both tracks, AEC'd mic), `diarizing` (app track; labels `R_S1..`),
  `naming` (`bun <agent home>/.omp/tools/mt-autoname.ts` exports: `lookupMeeting(start, title)` then
  `autoMapping(speakers, "Isaac", micOnly, remoteName)`; no speaker DB, so no wrong name is ever learned),
  `summarizing` (`claude -p --model sonnet` through `mt-claude.sh`-style env `EVA_GATE_OFF=1`, the protocol prompt
  that produces today's sections: Summary, Participants, Topics Discussed, Decisions, Tasks table, Open Questions,
  Full Transcript), `done`. Output: `<protocols dir>/<YYYYMMDD_HHMM>_<slug>_<id8>.md` in MT's exact format (so
  `parseProtocol`, meeting-digest and meeting-memory read it unchanged) plus the `.txt` transcript.
- Ask: `meetings.req { op: "ask", id, question }`; the host runs `claude -p --model sonnet --tools ""` with the
  transcript so far and the last four Q&A (drawer parity, 3 to 6 s) and streams `meeting.answer` chunks to every
  device, so a question asked on the phone shows on the desktop too. Q&A is kept in `meta.json` and appended to the
  protocol under `## Questions asked during the call`.
- Meetings list and proposals move to the host too (`meetings.req` ops `list`, `get`, `accept`, `dismiss`,
  `openNotes` stays desktop-local): today's `meetings-ipc.ts` logic ported like Reviews was, so the MacBook and the
  phone see the same Meetings as the Mini.

### 3. Protocol (`packages/protocol/src/meetings.ts`, re-exported by `index.ts`; fixtures in `fixtures/`)

Client to host:
- `meetings.list` -> `meetings.state`
- `meetings.req { rid, op }`, ops: `get { stem }`, `ask { id, question }`, `accept { stem, proposalId }`,
  `dismiss { stem, proposalId }`, `stop { id }` (end a recording by hand), `discard { id }` (delete a recording),
  `rename { id, label, name }` (fix a speaker; rewrites the protocol)
- `meeting.ingest.open { app, title?, startedAt }` -> `meeting.ingest.ticket { id, ticket }` or
  `meeting.ingest.refused { reason }`

Host to clients:
- `meetings.state { live: LiveMeeting[], meetings: MeetingSummary[], digest }`: answer to `meetings.list`, pushed when
  a meeting starts, ends, changes stage or a record changes
- `meeting.snapshot { id, rev, lines }` (on join), `meeting.live { id, rev, upsert: LiveLine[] }` (drafts replaced by
  line id, finals immutable; about 2 frames/s per call)
- `meeting.stage { id, stage, error? }`, `meeting.answer { id, qid, text, done }`, `meetings.res { rid, ok, error?, ... }`

`LiveLine { id, track: "mic" | "app", speaker, startMs, endMs, text, final, echo? }`; `LiveMeeting { id, app, title,
startedAt, device, stage, health }`. Ingest socket (binary, not part of the zod union): the spike's frame format plus
`ack { track, upTo }` text frames from the host every second.

### 4. Relay desktop

- Sidebar Meetings list: a **Live** group on top with a red dot and elapsed time while a call records, then today's
  day groups.
- A live meeting's page: title, app, elapsed, health line ("Hearing Teams and your mic"), the transcript (rows merge
  same-speaker lines within 20 s like the drawer; drafts dimmed; sticks to the bottom unless scrolled up; filter box),
  and the Ask box pinned at the bottom with answers inline. When the call ends the same page shows the stage, then
  becomes today's notes view (summary, For you, Remembered, transcript), with the Q&A kept.
- A desktop notification when recording starts ("Recording Weekly Engineering Sync", Stop and Open actions) and
  when the notes are ready.
- `meetings-ipc.ts` becomes the remote-backed store (the Reviews thin-client pattern), one path for the Mini and the
  MacBook.

### 5. Relay mobile (same changes as desktop, per the phone parity rule)

- `app/meetings/index.tsx` (Live on top, then recent meetings, Waiting on you) and `app/meetings/[id].tsx` (live
  transcript, Ask composer with the existing hold-to-talk dictation, proposals with Accept/Dismiss, notes after the
  call). A Home card "In a call" while one records. Connection: `meetings.list` on welcome and reconnect, like
  `studio.list`.
- Push: "Recording ..." and "Notes ready" through the host's existing push path.
- Ships OTA (`pnpm ota:publish`, JS only). A Live Activity with the last line on the lock screen would extend the
  native `LiveCallActivity` target and needs a TestFlight build; listed as optional, not in the phases below.

### 6. Migration (MeetingTranscriber keeps running until parity)

1. Shadow: Relay records alongside MT (two taps and two mic readers coexist). Relay writes its protocols to
   `~/Eva/work/meetings/protocols/` with `shadow: true` in `meta.json`; meeting-digest and meeting-memory skip shadow
   protocols, so nothing is journaled twice. The Meetings page shows Relay's live view; finished notes still come
   from MT.
2. Parity check per real call (target 5 calls: one 1:1 Teams, one group Teams, one Slack huddle, one Zoom or Webex,
   one on laptop speakers): recording started and ended on its own, no empty transcript, word agreement with MT's
   transcript, remote 1:1 named from Outlook, mic words not duplicated from the call, summary sections present,
   proposals produced by meeting-memory from the Relay protocol (dry run).
3. Cutover: Relay's protocols become primary (shadow off; meeting-digest/memory read `work/meetings/protocols`
   first, MT's dir for history). Turn off MT's `autoWatch`, `launchctl bootout` `ai.eva.mt-autoname` and
   `ai.eva.meeting-drawer`, keep MT installed two weeks as the fallback, then uninstall (cask) and delete
   `apps/meeting-drawer`, the MT parts of mt-autoname, and rewrite `workflows/meeting-transcriber.md` as the Relay
   Meetings runbook.

## Risks

- **TCC attribution**: the spike prompt named the helper because `open` made it responsible. Spawned by Relay it
  should name Relay (Assist's grants work that way), but System Audio Recording is a newer service; verify on the
  packaged app first thing in phase 2. Without `NSAudioCaptureUsageDescription` in Relay's Info.plist the tap
  delivers silence with no error.
- **Silent failure**: a pending or denied grant gives zeros, not an error. Health check above; never write an empty
  protocol without saying why.
- **Echo**: VPIO is out (measured). AEC3 is measured on echo only; double talk on speakers is the open quality risk.
- **Diarization**: open-source CPU diarization over-splits and is 4.5x slower than MT's; group-call labels may be
  worse than today until tuned or FluidAudio is adopted.
- **GPU contention** with Studio jobs on the Mini; handled by pausing Studio during calls, or avoided with FluidAudio
  on the ANE.
- **Detection**: Slack voice clips or a Teams device test also run the mic (3 s debounce, discard under 30 s);
  Teams calls routed through its virtual "Microsoft Teams Audio" device still play from a Teams process, so the
  process tap sees them.
- **Host down mid-call**: helper spool covers it; the live view on other devices stops until the host is back.
- **Memory**: about 3 GB for the ASR worker while loaded; unload after 10 idle minutes.
- **Consent**: recording other people; same exposure as today. Recordings stay on the Mini, retention 30 days for
  audio (decision below).

## Phases

| Phase | Scope | Estimate |
|:--|:--|:--|
| 1 (done) | spike + this plan | 1 day |
| 2 | `apps/meetings-capture` helper (detection, scoped tap, mic, spool, stdio), `main/meetings-capture.ts`, deploy + signing + `NSAudioCaptureUsageDescription`, TCC check on the packaged app | 2 to 3 days |
| 3 | host `src/meetings/` ingest + tickets + storage, `relay-asr` worker (AEC3, VAD windows, Parakeet), echo filter port, protocol schemas + fixtures + Swift mirror if `apps/mac` must decode them, tests | 3 to 4 days |
| 4 | desktop live page + Ask + Live group + notifications, and mobile `app/meetings` + Home card + push in the same change (OTA) | 3 days |
| 5 | end-of-call pipeline: re-pass, diarization, naming via mt-autoname exports, summary, protocol writer, digest/memory dir support, host-backed meetings list/proposals for desktop and phone | 2 to 3 days |
| 6 | shadow run next to MT for about a week of real calls, parity report, fixes | 1 to 2 days of work |
| 7 | cutover, MT/drawer/mt-autoname agents off, docs, removal after two weeks | half a day |

## Open decisions for Isaac

- ASR engine: parakeet-mlx in a Python worker on the host (measured here, simplest) or FluidAudio in Swift on the
  ANE (MT's engine, 3x faster, frees the GPU, more build work)?
- Where transcription runs for calls on the MacBook: stream to the Mini (one engine, needs the tailnet) or on the
  MacBook itself?
- Ask: stateless `claude -p` Sonnet like the drawer, or a question to Astra's session with the meeting as context?
- Remote speaker names on group calls: keep raw `R_S1` labels (today) or allow a voice library that learns names?
- Browser meetings (Meet, Teams web): ask each time (today) or never record?
- Audio retention on the Mini: keep WAVs 30 days, forever, or delete after notes are written?
- Laptop speakers: accept AEC3 + the word filter, or nudge to headphones when the mic hears the call?
