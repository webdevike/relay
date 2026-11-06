import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import type { watch } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  KICK_FILE,
  LatestSchema,
  PUBLIC_FEED,
  bundleOf,
  createPackagedUpdater,
  keepsIdentity,
  ownBuild,
  readSource,
  resolveSource,
  swapScript,
  watchKick,
  parseHistory,
} from './packaged'

const tmp = (): string => mkdtempSync(path.join(tmpdir(), 'relay-upd-'))

describe('packaged updater helpers', () => {
  it('finds the bundle from the executable path', () => {
    expect(bundleOf('/Applications/Relay.app/Contents/MacOS/Relay')).toBe('/Applications/Relay.app')
  })

  it('reads the source file, null when absent or malformed', () => {
    const d = tmp()
    expect(readSource(d)).toBeNull()
    writeFileSync(path.join(d, 'update-source.json'), '{"dir":""}')
    expect(readSource(d)).toBeNull()
    writeFileSync(path.join(d, 'update-source.json'), '{"ssh":"ike@mini","dir":"/x/app"}')
    expect(readSource(d)).toEqual({ ssh: 'ike@mini', dir: '/x/app' })
  })

  it('reads the build stamped into package.json', () => {
    const d = tmp()
    expect(ownBuild(d)).toBeNull()
    writeFileSync(path.join(d, 'package.json'), '{"relayBuild":"abc123"}')
    expect(ownBuild(d)).toBe('abc123')
  })

  it('parses latest.json', () => {
    expect(LatestSchema.parse({ build: 'abc', app: 'abc/Relay.app' }).summary).toBeNull()
    expect(LatestSchema.safeParse({ build: 'abc' }).success).toBe(false)
  })

  it('reads the deploy history newest first and skips what does not parse', () => {
    const desktop = (build: string, at: string) => ({ kind: 'desktop', build, at, changes: ['x'] })
    expect(parseHistory('nope')).toEqual([])
    expect(
      parseHistory([
        desktop('a', '2026-11-03T09:00:00-05:00'),
        { kind: 'host', version: '0.2.51', at: '2026-11-03T12:00:00-05:00' },
        { kind: 'desktop', build: 'bad' },
        desktop('c', 'not a date'),
        desktop('b', '2026-11-03T10:00:00-05:00'),
      ]).map((e) => (e.kind === 'host' ? e.version : e.build)),
    ).toEqual(['0.2.51', 'b', 'a'])
  })

  it('swap script waits for the pid, clones, swaps and reopens', () => {
    const s = swapScript()
    expect(s).toContain('kill -0 "$pid"')
    expect(s).toContain('cp -cR "$staged" "$new"')
    expect(s.trim().endsWith('open "$dest"')).toBe(true)
  })

  it('takes only a bundle that keeps the stable signing identity (and the privacy grants)', () => {
    const stable = 'identifier "dev.eva.relay-desktop" and certificate leaf = H"e439"'
    // An ad-hoc or unsigned app moves to the stable identity once.
    expect(keepsIdentity('cdhash H"cfec"', stable)).toBe(true)
    expect(keepsIdentity(null, stable)).toBe(true)
    expect(keepsIdentity(stable, stable)).toBe(true)
    expect(keepsIdentity(stable, 'cdhash H"6a17"')).toBe(false)
    expect(
      keepsIdentity(stable, 'identifier "dev.eva.relay-desktop" and certificate leaf = H"9b97"'),
    ).toBe(false)
    expect(keepsIdentity(stable, null)).toBe(false)
  })

  // The real fs.watch (FSEvents) starts asynchronously and its latency is unbounded under load, so
  // the tests inject the watcher and drive its event by hand instead of waiting on the OS.
  function fakeWatch() {
    let fire: (event: string, name: string | null) => void = () => undefined
    let closed = false
    const watchDir = ((_dir: string, listener: (event: string, name: string | null) => void) => {
      fire = listener
      return { on: () => undefined, close: () => (closed = true) }
    }) as unknown as typeof watch
    return { watchDir, fire: (name: string | null) => fire('rename', name), isClosed: () => closed }
  }

  it('a kick file appearing triggers a check and is consumed', () => {
    const d = tmp()
    const w = fakeWatch()
    let kicks = 0
    const stop = watchKick(d, () => kicks++, w.watchDir)
    expect(kicks).toBe(0)
    writeFileSync(path.join(d, KICK_FILE), '')
    w.fire('other-file') // unrelated names are ignored
    expect(kicks).toBe(0)
    w.fire(KICK_FILE)
    expect(kicks).toBe(1)
    expect(existsSync(path.join(d, KICK_FILE))).toBe(false)
    w.fire(KICK_FILE) // file already consumed: no second kick
    expect(kicks).toBe(1)
    stop()
    expect(w.isClosed()).toBe(true)
  })

  it('a kick file already present at start is taken at once', () => {
    const d = tmp()
    writeFileSync(path.join(d, KICK_FILE), '')
    let kicks = 0
    watchKick(d, () => kicks++, fakeWatch().watchDir)()
    expect(kicks).toBe(1)
    expect(existsSync(path.join(d, KICK_FILE))).toBe(false)
  })
})

describe('public https update source', () => {
  const stable =
    'identifier "dev.eva.relay-desktop" and anchor apple generic and certificate leaf[subject.CN] = "Apple Development: X"'
  const zipBytes = Buffer.from('pretend this is a zip of Relay.app')
  const sha = createHash('sha256').update(zipBytes).digest('hex')

  /** A packaged app on build `old` with no update-source.json, and a feed serving `latest` + the zip. */
  function setup(opts: { sha256?: string; staged?: string }) {
    const configDir = tmp()
    const appPath = tmp()
    writeFileSync(path.join(appPath, 'package.json'), '{"relayBuild":"old"}')
    const urls: string[] = []
    const offered: string[] = []
    const updater = createPackagedUpdater({
      configDir,
      appPath,
      execPath: '/Applications/Relay.app/Contents/MacOS/Relay',
      pid: 1,
      offer: (u) => offered.push(u.build),
      tools: {
        fetch: (url) => {
          urls.push(String(url))
          if (String(url).endsWith('latest.json')) {
            return Promise.resolve(
              Response.json({
                build: 'new',
                summary: 'Newer',
                zip: 'Relay-new.zip',
                sha256: opts.sha256 ?? sha,
              }),
            )
          }
          return Promise.resolve(new Response(zipBytes))
        },
        unzip: (_zip, dir) => {
          mkdirSync(path.join(dir, 'Relay.app'))
          return Promise.resolve()
        },
        verify: () => Promise.resolve(),
        requirement: (bundle) =>
          Promise.resolve(bundle.endsWith('updates/Relay.app') ? (opts.staged ?? stable) : stable),
      },
    })
    return { configDir, updater, urls, offered }
  }

  it('defaults to the public feed when there is no update-source.json, and reads a url source', () => {
    const d = tmp()
    expect(resolveSource(d)).toEqual({ url: PUBLIC_FEED })
    writeFileSync(path.join(d, 'update-source.json'), '{"dir":"/x"}')
    expect(resolveSource(d)).toEqual({ dir: '/x' })
    writeFileSync(path.join(d, 'update-source.json'), '{"url":"http://insecure/latest.json"}')
    expect(resolveSource(d)).toBeNull()
    writeFileSync(path.join(d, 'update-source.json'), '{"url":"https://example.com/latest.json"}')
    expect(resolveSource(d)).toEqual({ url: 'https://example.com/latest.json' })
  })

  it('downloads, verifies and stages a build, then offers it', async () => {
    const { configDir, updater, urls, offered } = setup({})
    expect(await updater.checkNow()).toBe('ready')
    expect(urls).toEqual([PUBLIC_FEED, new URL('Relay-new.zip', PUBLIC_FEED).href])
    expect(offered).toEqual(['new'])
    expect(existsSync(path.join(configDir, 'updates', 'Relay.app'))).toBe(true)
    expect(existsSync(path.join(configDir, 'updates', 'Relay.zip'))).toBe(false)
    expect(readFileSync(path.join(configDir, 'updates', 'staged.json'), 'utf8')).toBe(
      '{"build":"new"}',
    )
  })

  it('rejects a zip whose sha256 is not the published one, and does not fetch it again', async () => {
    const { configDir, updater, urls, offered } = setup({ sha256: 'f'.repeat(64) })
    expect(await updater.checkNow()).toBe('failed')
    expect(await updater.checkNow()).toBe('failed')
    expect(offered).toEqual([])
    expect(existsSync(path.join(configDir, 'updates', 'Relay.app'))).toBe(false)
    expect(urls.filter((u) => u.endsWith('.zip'))).toHaveLength(1)
  })

  it('rejects a bundle signed with another identity than the running app', async () => {
    const { configDir, updater, offered } = setup({ staged: 'cdhash H"6a17"' })
    expect(await updater.checkNow()).toBe('failed')
    expect(offered).toEqual([])
    expect(existsSync(path.join(configDir, 'updates', 'staged.json'))).toBe(false)
  })
})
