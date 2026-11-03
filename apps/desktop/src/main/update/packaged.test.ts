import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { LatestSchema, bundleOf, ownBuild, readSource, swapScript } from './packaged'

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

  it('swap script waits for the pid, clones, swaps and reopens', () => {
    const s = swapScript()
    expect(s).toContain('kill -0 "$pid"')
    expect(s).toContain('cp -cR "$staged" "$new"')
    expect(s.trim().endsWith('open "$dest"')).toBe(true)
  })
})
