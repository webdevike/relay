# Relay Meetings (capture helper)

The meeting recorder Relay ships as `Relay.app/Contents/Helpers/Relay Meetings.app` and runs as its
child (`apps/desktop/src/main/meetings-capture.ts`), so macOS charges the System Audio Recording and
Microphone grants to Relay. Relay.app's Info.plist carries both reasons
(`apps/desktop/electron-builder.yml` `extendInfo`); without `NSAudioCaptureUsageDescription` the
tap records silence and reports no error.

- **Detection**: Core Audio's process list. A call is a meeting app's process (Teams, Zoom, Webex,
  Slack) running audio input for 3 s; it ends 15 s after none does. Browsers (Chrome, Arc, Safari,
  Edge, Firefox) are reported as `browser: true` and Relay asks before recording.
- **Recording**: a private, unmuted process tap scoped to the app's processes (everything the Mac
  plays except this helper when the app has no audio process; rebuilt when the app starts playing
  from a process it does not cover), and the default mic through AVAudioEngine without voice
  processing. Both tracks are 16 kHz mono s16, appended to
  `<Relay config>/meetings/spool/<id>/{app,mic}.pcm` with `meta.json`. The tap's buffers are read
  at the rate the aggregate device really runs (its nominal rate, then its sample clock against
  host time): with AirPods in call mode the tap format says 48 kHz while the device runs at 24 kHz.
- **Device changes**: AVAudioEngine stops for good when the default input changes (AirPods
  connecting mid-call). The mic is listened again on the new input when the engine posts its
  configuration change, when the default input changes, and when the track has not grown for 2 s;
  the tap is rebuilt on a default output change or 2 s without audio. A gap is filled with silence
  from host times, so both tracks stay on the wall clock.
- **Speakers**: while recording, the app's windows are read through Accessibility five times a
  second (never a click, focus or keystroke; `Sources/Speakers.swift` has the Teams tile rules):
  who is marked talking, who is muted, captions with names. The app's processes get
  `AXEnhancedUserInterface` set for the recording, as VoiceOver does, since Chromium apps (Teams
  2, Slack, browsers) expose no web content to Accessibility without it. Each changed sample (and
  one every 5 s) goes to `speakers.jsonl` stamped with its position on the app track. Without
  Relay's Accessibility grant this is off and the host tells voices apart on its own.
- **Share snapshots**: the same window walk looks for someone's shared screen
  (`Sources/Share.swift` has the rule: an element that is not a control whose label, description,
  DOM id or classes name a screen share or someone presenting, at least 320x180 pt; the smallest
  such element wins, and the first match of each share is logged as a warning). Relay hears
  `share on/off` with whether it holds Screen Recording, then asks for a sample every few seconds:
  ScreenCaptureKit captures only that region of the meeting app's window (a desktop-independent
  window filter with a source rect, at most 1920 px wide) and answers a 256-bit dHash; Relay
  decides when a sample is new enough and asks to save it (Vision OCR, JPEG at quality 0.8) as
  `<spool>/<id>/shots/<n>.jpg` with a line in `shots.jsonl` (n, at on the app track, t, w, h,
  hash, ocr). Screen Recording is never requested: the helper only checks
  `CGPreflightScreenCaptureAccess()` and touches ScreenCaptureKit only when it says yes. Shots go
  up as `meeting.shot` frames and live on the Relay Host's disk only.
- **Upload**: `/meetings/ingest?ticket=` on the Relay Host (ticket from `meeting.ingest.open` on
  Relay's connection). Binary frames `u8 track, i64 LE first sample, s16 LE PCM`; text frames
  `meeting.hello`, `meeting.speakers`, `meeting.shot` (`shot`: a `shots.jsonl` line, `jpeg`: the
  image in base64, one per frame), `meeting.end` out and `ack`, `ack.speakers`, `ack.shots`,
  `meeting.done`, `meeting.stop` in. Sending starts at the host's acks, so a reconnect resends
  what the host is missing; the spool is deleted on `meeting.done`. A spool left by a crash or an
  away host is reported as `pending` on the next run.
- **Health**: a minute of digital silence on the app track while the app plays audio (`silent-app`:
  the grant is missing) or a mic track that stopped growing for 10 s despite the restarts
  (`no-mic`) is reported to Relay.

The stdio protocol is documented at the top of `Sources/Daemon.swift`.

```sh
sh build.sh          # build/Relay Meetings.app (ad hoc; the deploy signs it with Relay)
sh build.sh test     # logic tests
build/Relay\ Meetings.app/Contents/MacOS/RelayMeetingCapture list
# Feed two WAVs (and the window's samples, if DIR/speakers.jsonl is there) instead of the Mac's
# audio (no privacy prompts). With DIR/share.mp4 and DIR/share.json ({"from": s, "to": s} on the
# replay clock) someone shares between those times and share.sample takes the video's frame at
# the replay time instead of the screen (proof/meeting-share has a fixture and a smoke script):
RelayMeetingCapture serve --spool /tmp/spool --replay <dir with app.wav, mic.wav> --no-detect
