import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { installRelaySound } from './sound'

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-sound-'))
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

describe('installRelaySound', () => {
  const o = () => ({
    source: path.join(dir, 'bundle.aiff'),
    soundsDir: path.join(dir, 'Library/Sounds'),
    name: 'relay-chime.aiff',
  })

  it('copies the bundled sound into the Sounds folder, then leaves a current copy alone', () => {
    fs.writeFileSync(o().source, 'chime-v1')
    expect(installRelaySound(o())).toBe('installed')
    expect(fs.readFileSync(path.join(o().soundsDir, o().name), 'utf8')).toBe('chime-v1')
    expect(installRelaySound(o())).toBe('current')
  })

  it('replaces an older copy when the app ships a new sound, leaving no temp file', () => {
    fs.writeFileSync(o().source, 'chime-v1')
    installRelaySound(o())
    fs.writeFileSync(o().source, 'chime-v2')
    expect(installRelaySound(o())).toBe('installed')
    expect(fs.readFileSync(path.join(o().soundsDir, o().name), 'utf8')).toBe('chime-v2')
    expect(fs.readdirSync(o().soundsDir)).toEqual([o().name])
  })

  it('reports a missing source and an unwritable Sounds folder without throwing', () => {
    expect(installRelaySound(o())).toBe('missing-source')
    fs.writeFileSync(o().source, 'chime-v1')
    // The Sounds folder's parent is a file, so the folder cannot be created.
    fs.writeFileSync(path.join(dir, 'Library'), 'not a folder')
    expect(installRelaySound(o())).toBe('failed')
  })
})
