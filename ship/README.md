# Shipping Relay Meetings

Everything here is on `eva/meetings`; nothing below has been run. Two patches touch the Eva checkout
(`~/Eva/.omp/tools`), outside this repo, so they are kept here instead of applied.

## 1. Relay Host (the Mini)

1. Merge `eva/meetings` and install the host as usual.
2. `sh apps/linux/asr/setup.sh` once: uv venv with parakeet-mlx, livekit (AEC3) and sherpa-onnx in
   `~/.local/share/relay/asr`, the diarization models, and Parakeet's weights (2.5 GB, first run).
   Without it the host keeps recordings but transcribes nothing (logged at start:
   `transcription off (no .../python)`).
3. Defaults: `features.meetings` on when the host has an agent home; `features.meetingsShadow` on, so
   notes go to `~/Eva/work/meetings/shadow/` (read by nobody but the Meetings page). Audio and
   transcripts live in `~/.config/relay/meetings/<id>/` for 30 days.
4. Host log on start: `meetings in ..., notes in .../shadow (shadow), transcription by relay-asr`.

## 2. Relay desktop (Mini and MacBook)

1. `git -C ~/Eva apply work/relay-meetings/ship/relay-desktop-deploy.patch`: the deploy builds
   `apps/meetings-capture` and puts `Relay Meetings.app` in `Relay.app/Contents/Helpers` before the
   `--deep` signing pass. Without it the packaged app has no helper and `startMeetingsCapture`
   returns null (nothing breaks).
2. Deploy with `bun ~/Eva/.omp/tools/relay-desktop-deploy.ts --summary "..."`. Its gate runs the
   changed specs and smoke.
3. First call after the update: macOS asks once, under Relay's name, for **System Audio Recording**
   ("Relay records the call audio of your meetings...") and, if Assist's voice never asked,
   Microphone. Verify the prompt says "Relay" (PLAN risk: TCC attribution). If it names
   "Relay Meetings", the grant still works but is a separate entry.

## 3. Phone

`pnpm ota:publish` (JS only: `app/meetings`, Home "Meetings / In a call", push taps).

## 4. Cutover (after the shadow run, with Isaac's OK)

1. Host config `features.meetingsShadow: false`: notes go to `~/Eva/work/meetings/protocols/`.
2. `git -C ~/Eva apply work/relay-meetings/ship/meetings-cutover-tools.patch`: meeting-digest and
   meeting-memory read `work/meetings/protocols` first and MeetingTranscriber's folder for
   history; meeting-memory gains `--dir` (used by the shadow checklist's dry run).
3. Add `~/Eva/work/meetings/protocols` to the WatchPaths of `ai.eva.meeting-digest` and
   `ai.eva.meeting-memory`, then reload both agents.
4. Then PLAN.md section 6, step 3 (MT `autoWatch` off, mt-autoname and drawer agents out).
