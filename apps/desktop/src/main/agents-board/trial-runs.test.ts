import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SpecialistCaller, SpecialistRun, SpecialistRuns } from '@evaos/contract'
import { TrialRuns } from './trial-runs'

const T0 = Date.parse('2026-11-17T10:00:00.000Z')
const iso = (ms: number): string => new Date(ms).toISOString()
let n = 0
const event = (
  component: string,
  name: string,
  data: Record<string, unknown>,
  at: number,
  run = 'r',
): string =>
  JSON.stringify({
    id: `e${++n}`,
    type: `${component}/${name}`,
    component,
    job: 'draw',
    run,
    at: iso(at),
    data,
  }) + '\n'

const caller = (raw: string | undefined): SpecialistCaller =>
  raw?.startsWith('agent:') ? { kind: 'assistant', id: raw.slice(6) } : { kind: 'none' }

const run = (r: Partial<SpecialistRun> & { run: string; agent: string }): SpecialistRun => ({
  caller: { kind: 'assistant', id: 'nova' },
  status: 'running',
  summary: null,
  error: null,
  model: 'claude-opus-5-5',
  at: T0,
  seconds: null,
  cost: null,
  ...r,
})
const report = (runs: SpecialistRun[]): SpecialistRuns => ({
  available: true,
  error: null,
  days: 7,
  runs,
  agents: [],
  updatedAt: T0,
})

const started = event(
  'diagram',
  'trial.started',
  {
    trialId: 'trial-1',
    requestId: 'req-1',
    caller: 'agent:nova',
    job: 'draw',
    request: 'A flow chart of the deploy',
    arms: [
      { letter: 'A', model: 'gpt-6.1', label: 'GPT-6.1 Sol', default: false },
      { letter: 'B', model: 'claude-opus-5-5', label: 'Opus 5.5', default: true },
      { letter: 'C', model: 'claude-sonnet-5-5', label: 'Sonnet 5.5', default: false },
    ],
  },
  T0,
  'trial-1',
)

describe('TrialRuns', () => {
  const dirs: string[] = []
  const journal = (): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trial-runs-'))
    dirs.push(dir)
    return path.join(dir, 'events.ndjson')
  }
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
  })

  it("adds the other arms as lettered runs, letters the caller's run, and hides models until the pick", () => {
    const file = journal()
    fs.writeFileSync(
      file,
      event('web-researcher', 'job.started', { model: 'x' }, T0) +
        started +
        event(
          'diagram',
          'job.started',
          { model: 'gpt-6.1', trial: { id: 'trial-1', letter: 'A', role: 'arm' } },
          T0,
          'arm-a',
        ) +
        event(
          'diagram',
          'job.started',
          { model: 'claude-sonnet-5-5', trial: { id: 'trial-1', letter: 'C', role: 'arm' } },
          T0,
          'arm-c',
        ) +
        event('diagram', 'job.succeeded', { model: 'gpt-6.1', seconds: 12 }, T0 + 12_000, 'arm-a'),
    )
    const trials = new TrialRuns(file)
    const caller1 = run({ run: 'req-1', agent: 'diagram' })
    let out = trials.apply(report([caller1]), caller, T0 + 20_000, 7)
    expect(out.runs).toEqual([
      { ...caller1, trial: 'B', model: null },
      expect.objectContaining({
        run: 'trial-1:A',
        agent: 'diagram',
        caller: { kind: 'assistant', id: 'nova' },
        status: 'done',
        seconds: 12,
        model: null,
        summary: 'A flow chart of the deploy',
        trial: 'A',
      }),
      expect.objectContaining({ run: 'trial-1:C', status: 'running', model: null, trial: 'C' }),
    ])

    // C fails (its trial.result), an append read from where the last read stopped; then the pick.
    fs.appendFileSync(
      file,
      event(
        'diagram',
        'trial.result',
        {
          trialId: 'trial-1',
          letter: 'C',
          model: 'claude-sonnet-5-5',
          ok: false,
          error: 'rate limited',
          seconds: 3,
          cost: 0.02,
        },
        T0 + 30_000,
        'trial-1',
      ) +
        event(
          'diagram',
          'trial.picked',
          { trialId: 'trial-1', pick: 'A', surface: 'desktop', by: 'isaac' },
          T0 + 40_000,
          'pick-1',
        ),
    )
    out = trials.apply(report([caller1]), caller, T0 + 50_000, 7)
    expect(out.runs[0]).toEqual({ ...caller1, trial: 'B' })
    expect(out.runs.find((r) => r.run === 'trial-1:A')?.model).toBe('gpt-6.1')
    expect(out.runs.find((r) => r.run === 'trial-1:C')).toMatchObject({
      status: 'failed',
      error: 'rate limited',
      seconds: 3,
      cost: 0.02,
      model: 'claude-sonnet-5-5',
    })

    // A week later the trial is out of the window.
    out = trials.apply(report([]), caller, T0 + 8 * 24 * 60 * 60_000, 7)
    expect(out.runs).toEqual([])
  })

  it('names the new model on runs after a switch for a day, unless it was undone or kept', () => {
    const file = journal()
    const switched = (id: string, at: number, kept = false) =>
      event(
        'diagram',
        'trial.switched',
        {
          switchId: id,
          from: 'claude-opus-5-5',
          to: 'claude-sonnet-5-5',
          fromLabel: 'Opus 5.5',
          toLabel: 'Sonnet 5.5',
          kept,
          wins: 8,
          of: 10,
          over: [],
          overLabels: [],
          text: 'x',
          undo: {},
        },
        at,
        id,
      )
    fs.writeFileSync(file, switched('s1', T0) + switched('s0', T0, true))
    const trials = new TrialRuns(file)
    const before = run({ run: 'old', agent: 'diagram', at: T0 - 1000 })
    const after = run({ run: 'new', agent: 'diagram', at: T0 + 1000 })
    const other = run({ run: 'web', agent: 'web-researcher', at: T0 + 2000 })
    let out = trials.apply(report([other, after, before]), caller, T0 + 5000, 7)
    expect(out.runs).toEqual([other, { ...after, newModel: 'Sonnet 5.5' }, before])
    // A day on, the badge says the name again.
    out = trials.apply(report([after]), caller, T0 + 24 * 60 * 60_000, 7)
    expect(out.runs).toEqual([after])

    fs.writeFileSync(file, switched('s2', T0))
    const undone = new TrialRuns(file)
    expect(undone.apply(report([after]), caller, T0 + 5000, 7).runs).toEqual([
      { ...after, newModel: 'Sonnet 5.5' },
    ])
    fs.appendFileSync(file, event('diagram', 'trial.undone', { switchId: 's2' }, T0 + 6000, 'undo'))
    expect(undone.apply(report([after]), caller, T0 + 7000, 7).runs).toEqual([after])
  })

  it('reads nothing from a missing journal and keeps a half-written line for the next read', () => {
    const file = journal()
    const trials = new TrialRuns(file)
    const r = report([run({ run: 'req-1', agent: 'diagram' })])
    expect(trials.apply(r, caller, T0, 7)).toBe(r)
    fs.writeFileSync(file, started.slice(0, 40))
    expect(trials.apply(r, caller, T0, 7)).toBe(r)
    fs.appendFileSync(file, started.slice(40))
    expect(trials.apply(r, caller, T0, 7).runs.map((x) => x.run)).toEqual([
      'req-1',
      'trial-1:A',
      'trial-1:C',
    ])
  })
})
