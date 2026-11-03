import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  KICK_FILE,
  LatestSchema,
  bundleOf,
  keepsIdentity,
  ownBuild,
  readSource,
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

  it('a kick file triggers a check and is consumed', async () => {
    const d = tmp()
    const { promise, resolve } = Promise.withResolvers<void>()
    const stop = watchKick(d, resolve)
    writeFileSync(path.join(d, KICK_FILE), '')
    await promise
    stop()
    expect(existsSync(path.join(d, KICK_FILE))).toBe(false)
  })
})
