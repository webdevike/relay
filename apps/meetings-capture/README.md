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
  `<Relay config>/meetings/spool/<id>/{app,mic}.pcm` with `meta.json`.
- **Upload**: `/meetings/ingest?ticket=` on the Relay Host (ticket from `meeting.ingest.open` on
  Relay's connection). Binary frames `u8 track, i64 LE first sample, s16 LE PCM`; text frames
  `meeting.hello`, `meeting.end` out and `ack`, `meeting.done`, `meeting.stop` in. Sending starts at
  the host's ack, so a reconnect resends what the host is missing; the spool is deleted on
  `meeting.done`. A spool left by a crash or an away host is reported as `pending` on the next run.
- **Health**: a minute of digital silence on the app track while the app plays audio (`silent-app`:
  the grant is missing) or a mic track that stopped growing (`no-mic`) is reported to Relay.

The stdio protocol is documented at the top of `Sources/Daemon.swift`.

```sh
sh build.sh          # build/Relay Meetings.app (ad hoc; the deploy signs it with Relay)
sh build.sh test     # logic tests
build/Relay\ Meetings.app/Contents/MacOS/RelayMeetingCapture list
# Feed two WAVs instead of the Mac's audio (no privacy prompts):
RelayMeetingCapture serve --spool /tmp/spool --replay <dir with app.wav, mic.wav> --no-detect
```
