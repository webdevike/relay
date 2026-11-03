import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ArmSummary } from '@evaos/contract'
import {
  costTotals,
  createExperimentsService,
  headline,
  overallStatus,
  parseCases,
  parseRecord,
  verdictStatus,
} from './experiments-service'
import { experimentOf, startExperimentsWatch } from './experiments-ipc'

const roots: string[] = []
afterEach(() => {
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true })
})

function tmpRoot(): string {
  const r = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'evaos-exp-')))
  roots.push(r)
  return r
}

function put(root: string, rel: string, content: string | object): void {
  const file = path.join(root, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content))
}

const RECORD = `# Experiment: ui-check-bench

## 1. Question and hypothesis
- Question: Does the checker find seeded bugs?
- Hypothesis (falsifiable): it does.

## 3. Arms
| Arm | What differs |
|:--|:--|
| control | vision |
| treatment | tool |
| combined | both |

## 4. Metrics and decision
- Primary metric: recall

## Verdict
FAIL; hypothesis rejected. Precision 41%.
`

const q = (metric: string, split: 'dev' | 'holdout', k: number, n: number) => ({
  metric,
  split,
  k,
  n,
  p: k / n,
  lo: Math.max(0, k / n - 0.1),
  hi: Math.min(1, k / n + 0.1),
})

function arm(id: string, role: ArmSummary['role'], k: number, over: Partial<ArmSummary> = {}) {
  return {
    id,
    label: `${id} label`,
    role,
    quality: [q('recall', 'dev', k + 1, 20), q('recall', 'holdout', k, 20)],
    seconds: { median: 1.5, p90: 3, total: 60 },
    cost: { perTest: 0.01, total: 0.4, unit: 'usd' as const },
    gap: { metric: 'recall', dev: (k + 1) / 20, holdout: k / 20, diff: 1 / 20 },
    repeatAgreement: null,
    repeatAgreementReason: 'deterministic tool',
    failures: { errors: 1, timeouts: 0, retries: 2, rate: 0.025 },
    judgeAudit: { k: 9, n: 10, p: 0.9 },
    calibration: null,
    calibrationReason: 'no confidence',
    coverage: { run: 40, planned: 40, skipped: [] },
    casesFile: `runs/2/${id}.jsonl`,
    ...over,
  }
}

const SUMMARY = {
  slug: 'precision',
  title: 'ui-check precision',
  question: 'Can precision reach 90%?',
  created: '2026-10-27T07:00:00Z',
  updated: '2026-10-27T09:00:00Z',
  status: 'pass',
  verdict: 'PASS: precision 92% (85-96).',
  round: 2,
  arms: [
    arm('control', 'control', 10),
    arm('treatment', 'treatment', 18),
    arm('alt', 'treatment', 14),
  ],
}

describe('record.md and verdict parsing', () => {
  it('reads title, question, verdict and arm rows', () => {
    expect(parseRecord(RECORD)).toEqual({
      title: 'ui-check-bench',
      question: 'Does the checker find seeded bugs?',
      verdict: 'FAIL; hypothesis rejected. Precision 41%.',
      arms: 3,
    })
  })
  it('treats template placeholders as missing', () => {
    const facts = parseRecord(
      '# Experiment: x\n- Question: <one question>\n## Verdict\n<Decision rule>\n',
    )
    expect(facts.question).toBeNull()
    expect(facts.verdict).toBeNull()
    expect(facts.arms).toBeNull()
  })
  it('maps verdict words to statuses', () => {
    expect(verdictStatus('**PASS**: all five')).toBe('pass')
    expect(verdictStatus('Verdict: FAIL (hypothesis rejected)')).toBe('fail')
    expect(verdictStatus('Inconclusive at this n')).toBe('inconclusive')
    expect(verdictStatus('Passing notes')).toBeNull()
    expect(verdictStatus(null)).toBeNull()
  })
  it('lets a live run win, then summary, then record, then results.md', () => {
    const live = {
      status: 'running' as const,
      round: 3,
      armsDone: 1,
      casesDone: 4,
      casesPlanned: 10,
      updated: '',
    }
    expect(overallStatus(live, null, 'FAIL', null)).toBe('running')
    expect(overallStatus({ ...live, status: 'scored' }, null, null, null)).toBe('planned')
    // summary.json left at running after the bench scored: the finished status.json and the verdict win.
    const runningSummary = { status: 'running' } as unknown as Parameters<typeof overallStatus>[1]
    expect(
      overallStatus(
        { ...live, status: 'scored' },
        runningSummary,
        null,
        '## Verdict: FAIL (rejected)\n',
      ),
    ).toBe('fail')
    expect(
      overallStatus({ ...live, status: 'scored' }, runningSummary, null, '## Verdict\nranked\n'),
    ).toBe('inconclusive')
    expect(overallStatus(null, runningSummary, null, null)).toBe('running')
    expect(overallStatus(null, null, null, '# r\n\n## Verdict: INCONCLUSIVE\n')).toBe(
      'inconclusive',
    )
    expect(overallStatus(null, null, 'PASS', '## Verdict: FAIL')).toBe('pass')
  })
})

describe('headline', () => {
  it('compares control with the best other arm on the primary metric, holdout first', () => {
    const h = headline(SUMMARY.arms as ArmSummary[])
    expect(h.control?.arm).toBe('control')
    expect(h.control?.metric).toMatchObject({ split: 'holdout', k: 10, n: 20 })
    expect(h.best?.arm).toBe('treatment')
    expect(h.best?.label).toBe('treatment label')
  })
  it('has no sides without quality', () => {
    expect(
      headline([{ ...arm('control', 'control', 1), quality: null, gap: null }] as ArmSummary[]),
    ).toEqual({
      control: null,
      best: null,
    })
  })
})

describe('parseCases', () => {
  it('summarizes outcomes, timeouts, skips and counts invalid lines', () => {
    const lines = [
      {
        case: 'a',
        split: 'dev',
        arm: 'c',
        repeat: 1,
        outcome: { pass: true },
        seconds: 1.2,
        retries: 0,
        ts: 't',
      },
      {
        case: 'b',
        split: 'holdout',
        arm: 'c',
        repeat: 2,
        outcome: { tp: 1, fp: 0 },
        seconds: 2,
        retries: 0,
        ts: 't',
      },
      {
        case: 'c',
        split: 'dev',
        arm: 'c',
        repeat: 1,
        outcome: null,
        error: 'boom',
        timeout: true,
        seconds: 30,
        retries: 1,
        ts: 't',
      },
      {
        case: 'd',
        split: 'dev',
        arm: 'c',
        repeat: 1,
        outcome: null,
        skipped: 'no fixture',
        seconds: 0,
        retries: 0,
        ts: 't',
      },
    ]
    const text = [...lines.map((l) => JSON.stringify(l)), 'not json', '{"nocase":1}', ''].join('\n')
    const parsed = parseCases(text)
    expect(parsed.invalid).toBe(2)
    expect(parsed.truncated).toBe(false)
    expect(parsed.cases.map((c) => [c.case, c.outcome, c.passed, c.error, c.skipped])).toEqual([
      ['a', 'pass', true, null, null],
      ['b', '{"tp":1,"fp":0}', null, null, null],
      ['c', null, null, 'timeout: boom', null],
      ['d', null, null, null, 'no fixture'],
    ])
  })
})

describe('experiments service', () => {
  it('lists experiments newest first with status, round, arms and headline', async () => {
    const root = tmpRoot()
    put(root, '2026-10-26-ui-check-bench/record.md', RECORD)
    put(root, '2026-10-26-ui-check-bench/results.md', '# results\n\n## Verdict: FAIL\n')
    put(root, '2026-10-26-ui-check-bench/rounds/1.md', 'r1')
    put(root, '2026-10-26-ui-check-bench/rounds/10.md', 'r10')
    put(root, '2026-10-26-ui-check-bench/rounds/2.md', 'r2')
    put(root, '2026-10-27-precision/record.md', RECORD)
    put(root, '2026-10-27-precision/summary.json', SUMMARY)
    put(root, '2026-10-28-live/summary.json', { ...SUMMARY, status: 'planned', verdict: null })
    put(root, '2026-10-28-live/status.json', {
      status: 'running',
      round: 3,
      armsDone: 1,
      casesDone: 12,
      casesPlanned: 40,
      updated: '2026-10-28T08:00:00Z',
    })
    fs.mkdirSync(path.join(root, '.hidden'))
    put(root, 'notes.md', 'a file, not an experiment')
    const rows = await createExperimentsService(root).list()
    expect(rows.map((r) => r.id)).toEqual([
      '2026-10-28-live',
      '2026-10-27-precision',
      '2026-10-26-ui-check-bench',
    ])
    const [live, precision, bench] = rows
    expect(live).toMatchObject({
      status: 'running',
      round: '3',
      progress: { done: 12, planned: 40 },
    })
    expect(precision).toMatchObject({
      title: 'ui-check precision',
      status: 'pass',
      round: '2',
      arms: 3,
      hasSummary: true,
      progress: null,
    })
    expect(precision!.headline?.best?.arm).toBe('treatment')
    // Every SUMMARY arm logs the legacy billed shape: 3 x $0.40.
    expect(precision!.cost).toEqual({
      tokens: null,
      listUsd: null,
      unpricedArms: 0,
      billedUsd: expect.closeTo(1.2, 6),
    })
    expect(bench!.cost).toBeNull()
    expect(bench).toMatchObject({
      date: '2026-10-26',
      title: 'ui-check-bench',
      status: 'fail',
      round: '10',
      arms: 3,
      headline: null,
      hasSummary: false,
    })
  })

  it('totals list $, tokens and billed $ over new and legacy arms', async () => {
    const tok = (n: number) => ({ in: n, out: n, cached: n, total: 3 * n })
    const priced = {
      tests: 10,
      tokens: { ...tok(1000), perTestMedian: tok(100) },
      listUsd: { perTest: 0.1, perTestMedian: 0.09, total: 1 },
      billedUsd: { perTest: 0.05, total: 0.5, tests: 10 },
      byModel: [],
    }
    const unpriced = {
      tests: 10,
      tokens: { ...tok(500), perTestMedian: tok(50) },
      listUsd: null,
      unpriced: tok(500),
      unpricedReason: 'no price for local-model',
      byModel: [],
    }
    const root = tmpRoot()
    put(root, '2026-10-27-mixed/summary.json', {
      ...SUMMARY,
      arms: [
        arm('control', 'control', 10, { cost: priced }),
        arm('treatment', 'treatment', 18, { cost: unpriced }),
        arm('alt', 'treatment', 14, { cost: { perTest: 20, total: 800, unit: 'tokens' } }),
        arm('old', 'treatment', 12, { cost: { perTest: 0.01, total: 0.4, unit: 'usd' } }),
        arm('none', 'treatment', 11, { cost: null, costReason: 'not logged' }),
      ],
    })
    const [row] = await createExperimentsService(root).list()
    expect(row!.cost).toEqual({
      tokens: 3000 + 1500 + 800,
      listUsd: 1,
      unpricedArms: 2,
      billedUsd: expect.closeTo(0.9, 6),
    })
    expect(costTotals([])).toEqual({
      tokens: null,
      listUsd: null,
      unpricedArms: 0,
      billedUsd: null,
    })
  })

  it('returns [] when the experiments folder does not exist', async () => {
    expect(await createExperimentsService(path.join(tmpRoot(), 'missing')).list()).toEqual([])
  })

  it('falls back to results.md when summary.json is missing or invalid', async () => {
    const root = tmpRoot()
    put(root, '2026-10-26-old/record.md', RECORD)
    put(root, '2026-10-26-old/results.md', '# results\n\n| a | b |\n')
    put(root, '2026-10-27-broken/results.md', '# broken results')
    put(root, '2026-10-27-broken/summary.json', '{"arms": [{"id": "x"}]')
    const service = createExperimentsService(root)
    const old = await service.get('2026-10-26-old')
    expect(old).toMatchObject({
      question: 'Does the checker find seeded bugs?',
      verdict: 'FAIL; hypothesis rejected. Precision 41%.',
      armSummaries: null,
      resultsMarkdown: '# results\n\n| a | b |\n',
      summaryError: null,
    })
    const broken = await service.get('2026-10-27-broken')
    expect(broken.armSummaries).toBeNull()
    expect(broken.summaryError).toBeTruthy()
    expect(broken.resultsMarkdown).toBe('# broken results')
    expect(await service.cases('2026-10-26-old', 'control')).toMatchObject({
      cases: [],
      reason: 'This experiment has no summary.json yet.',
    })
  })

  it('details a summarized experiment and reads an arm case file inside the folder only', async () => {
    const root = tmpRoot()
    const id = '2026-10-27-precision'
    put(root, `${id}/summary.json`, {
      ...SUMMARY,
      arms: [...SUMMARY.arms, arm('escape', 'treatment', 1, { casesFile: '../outside.jsonl' })],
    })
    put(
      root,
      `${id}/runs/2/control.jsonl`,
      `${JSON.stringify({ case: 'a', split: 'dev', outcome: { pass: false }, seconds: 1 })}\n`,
    )
    put(root, 'outside.jsonl', `${JSON.stringify({ case: 'secret' })}\n`)
    const service = createExperimentsService(root)
    const detail = await service.get(id)
    expect(detail.question).toBe('Can precision reach 90%?')
    expect(detail.verdict).toBe('PASS: precision 92% (85-96).')
    expect(detail.primary).toBe('recall')
    expect(detail.armSummaries?.map((a) => a.id)).toEqual(['control', 'treatment', 'alt', 'escape'])
    expect(detail.armSummaries?.[0]?.repeatAgreementReason).toBe('deterministic tool')
    const cases = await service.cases(id, 'control')
    expect(cases).toMatchObject({ file: 'runs/2/control.jsonl', reason: null, invalid: 0 })
    expect(cases.cases[0]).toMatchObject({ case: 'a', passed: false, outcome: 'fail', seconds: 1 })
    expect((await service.cases(id, 'treatment')).reason).toBe(
      'runs/2/treatment.jsonl does not exist yet.',
    )
    expect((await service.cases(id, 'escape')).reason).toContain('outside the experiment')
    expect((await service.cases(id, 'nope')).reason).toBe('summary.json has no arm nope.')
  })

  it('rejects ids that are paths and unknown experiments', async () => {
    const service = createExperimentsService(tmpRoot())
    await expect(service.get('../etc')).rejects.toThrow()
    await expect(service.get('2026-01-01-none')).rejects.toMatchObject({ code: 'not-found' })
  })
})

describe('experiments watch', () => {
  it('maps only the files the viewer reads', () => {
    const R = '/eva/work/experiments'
    expect(experimentOf(R, `${R}/e1/summary.json`)).toBe('e1')
    expect(experimentOf(R, `${R}/e1/status.json`)).toBe('e1')
    expect(experimentOf(R, `${R}/e1/rounds/3.md`)).toBe('e1')
    expect(experimentOf(R, `${R}/e1`)).toBe('e1')
    expect(experimentOf(R, `${R}/e1/runs/3/control.jsonl`)).toBeNull()
    expect(experimentOf(R, `${R}/e1/notes.txt`)).toBeNull()
    expect(experimentOf(R, R)).toBeNull()
    expect(experimentOf(R, '/eva/work/other/x')).toBeNull()
  })

  it('sends a changed summary.json once, debounced', async () => {
    const root = tmpRoot()
    put(root, 'e1/record.md', RECORD)
    const batches: string[][] = []
    const w = startExperimentsWatch(root, (ids) => batches.push(ids), 50)
    try {
      // Real FSEvents arrive on the platform clock (fake timers cannot drive them); this lets the
      // watcher finish its initial scan before the write, as canvas/watch.test.ts does.
      const settled = Promise.withResolvers<void>()
      setTimeout(settled.resolve, 400)
      await settled.promise
      put(root, 'e1/summary.json', SUMMARY)
      put(root, 'e1/runs/1/control.jsonl', '{}')
      await expect.poll(() => batches.flat(), { timeout: 4000 }).toContain('e1')
      expect(batches.flat().every((id) => id === 'e1')).toBe(true)
    } finally {
      await w.close()
    }
  })
})
