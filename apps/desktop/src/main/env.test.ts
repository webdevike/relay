import { describe, expect, it } from 'vitest'
import { resolveEnv, type ResolveEnvInput } from './env'

const base = (over: Partial<ResolveEnvInput> = {}): ResolveEnvInput => ({
  env: {},
  isPackaged: false,
  repoRoot: '/repo',
  homedir: '/home/u',
  tmpdir: '/tmp',
  pid: 42,
  ...over,
})

describe('resolveEnv', () => {
  it('defaults to fixtures and a temp config dir in dev', () => {
    const e = resolveEnv(base())
    expect(e.evaRoot).toBe('/repo/fixtures/eva-root')
    expect(e.ompBin).toBe('/repo/fixtures/fake-omp/fake-omp.mjs')
    expect(e.sessionsDir).toBe('/repo/fixtures/agent/sessions/-fixture')
    expect(e.configDir).toBe('/tmp/evaos-electron-dev-42')
    expect(e.live).toBe(false)
    expect(e.arcExportCmd).toEqual([
      'bun',
      '.omp/tools/arc-cookies.ts',
      '.omp/tools/lib/evaos-arc-sites.txt',
    ])
  })

  it('refuses the real Eva root without EVAOS_LIVE', () => {
    expect(() => resolveEnv(base({ env: { EVAOS_EVA_ROOT: '/home/u/Eva' } }))).toThrow(/EVAOS_LIVE=1/)
  })

  it('uses the real root and profile dir when EVAOS_LIVE=1', () => {
    const e = resolveEnv(base({ env: { EVAOS_LIVE: '1' } }))
    expect(e.live).toBe(true)
    expect(e.evaRoot).toBe('/home/u/Eva')
    expect(e.configDir).toBe('/home/u/Library/Application Support/EvaOS Electron')
    expect(e.sessionsDir).toBe('/home/u/.omp/agent/sessions/-Eva')
    expect(typeof e.ompBin).toBe('string')
  })

  it('treats a packaged app as live, with overrides still winning', () => {
    const e = resolveEnv(base({ isPackaged: true, env: { EVAOS_CONFIG_DIR: '/cfg' } }))
    expect(e.live).toBe(true)
    expect(e.evaRoot).toBe('/home/u/Eva')
    expect(e.configDir).toBe('/cfg')
  })

  it('EVAOS_CONFIG_DIR always wins and the arc command can be overridden', () => {
    const e = resolveEnv(
      base({ env: { EVAOS_CONFIG_DIR: '/c', EVAOS_ARC_EXPORT_CMD: '["node","x.js"]', EVAOS_E2E: '1' } }),
    )
    expect(e.configDir).toBe('/c')
    expect(e.arcExportCmd).toEqual(['node', 'x.js'])
    expect(e.e2e).toBe(true)
  })

  it('rejects a malformed arc command', () => {
    expect(() => resolveEnv(base({ env: { EVAOS_ARC_EXPORT_CMD: 'nope' } }))).toThrow(/JSON array/)
  })
})
