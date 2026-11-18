import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => '/app' } }))

import { hostAlive, shouldStartHost } from './host-autostart'

const live = {
  stable: true,
  live: true,
  e2e: false,
  hiddenWindow: false,
  relayDir: '/r',
  relayRemote: null,
}
const installed = (p: string): boolean => p === '/r/host.json'

describe('shouldStartHost', () => {
  it('starts an installed, stopped host for the live stable app on Linux', () => {
    expect(shouldStartHost(live, 'linux', () => false, installed)).toBe(true)
  })

  it('never on macOS (the LaunchAgent starts it)', () => {
    expect(shouldStartHost(live, 'darwin', () => false, installed)).toBe(false)
  })

  it('not when the host runs, is not set up, is remote, or this is a test or dev run', () => {
    expect(shouldStartHost(live, 'linux', () => true, installed)).toBe(false)
    expect(
      shouldStartHost(
        live,
        'linux',
        () => false,
        () => false,
      ),
    ).toBe(false)
    const remote = { ...live, relayRemote: { host: 'mini', port: 7817 } }
    expect(shouldStartHost(remote, 'linux', () => false, installed)).toBe(false)
    expect(shouldStartHost({ ...live, e2e: true }, 'linux', () => false, installed)).toBe(false)
    expect(shouldStartHost({ ...live, stable: false }, 'linux', () => false, installed)).toBe(false)
    expect(shouldStartHost({ ...live, relayDir: null }, 'linux', () => false, installed)).toBe(
      false,
    )
  })
})

describe('hostAlive', () => {
  const dirWith = (serve: unknown): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-serve-'))
    if (serve !== undefined) fs.writeFileSync(path.join(dir, 'serve.json'), JSON.stringify(serve))
    return dir
  }

  it('reads the pid from serve.json and probes it', () => {
    expect(hostAlive(dirWith({ port: 7817, pid: process.pid }))).toBe(true)
    expect(hostAlive(dirWith(undefined))).toBe(false)
    expect(hostAlive(dirWith({ port: 7817 }))).toBe(false)
    const gone = Object.assign(new Error('gone'), { code: 'ESRCH' })
    const denied = Object.assign(new Error('denied'), { code: 'EPERM' })
    const dir = dirWith({ port: 7817, pid: 4242 })
    expect(
      hostAlive(dir, () => {
        throw gone
      }),
    ).toBe(false)
    expect(
      hostAlive(dir, () => {
        throw denied
      }),
    ).toBe(true)
  })
})
