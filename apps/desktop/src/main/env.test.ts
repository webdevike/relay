import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { ompSessionFolderName, resolveEnv, type ResolveEnvInput } from './env'

/** A throwaway home dir, with an Eva folder when `eva` (Isaac's Mac). */
function fakeHome(eva: boolean): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-env-'))
  if (eva) fs.mkdirSync(path.join(home, 'Eva'))
  return home
}

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
    expect(e.ompProfilesDir).toBe('/repo/fixtures/omp-profiles')
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

  it('uses the real root and the Relay Dev folder when EVAOS_LIVE=1 without EVAOS_STABLE', () => {
    const home = fakeHome(true)
    const e = resolveEnv(base({ homedir: home, env: { EVAOS_LIVE: '1' } }))
    expect(e.live).toBe(true)
    expect(e.stable).toBe(false)
    expect(e.instance).toBe('dev')
    expect(e.evaRoot).toBe(path.join(home, 'Eva'))
    expect(e.profile).toBe('eva')
    expect(e.setupComplete).toBe(true)
    expect(e.configDir).toBe(path.join(home, 'Library/Application Support/Relay Dev'))
    expect(e.legacyConfigDir).toBeNull()
    expect(e.relayDir).toBeNull()
    expect(e.sessionsDir).toBe(path.join(home, '.omp/agent/sessions/-Eva'))
    expect(typeof e.ompBin).toBe('string')
    expect(e.ompProfilesDir).toBe(path.join(home, '.omp/profiles'))
    expect(
      resolveEnv(
        base({ homedir: home, env: { EVAOS_LIVE: '1', EVAOS_OMP_PROFILES_DIR: '/p' } }),
      ).ompProfilesDir,
    ).toBe('/p')
    expect(
      resolveEnv(base({ homedir: home, env: { EVAOS_LIVE: '1', EVAOS_RELAY_DIR: '/r' } })).relayDir,
    ).toBe('/r')
  })

  it('reads home.json: a starter root that still needs setup', () => {
    const home = fakeHome(false)
    const configDir = path.join(home, 'cfg')
    fs.mkdirSync(configDir, { recursive: true })
    fs.writeFileSync(
      path.join(configDir, 'home.json'),
      JSON.stringify({ root: '~/Relay', profile: 'starter', setupComplete: false }),
    )
    const e = resolveEnv(base({ homedir: home, env: { EVAOS_LIVE: '1', EVAOS_CONFIG_DIR: configDir } }))
    expect(e.profile).toBe('starter')
    expect(e.evaRoot).toBe(path.join(home, 'Relay'))
    expect(e.homeRoot).toBe(path.join(home, 'Relay'))
    expect(e.setupComplete).toBe(false)
    expect(e.sessionsDir).toBe(path.join(home, '.omp/agent/sessions/-Relay'))
  })

  it('with no home.json and no ~/Eva, is a starter at ~/Relay that needs setup', () => {
    const home = fakeHome(false)
    const e = resolveEnv(base({ homedir: home, env: { EVAOS_LIVE: '1' } }))
    expect(e.profile).toBe('starter')
    expect(e.evaRoot).toBe(path.join(home, 'Relay'))
    expect(e.setupComplete).toBe(false)
  })

  it('falls back to the default home base when home.json is malformed', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const withEva = fakeHome(true)
    const cfgA = path.join(withEva, 'cfg')
    fs.mkdirSync(cfgA, { recursive: true })
    fs.writeFileSync(path.join(cfgA, 'home.json'), '{ nope')
    const a = resolveEnv(base({ homedir: withEva, env: { EVAOS_LIVE: '1', EVAOS_CONFIG_DIR: cfgA } }))
    expect(a.profile).toBe('eva')
    expect(a.evaRoot).toBe(path.join(withEva, 'Eva'))

    const bare = fakeHome(false)
    const cfgB = path.join(bare, 'cfg')
    fs.mkdirSync(cfgB, { recursive: true })
    fs.writeFileSync(path.join(cfgB, 'home.json'), JSON.stringify({ root: '', profile: 'x' }))
    const b = resolveEnv(base({ homedir: bare, env: { EVAOS_LIVE: '1', EVAOS_CONFIG_DIR: cfgB } }))
    expect(b.profile).toBe('starter')
    expect(b.setupComplete).toBe(false)
    err.mockRestore()
  })

  it('names omp session folders from the home-relative root', () => {
    expect(ompSessionFolderName('/Users/x/Eva', '/Users/x')).toBe('-Eva')
    expect(ompSessionFolderName('/Users/x/Relay', '/Users/x')).toBe('-Relay')
  })

  it('EVAOS_STABLE=1 is the stable live app in the Relay Desktop folder', () => {
    const home = fakeHome(true)
    const e = resolveEnv(base({ homedir: home, env: { EVAOS_STABLE: '1' } }))
    expect(e.live).toBe(true)
    expect(e.stable).toBe(true)
    expect(e.instance).toBe('stable')
    expect(e.evaRoot).toBe(path.join(home, 'Eva'))
    expect(e.configDir).toBe(path.join(home, 'Library/Application Support/Relay Desktop'))
    expect(e.legacyConfigDir).toBe(path.join(home, 'Library/Application Support/EvaOS Electron'))
    expect(e.relayDir).not.toBeNull()
    expect(e.cdpPort).toBe(9339)
  })

  it('Relay Dev refuses the stable config folder and CDP port', () => {
    const stableDir = '/home/u/Library/Application Support/Relay Desktop'
    expect(() =>
      resolveEnv(base({ env: { EVAOS_LIVE: '1', EVAOS_CONFIG_DIR: stableDir } })),
    ).toThrow(/stable app's config folder/)
    expect(() => resolveEnv(base({ env: { EVAOS_CONFIG_DIR: `${stableDir}/` } }))).toThrow(
      /stable app's config folder/,
    )
    expect(() => resolveEnv(base({ env: { EVAOS_LIVE: '1', EVAOS_CDP_PORT: '9339' } }))).toThrow(
      /9339/,
    )
    expect(() => resolveEnv(base({ env: { EVAOS_CDP_PORT: '9339' } }))).toThrow(/9339/)
    const s = resolveEnv(
      base({ env: { EVAOS_STABLE: '1', EVAOS_CONFIG_DIR: stableDir, EVAOS_CDP_PORT: '9339' } }),
    )
    expect(s.configDir).toBe(stableDir)
    expect(s.cdpPort).toBe(9339)
  })

  it('reads the build id and show-inactive flag', () => {
    const e = resolveEnv(base({ env: { EVAOS_BUILD: 'abc1234', EVAOS_SHOW_INACTIVE: '1' } }))
    expect(e.build).toBe('abc1234')
    expect(e.showInactive).toBe(true)
    const d = resolveEnv(base())
    expect(d.build).toBeNull()
    expect(d.showInactive).toBe(false)
    expect(d.instance).toBe('dev')
  })

  it('treats a packaged app as stable and live, with overrides still winning', () => {
    const home = fakeHome(true)
    const e = resolveEnv(
      base({ homedir: home, isPackaged: true, env: { EVAOS_CONFIG_DIR: '/cfg' } }),
    )
    expect(e.live).toBe(true)
    expect(e.instance).toBe('stable')
    expect(e.evaRoot).toBe(path.join(home, 'Eva'))
    expect(e.profile).toBe('eva')
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

  it('opens CDP on 9339 for the stable app and 9340 for live Relay Dev, never in tests, and honors EVAOS_CDP_PORT', () => {
    expect(resolveEnv(base({ env: { EVAOS_STABLE: '1' } })).cdpPort).toBe(9339)
    expect(resolveEnv(base({ env: { EVAOS_LIVE: '1' } })).cdpPort).toBe(9340)
    expect(resolveEnv(base()).cdpPort).toBeNull()
    expect(resolveEnv(base({ env: { EVAOS_LIVE: '1', EVAOS_E2E: '1' } })).cdpPort).toBeNull()
    expect(resolveEnv(base({ env: { EVAOS_LIVE: '1', EVAOS_CDP_PORT: '0' } })).cdpPort).toBeNull()
    expect(resolveEnv(base({ env: { EVAOS_CDP_PORT: '9444' } })).cdpPort).toBe(9444)
    expect(() => resolveEnv(base({ env: { EVAOS_CDP_PORT: 'x' } }))).toThrow(/EVAOS_CDP_PORT/)
  })

  it('starts agent control for the live app only, unless EVAOS_AGENT_CONTROL says otherwise', () => {
    expect(resolveEnv(base({ env: { EVAOS_LIVE: '1' } })).agentControl).toBe(true)
    expect(resolveEnv(base()).agentControl).toBe(false)
    expect(resolveEnv(base({ env: { EVAOS_AGENT_CONTROL: '1' } })).agentControl).toBe(true)
    expect(
      resolveEnv(base({ env: { EVAOS_LIVE: '1', EVAOS_AGENT_CONTROL: '0' } })).agentControl,
    ).toBe(false)
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

  it("launched from a profile's omp shell, keeps omp's shared agent dir", () => {
    // The bug: herdr looked for the desktop integrations in the shell's profile and failed.
    const e = resolveEnv(
      base({
        env: {
          EVAOS_LIVE: '1',
          EVAOS_EVA_ROOT: '/x',
          PI_CODING_AGENT_DIR: '/home/u/.omp/profiles/personal/agent',
        },
      }),
    )
    expect(e.agentDir).toBe('/home/u/.omp/agent')
  })

  it('explicit agent dir and Claude seams win in both modes', () => {
    const env = { EVAOS_AGENT_DIR: '/ad', EVAOS_CLAUDE_BRIDGE_BIN: '/cb', EVAOS_CLAUDE_BIN: '/cc' }
    for (const live of [{}, { EVAOS_LIVE: '1', EVAOS_EVA_ROOT: '/x' }]) {
      const e = resolveEnv(base({ env: { ...env, ...live } }))
      expect([e.agentDir, e.claudeBridgeBin, e.claudeBin]).toEqual(['/ad', '/cb', '/cc'])
    }
  })

  it('puts canvas boards in a seeded config subfolder outside live mode', () => {
    const e = resolveEnv(base())
    expect(e.canvasDir).toBe('/tmp/evaos-electron-dev-42/canvases')
    expect(e.canvasSeedDir).toBe('/repo/fixtures/canvases')
    expect(e.nativeCanvasPins).toBeNull()
    expect(e.nativeChatSettings).toBeNull()
  })

  it('shares the native EvaOS canvas folder and pins when live', () => {
    const e = resolveEnv(base({ env: { EVAOS_LIVE: '1' } }))
    expect(e.canvasDir).toBe('/home/u/Library/Application Support/EvaOS/canvases')
    expect(e.canvasSeedDir).toBeNull()
    expect(e.nativeCanvasPins).toBe('/home/u/Library/Application Support/EvaOS/canvas.json')
    expect(e.nativeChatSettings).toBe('/home/u/Library/Application Support/EvaOS/chat.json')
  })

  it('EVAOS_CANVAS_DIR wins without seeding, and the real folder needs EVAOS_LIVE', () => {
    const e = resolveEnv(base({ env: { EVAOS_CANVAS_DIR: '/boards' } }))
    expect(e.canvasDir).toBe('/boards')
    expect(e.canvasSeedDir).toBeNull()
    expect(() =>
      resolveEnv(
        base({ env: { EVAOS_CANVAS_DIR: '/home/u/Library/Application Support/EvaOS/canvases' } }),
      ),
    ).toThrow(/EVAOS_LIVE=1/)
  })
})
