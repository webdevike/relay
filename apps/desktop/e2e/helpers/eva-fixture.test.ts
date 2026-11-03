import { afterEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { EXPECT_P3, makeEvaFixture, type EvaFixture } from './eva-fixture'
import { buildLaunchEnv } from '../fixtures'
import { FAKE_GATE, FAKE_JOB_RUN } from './paths'

const made: EvaFixture[] = []
const make = (o?: Parameters<typeof makeEvaFixture>[0]) => {
  const fx = makeEvaFixture(o)
  made.push(fx)
  return fx
}
afterEach(() => {
  while (made.length) made.pop()!.cleanup()
})

const walk = (d: string): string[] =>
  fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(d, e.name)
    return e.isDirectory() ? [p, ...walk(p)] : [p]
  })

describe('makeEvaFixture', () => {
  it('copies the template with no tokens left in paths or contents', () => {
    const fx = make()
    for (const p of walk(fx.root)) {
      expect(p).not.toContain('{{')
      if (fs.statSync(p).isFile()) expect(fs.readFileSync(p, 'utf8')).not.toContain('{{')
    }
    const runs = fs.readdirSync(path.join(fx.root, 'jobs/.runs/nightly'))
    const d = new Date()
    const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    expect(runs.some((r) => r.startsWith(`${today}T0300`))).toBe(true)
    expect(
      fs.existsSync(
        path.join(
          fx.root,
          'jobs/.runs/nightly',
          runs.find((r) => r !== 'last-run')!,
          'status.json',
        ),
      ),
    ).toBe(true)
  })

  it('resolves dates relative to opts.now', () => {
    const fx = make({ now: new Date(2026, 9, 15, 12, 0, 0) })
    const j = fx.read('memory/journal.md')
    expect(j).toContain('## 2026-10-15 — [flo] Crew app review')
    expect(j).toContain('## 2026-10-14 — [relay] Relay notes')
    const rec = JSON.parse(fx.read('work/meetings/standup.json'))
    const start = new Date(rec.start)
    expect([
      start.getFullYear(),
      start.getMonth(),
      start.getDate(),
      start.getHours(),
      start.getMinutes(),
    ]).toEqual([2026, 9, 15, 9, 30])
    expect(path.isAbsolute(rec.notes)).toBe(true)
    expect(rec.notes.startsWith(fx.root)).toBe(true)
    expect(fs.existsSync(rec.notes)).toBe(true)
    expect(rec.memorized[1].text).toBe('Sam is out (2026-10-18)')
    expect(fx.read('memory/todos.md')).toContain('(added 2026-10-13)')
  })

  it('carries the env for the fakes', () => {
    const fx = make({ gateScenario: 'locked' })
    expect(fx.env).toMatchObject({
      EVAOS_EVA_ROOT: fx.root,
      EVAOS_HABIT_GATE_BIN: FAKE_GATE,
      EVAOS_JOB_RUN_BIN: FAKE_JOB_RUN,
      FAKE_GATE_STATE: path.join(fx.dir, 'gate.json'),
      FAKE_LOG: path.join(fx.dir, 'fake-log.jsonl'),
      FAKE_JOB_RUN_WRITE: '1',
      FAKE_GATE_SCENARIO: 'locked',
    })
    expect(make().env.FAKE_GATE_SCENARIO).toBe('unlocked')
    expect(fx.gateLog()).toEqual([])
  })

  it('cleanup removes the dir and EXPECT_P3 matches the README table', () => {
    const fx = makeEvaFixture()
    fx.cleanup()
    expect(fs.existsSync(fx.dir)).toBe(false)
    expect(EXPECT_P3).toEqual({
      workspaces: 7,
      openTodos: 5,
      nextId: 'T16',
      updatesThisWeek: 4,
      filters: { all: 7, active: 5, todos: 4, quiet: 2 },
      jobs: 6,
      scheduledJobs: 4,
      meetings: 5,
      pendingProposals: 3,
      meetingsThisWeek: 2,
    })
    const readme = fs.readFileSync(
      path.join(__dirname, '../../../../fixtures/eva-p3/README.md'),
      'utf8',
    )
    expect(readme).toContain('T16')
    expect(readme).toContain('Quiet 2')
  })
})

describe('buildLaunchEnv fake defaults', () => {
  it('points every launch at the fakes with per-test state, overrides still win', () => {
    process.env.EVAOS_LIVE = '1'
    try {
      const env = buildLaunchEnv('/tmp/cfg')
      expect(env.EVAOS_LIVE).toBeUndefined()
      expect(env.EVAOS_HABIT_GATE_BIN).toBe(FAKE_GATE)
      expect(env.EVAOS_JOB_RUN_BIN).toBe(FAKE_JOB_RUN)
      expect(env.FAKE_GATE_STATE).toBe('/tmp/cfg/fake-gate.json')
      expect(env.FAKE_GATE_PHOTOS).toBe('/tmp/cfg/habit-photos')
      expect(env.EVAOS_HABIT_PHOTOS_DIR).toBe('/tmp/cfg/habit-photos')
      expect(buildLaunchEnv('/tmp/cfg', { FAKE_GATE_SCENARIO: 'locked' }).FAKE_GATE_SCENARIO).toBe(
        'locked',
      )
    } finally {
      delete process.env.EVAOS_LIVE
    }
  })
})
