import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_LINK_PREFS, type LinkPrefs } from '@evaos/contract'

vi.mock('electron', () => ({ shell: { openExternal: vi.fn() } }))
const handlers = new Map<string, (input: never) => unknown>()
const emitted: [string, unknown][] = []
vi.mock('../ipc/handle', () => ({
  handle: (_c: unknown, name: string, fn: (input: never) => unknown) => handlers.set(name, fn),
  emit: (_c: unknown, name: string, payload: unknown) => emitted.push([name, payload]),
}))

import { createConfigStore } from '../config-store'
import { createWriteQueue } from '../write-queue'
import { installedApps, loadLinkPrefs, registerLinksIpc, LINKS_FILE } from './links-ipc'

let dir: string
let apps: string
beforeEach(() => {
  handlers.clear()
  emitted.length = 0
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evaos links '))
  apps = path.join(dir, 'Applications')
  for (const a of ['Arc.app', 'Linear.app', 'Notes.txt', '.Hidden.app']) {
    fs.mkdirSync(path.join(apps, a), { recursive: true })
  }
})

const call = (name: string, input: unknown) => handlers.get(name)!(input as never)

describe('links ipc', () => {
  it('lists installed apps by name', () => {
    expect(installedApps([apps, path.join(dir, 'missing')])).toEqual(['Arc', 'Linear'])
  })

  it('serves the defaults until saved, then the saved rules', async () => {
    const config = createConfigStore(dir)
    const launch = vi.fn().mockResolvedValue(true)
    registerLinksIpc({ config, env: { e2e: false } } as never, createWriteQueue(), {
      dirs: [apps],
      launch,
    })
    expect(call('links.get', {})).toEqual({ prefs: DEFAULT_LINK_PREFS, apps: ['Arc', 'Linear'] })
    const prefs: LinkPrefs = {
      rules: [{ pattern: 'example.com', opener: { kind: 'system' } }],
      fallback: { kind: 'browser' },
      seeded: ['reviews'],
    }
    await call('links.set', { prefs })
    expect(JSON.parse(fs.readFileSync(path.join(dir, LINKS_FILE), 'utf8'))).toEqual(prefs)
    expect(emitted).toEqual([['links.changed', { prefs, apps: ['Arc', 'Linear'] }]])
    expect(loadLinkPrefs(config)).toEqual(prefs)
  })

  it('launches apps and schemes, and leaves the side browser to the page', async () => {
    const config = createConfigStore(dir)
    const launch = vi.fn().mockResolvedValue(true)
    registerLinksIpc({ config, env: { e2e: false } } as never, createWriteQueue(), {
      dirs: [apps],
      launch,
    })
    // An item link is the page's to open in Reviews; with `reviews: false` it goes to its app.
    expect(await call('links.open', { url: 'https://linear.app/w/issue/ENG-1' })).toEqual({
      to: 'reviews',
      launched: false,
    })
    expect(
      await call('links.open', { url: 'https://linear.app/w/issue/ENG-1', reviews: false }),
    ).toEqual({ to: 'app', launched: true })
    expect(launch).toHaveBeenCalledWith({ to: 'app', app: 'Linear', url: 'linear://w/issue/ENG-1' })
    // Slack isn't installed here: its rule falls back to the side browser, launching nothing.
    expect(await call('links.open', { url: 'https://slack.com/x' })).toEqual({
      to: 'browser',
      launched: false,
    })
    expect(launch).toHaveBeenCalledTimes(1)
  })

  it('reads a broken links.json as the defaults', () => {
    fs.writeFileSync(path.join(dir, LINKS_FILE), '{"rules": 3}')
    expect(loadLinkPrefs(createConfigStore(dir))).toEqual(DEFAULT_LINK_PREFS)
  })
})
