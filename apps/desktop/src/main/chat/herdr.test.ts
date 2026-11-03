import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import { launchInHerdr, startArgs, type HerdrResult, type HerdrRunner } from './herdr'

const ok = (result: unknown): HerdrResult => ({
  code: 0,
  stdout: JSON.stringify({ result }),
  stderr: '',
})
const fail = (message: string): HerdrResult => ({
  code: 1,
  stdout: '',
  stderr: JSON.stringify({ error: { message } }),
})

/** herdr as the tests script it: each `agent get` answers from `gets` in turn. */
function fakeHerdr(o: {
  gets: HerdrResult[]
  create?: HerdrResult
  startExit?: { code: number | null; stderr: string } | null
}) {
  const calls: string[][] = []
  const started: string[][] = []
  let killed = 0
  const runner: HerdrRunner = {
    run: async (args) => {
      calls.push(args)
      if (args[0] === 'workspace' && args[1] === 'create') {
        return o.create ?? ok({ root_pane: { workspace_id: 'w1', pane_id: 'p1' } })
      }
      if (args[0] === 'agent' && args[1] === 'get') return o.gets.shift() ?? fail('agent not found')
      return ok({})
    },
    start: (args) => {
      started.push(args)
      return {
        exited:
          o.startExit === undefined || o.startExit === null
            ? Promise.withResolvers<{ code: number | null; stderr: string }>().promise
            : Promise.resolve(o.startExit),
        kill: () => {
          killed += 1
        },
      }
    },
  }
  return { runner, calls, started, killed: () => killed }
}

const launch = {
  root: '/Users/i/Eva',
  args: ['--approval-mode', 'yolo'],
  profile: null,
  agentDir: '/a',
}
const fast = { now: () => 5, sleep: async () => undefined, waitMs: 1000, pollMs: 100 }

describe('launchInHerdr', () => {
  it('creates a workspace, starts omp in its pane and returns the session file', async () => {
    const h = fakeHerdr({
      gets: [
        fail('agent not found'),
        ok({ agent: { agent_session: { value: '/s/2026_new.jsonl' } } }),
      ],
    })
    expect(await launchInHerdr(h.runner, launch, fast)).toBe('/s/2026_new.jsonl')
    expect(h.calls[0]).toEqual([
      'workspace',
      'create',
      '--cwd',
      '/Users/i/Eva',
      '--label',
      'Eva',
      '--env',
      'RELAY_HERDR_OWNED=1',
      '--no-focus',
    ])
    expect(h.started).toEqual([
      [
        'agent',
        'start',
        'relay-desktop-5',
        '--kind',
        'omp',
        '--pane',
        'p1',
        '--timeout',
        '30000',
        '--',
        '--approval-mode',
        'yolo',
      ],
    ])
    expect(h.calls.filter((c) => c[1] === 'get')).toHaveLength(2)
  })

  it("says herdr's own error and closes the empty workspace when omp fails to start", async () => {
    const h = fakeHerdr({
      gets: [],
      startExit: { code: 1, stderr: JSON.stringify({ error: { message: 'omp exited' } }) },
    })
    // The exit lands while the first `agent get` is out.
    await expect(launchInHerdr(h.runner, launch, fast)).rejects.toThrow('herdr: omp exited')
    expect(h.calls.at(-1)).toEqual(['workspace', 'close', 'w1'])
  })

  it('gives up when herdr never names the session file, and stops waiting on it', async () => {
    let t = 0
    const h = fakeHerdr({ gets: [] })
    await expect(
      launchInHerdr(h.runner, launch, { ...fast, now: () => (t += 400) }),
    ).rejects.toThrow('herdr started omp but never reported its session file')
    expect(h.killed()).toBe(1)
    expect(h.calls.at(-1)).toEqual(['workspace', 'close', 'w1'])
  })

  it('reports a herdr that is not answering in JSON', async () => {
    const h = fakeHerdr({
      gets: [],
      create: { code: 127, stdout: '', stderr: 'herdr: command not found' },
    })
    await expect(launchInHerdr(h.runner, launch, fast)).rejects.toThrow(
      'herdr: herdr: command not found',
    )
    expect(h.started).toEqual([])
  })

  it('adds the shared config and desktop integrations for a named profile', () => {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-agent-'))
    try {
      const l = { ...launch, profile: 'work' as const, agentDir }
      expect(() => startArgs('n', 'p', l)).toThrow('missing omp desktop integration')
      fs.mkdirSync(path.join(agentDir, 'extensions'))
      for (const f of ['herdr-omp-agent-state.ts', 'relay-bridge.ts']) {
        fs.writeFileSync(path.join(agentDir, 'extensions', f), '')
      }
      expect(startArgs('n', 'p', l).slice(-6)).toEqual([
        '--config',
        path.join(agentDir, 'config.yml'),
        '--extension',
        path.join(agentDir, 'extensions/herdr-omp-agent-state.ts'),
        '--extension',
        path.join(agentDir, 'extensions/relay-bridge.ts'),
      ])
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true })
    }
  })
})
