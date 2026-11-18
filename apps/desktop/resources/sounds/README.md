# Relay notification sound

`relay-chime.aiff` plays for every non-silent desktop notification (Settings > Notifications > Notification sound: "Relay sound", the default; "System sound" plays macOS's).

- Source: Isaac's own ElevenLabs-generated UI alert, `UIAlert-High-quality_minimal-Elevenlabs.mp3` (2.0 s, 48 kHz stereo MP3; replaced the earlier Soundly SND86872 chime on 2026-11-18). His file, so no third-party license applies.
- Edit: trimmed to the first 1.25 s (the rest is silence), 3 ms fade in, 200 ms fade out, -2.1 dB so integrated loudness matches the old chime (-18.4 LUFS, measured with ffmpeg ebur128) with a -4.5 dBFS sample peak (limit -1). 48 kHz stereo 16-bit; converted with `afconvert` to `.aiff` (desktop, here) and `.caf` (phone, `apps/mobile/assets/sounds/`).
- Desktop ships it at `Relay.app/Contents/Resources/relay-chime.aiff` (`extraResources` in `electron-builder.yml`). macOS does not play a notification's named sound from inside the app bundle (checked on macOS 27: it falls back to the default alert; `~/Library/Sounds` plays), so `main/notifications/sound.ts` copies it to `~/Library/Sounds/relay-chime.aiff` when Relay starts (new or changed bytes only) and `Notification({ sound: 'relay-chime.aiff' })` names it. The copy also lists "relay-chime" in System Settings > Sound > Alert sound. If the copy fails the notification keeps the system sound. `pnpm dev` copies from `resources/sounds/`.

## Phone (next cable build)

- `apps/mobile/assets/sounds/relay-chime.caf` and the `expo-notifications` plugin `sounds` entry in `apps/mobile/app.json` are in place; the file gets into the app only with the next native build (`expo prebuild` copies it into the Xcode project). Not an OTA change.
- The host sends it by default: `apps/linux/src/push/expo.ts` `RELAY_PUSH_SOUND` is the push's `sound` unless a message says `sound: null` (digests, withdraws). A phone build without the file plays the system sound, so the host can send it before the build ships.
- After the build installs: send a push (any assistant reply while the phone is away) and listen; a locked phone plays the `.caf` only when the ringer is not silent.
