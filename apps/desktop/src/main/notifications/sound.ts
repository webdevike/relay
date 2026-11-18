import * as fs from 'node:fs'
import * as path from 'node:path'

/**
 * macOS plays a notification's named sound from the system sound folders, never from inside the app
 * bundle (checked on macOS 27: a name that only exists in Relay.app/Contents/Resources falls back to
 * the default alert, the same name in ~/Library/Sounds plays). Relay therefore ships its sound in
 * Resources and copies it to ~/Library/Sounds when it starts.
 *
 * Never rename the sound back to a name that was once asked for while its file was missing:
 * NotificationCenter remembers a name as invalid and keeps playing the default alert for it until it
 * restarts (`relay-notification.aiff` was lost that way on the Mini, hence `relay-chime.aiff`).
 */
export type SoundInstall = 'installed' | 'current' | 'missing-source' | 'failed'

/**
 * Puts `source` at `<soundsDir>/<name>` unless the same bytes are already there; a changed or new
 * Relay sound replaces the old copy. Never throws: a Mac whose Sounds folder cannot be written keeps
 * the default notification sound (`failed`).
 */
export function installRelaySound(o: {
  source: string
  soundsDir: string
  name: string
}): SoundInstall {
  let bytes: Buffer
  try {
    bytes = fs.readFileSync(o.source)
  } catch {
    return 'missing-source'
  }
  const dest = path.join(o.soundsDir, o.name)
  try {
    if (fs.existsSync(dest) && fs.readFileSync(dest).equals(bytes)) return 'current'
    fs.mkdirSync(o.soundsDir, { recursive: true })
    // Written beside it and renamed over it, so a notification never plays a half-written file.
    const tmp = `${dest}.${process.pid}.tmp`
    fs.writeFileSync(tmp, bytes)
    fs.renameSync(tmp, dest)
    return 'installed'
  } catch {
    return 'failed'
  }
}
