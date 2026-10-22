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
    expect(() => resolveEnv(base({ env: { EVAOS_EVA_ROOT: '/home/u/Eva' } }))).toThrow(
      /EVAOS_LIVE=1/,
    )
  })

  it('uses the real root and profile dir when EVAOS_LIVE=1', () => {
    const e = resolveEnv(base({ env: { EVAOS_LIVE: '1' } }))
    expect(e.live).toBe(true)
    expect(e.evaRoot).toBe('/home/u/Eva')
    expect(e.configDir).toBe('/home/u/Library/Application Support/Relay Desktop')
    expect(e.legacyConfigDir).toBe('/home/u/Library/Application Support/EvaOS Electron')
    expect(e.sessionsDir).toBe('/home/u/.omp/agent/sessions/-Eva')
    expect(typeof e.ompBin).toBe('string')
  })

  it('treats a packaged app as live, with overrides still winning', () => {
    const e = resolveEnv(base({ isPackaged: true, env: { EVAOS_CONFIG_DIR: '/cfg' } }))
    expect(e.live).toBe(true)
    expect(e.evaRoot).toBe('/home/u/Eva')
    expect(e.configDir).toBe('/cfg')
    expect(e.legacyConfigDir).toBeNull()
  })

  it('EVAOS_CONFIG_DIR always wins and the arc command can be overridden', () => {
    const e = resolveEnv(
      base({
        env: { EVAOS_CONFIG_DIR: '/c', EVAOS_ARC_EXPORT_CMD: '["node","x.js"]', EVAOS_E2E: '1' },
      }),
    )
    expect(e.configDir).toBe('/c')
    expect(e.arcExportCmd).toEqual(['node', 'x.js'])
    expect(e.e2e).toBe(true)
  })

  it('rejects a malformed arc command', () => {
    expect(() => resolveEnv(base({ env: { EVAOS_ARC_EXPORT_CMD: 'nope' } }))).toThrow(/JSON array/)
  })

  it('defaults gate, job-run, clock and photo dir to fakes outside live mode', () => {
    const e = resolveEnv(base())
    expect(e.habitGateBin).toBe('/repo/fixtures/fake-gate/fake-gate.mjs')
    expect(e.jobRunBin).toBe('/repo/fixtures/fake-job-run/fake-job-run.mjs')
    expect(e.now).toBeNull()
    expect(e.habitPhotosDir).toBe('/tmp/evaos-fake-gate/photos')
  })

  it('uses the real tools and photo dir when live', () => {
    const e = resolveEnv(base({ env: { EVAOS_LIVE: '1', EVAOS_EVA_ROOT: '/x' } }))
    expect(e.habitGateBin).toBe('/x/.omp/tools/habit-gate.ts')
    expect(e.jobRunBin).toBe('/x/.omp/tools/job-run.ts')
    expect(e.habitPhotosDir).toBe('/home/u/.config/eva/habit-photos')
  })

  it('explicit seams win in both modes', () => {
    const env = {
      EVAOS_HABIT_GATE_BIN: '/g',
      EVAOS_JOB_RUN_BIN: '/j',
      EVAOS_HABIT_PHOTOS_DIR: '/p',
    }
    for (const live of [{}, { EVAOS_LIVE: '1', EVAOS_EVA_ROOT: '/x' }]) {
      const e = resolveEnv(base({ env: { ...env, ...live } }))
      expect([e.habitGateBin, e.jobRunBin, e.habitPhotosDir]).toEqual(['/g', '/j', '/p'])
    }
  })

  it('validates EVAOS_NOW', () => {
    expect(resolveEnv(base({ env: { EVAOS_NOW: '2026-10-15T12:00:00Z' } })).now).toBe(
      '2026-10-15T12:00:00Z',
    )
    expect(() => resolveEnv(base({ env: { EVAOS_NOW: 'yesterday' } }))).toThrow(/EVAOS_NOW/)
  })

  it('reads EVAOS_NO_MOTION', () => {
    expect(resolveEnv(base({ env: { EVAOS_NO_MOTION: '1' } })).noMotion).toBe(true)
    expect(resolveEnv(base()).noMotion).toBe(false)
  })

  it('opens CDP on 9339 only for the live app, never in tests, and honors EVAOS_CDP_PORT', () => {
    expect(resolveEnv(base({ env: { EVAOS_LIVE: '1' } })).cdpPort).toBe(9339)
    expect(resolveEnv(base()).cdpPort).toBeNull()
    expect(resolveEnv(base({ env: { EVAOS_LIVE: '1', EVAOS_E2E: '1' } })).cdpPort).toBeNull()
    expect(resolveEnv(base({ env: { EVAOS_LIVE: '1', EVAOS_CDP_PORT: '0' } })).cdpPort).toBeNull()
    expect(resolveEnv(base({ env: { EVAOS_CDP_PORT: '9444' } })).cdpPort).toBe(9444)
    expect(() => resolveEnv(base({ env: { EVAOS_CDP_PORT: 'x' } }))).toThrow(/EVAOS_CDP_PORT/)
  })

  it('defaults agent dir and the Claude bridge to fixtures outside live mode', () => {
    const e = resolveEnv(base())
    expect(e.agentDir).toBe('/repo/fixtures/agent')
    expect(e.claudeBridgeBin).toBe('/repo/fixtures/fake-claude-bridge/fake-bridge.mjs')
    expect(e.claudeBin).toBe(e.claudeBridgeBin)
  })

  it('uses the real agent dir and bridge when live', () => {
    const e = resolveEnv(base({ env: { EVAOS_LIVE: '1', EVAOS_EVA_ROOT: '/x' } }))
    expect(e.agentDir).toBe('/home/u/.omp/agent')
    expect(e.claudeBridgeBin).toBe('/x/.claude/bridge/session.ts')
    expect(e.claudeBin).toBe('/home/u/.local/bin/claude')
    const p = resolveEnv(
      base({ env: { EVAOS_LIVE: '1', EVAOS_EVA_ROOT: '/x', PI_CODING_AGENT_DIR: '/a' } }),
    )
    expect(p.agentDir).toBe('/a')
  })

  it('explicit agent dir and Claude seams win in both modes', () => {
    const env = { EVAOS_AGENT_DIR: '/ad', EVAOS_CLAUDE_BRIDGE_BIN: '/cb', EVAOS_CLAUDE_BIN: '/cc' }
    for (const live of [{}, { EVAOS_LIVE: '1', EVAOS_EVA_ROOT: '/x' }]) {
      const e = resolveEnv(base({ env: { ...env, ...live } }))
      expect([e.agentDir, e.claudeBridgeBin, e.claudeBin]).toEqual(['/ad', '/cb', '/cc'])
    }
  })
})
