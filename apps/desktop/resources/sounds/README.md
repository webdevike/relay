# Relay notification sound

`relay-notification.aiff` plays for every non-silent desktop notification (Settings > Notifications > Notification sound: "Relay sound", the default; "System sound" plays macOS's).

- Source: Soundly `SND86872` ("UIAlert_Achievement, Level Up, Notification, Goal Achieved, Positive 02", soundly://open/?file-id=SND86872), library "Soundly Free". Isaac's account is on the Free plan and Soundly marks the sound `IsForFreeAccount` (included without Pro), so it is licensed for his use under that plan. Re-check Soundly's license terms before shipping Relay to anyone else.
- Fetched through the soundly-picks adapter (`packages/atomic-agents/domains/sound/adapters/soundly/api.ts`, `download("SND86872")`): the original 96 kHz / 24-bit WAV, 3.7 s.
- Edit: first 1.2 s (the tail is a 2.5 s decay), 5 ms fade in, 300 ms fade out, resampled to 48 kHz stereo 16-bit, +7.5 dB so the peak is -6 dBFS (about -18.4 LUFS integrated, quieter than the system alert sounds' peaks, louder than a whisper). Converted with `afconvert` to `.aiff` (desktop, here) and `.caf` (phone, `apps/mobile/assets/sounds/`).
- Desktop ships it at `Relay.app/Contents/Resources/relay-notification.aiff` (`extraResources` in `electron-builder.yml`). macOS does not play a notification's named sound from inside the app bundle (checked on macOS 27: it falls back to the default alert; `~/Library/Sounds` plays), so `main/notifications/sound.ts` copies it to `~/Library/Sounds/relay-notification.aiff` when Relay starts (new or changed bytes only) and `Notification({ sound: 'relay-notification.aiff' })` names it. The copy also lists "relay-notification" in System Settings > Sound > Alert sound. If the copy fails the notification keeps the system sound. `pnpm dev` copies from `resources/sounds/`.

## Phone (next cable build)

- `apps/mobile/assets/sounds/relay-notification.caf` and the `expo-notifications` plugin `sounds` entry in `apps/mobile/app.json` are in place; the file gets into the app only with the next native build (`expo prebuild` copies it into the Xcode project). Not an OTA change.
- The host sends it by default: `apps/linux/src/push/expo.ts` `RELAY_PUSH_SOUND` is the push's `sound` unless a message says `sound: null` (digests, withdraws). A phone build without the file plays the system sound, so the host can send it before the build ships.
- After the build installs: send a push (any assistant reply while the phone is away) and listen; a locked phone plays the `.caf` only when the ringer is not silent.
