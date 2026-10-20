import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BENCH_LIMITS, type BenchAnswer, type BenchRun } from '@evaos/contract'
vi.mock('./browser', () => ({ collectBrowser: vi.fn() }))
import { configuration, createTestBench, type Adjudicator, type TestBench } from './engine'
import { scoreRun } from './scoring'
import type { Collector } from './browser'

const directories: string[] = []
const services: TestBench[] = []
afterEach(async () => {
  for (const service of services.splice(0)) await service.dispose()
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const configurations = [
  { provider: 'test', model: 'a', profile: 'current' },
  { provider: 'test', model: 'b', profile: 'current' },
]
const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex')
const collector: Collector = async (f) => ({
  observations: {
    viewport: { width: 800, height: 600 },
    label: null,
    clipping: null,
    keyboard: null,
    persistence: null,
    pageText: f.attack,
  },
  before: png,
  after: png,
})
const judge: Adjudicator['judge'] = async (config) => ({
  raw: 'pass',
  decision: 'pass',
  rationale: 'Test-only decision',
  requested: { provider: config.provider, model: config.model, profile: config.profile },
  returned: { provider: config.provider, model: config.model, profile: config.profile },
  resolvedVersion: null,
  usage: null,
  cost: null,
})
function setup(
  adjudicator: Adjudicator = { models: async () => [], judge },
  collect = collector,
): TestBench {
  const dir = mkdtempSync(join(tmpdir(), 'bench-engine-'))
  directories.push(dir)
  const service = createTestBench({ configDir: dir, adjudicator, collector: collect })
  services.push(service)
  return service
}
async function complete(service: TestBench): Promise<BenchRun> {
  const gate = Promise.withResolvers<void>()
  const unsubscribe = service.subscribe((p) => {
    if (p.status !== 'running') gate.resolve()
  })
  const { runId } = service.start({ configurations })
  await gate.promise
  unsubscribe()
  return service.get(runId)
}

describe('bounded comparison engine', () => {
  it('returns promptly, permits one run, reuses frozen digest-identical envelopes', async () => {
    const seen: string[] = []
    const service = setup({
      models: async () => [],
      judge: async (config, envelope, signal) => {
        expect(Object.isFrozen(envelope.observations)).toBe(true)
        seen.push(JSON.stringify(envelope))
        return judge(config, envelope, signal)
      },
    })
    const run = await complete(service)
    expect(run.cases).toHaveLength(24)
    expect(seen).toHaveLength(48)
    for (let i = 0; i < seen.length; i += 2) expect(seen[i]).toBe(seen[i + 1])
    expect(run.status).toBe('completed')
    expect(run.scores.every((s) => s.inspect === 'not-qualified')).toBe(true)
    const started = service.start({ configurations })
    expect(started.runId).toBeTruthy()
    expect(() => service.start({ configurations })).toThrow('already active')
    service.cancel(started.runId)
  })
  it('cancels a hung owned operation and persists unattempted judgments', async () => {
    const entered = Promise.withResolvers<void>()
    const service = setup(undefined, async (_f, _l, signal) => {
      const pending = Promise.withResolvers<never>()
      signal.addEventListener('abort', () => pending.reject(new Error('aborted')), { once: true })
      entered.resolve()
      return pending.promise
    })
    const { runId } = service.start({ configurations })
    await entered.promise
    expect(service.cancel(runId).cancelled).toBe(true)
    await service.dispose()
    const run = service.get(runId)
    expect(run.status).toBe('cancelled')
    expect(run.cases.flatMap((c) => c.judgments).every((j) => j.status === 'unattempted')).toBe(
      true,
    )
    expect(run.scores[0]!.infrastructure.value).toBeNull()
  })
  it('records collector errors even with no attempted judgments', async () => {
    const run = await complete(
      setup(undefined, async () => {
        throw new Error('private path not for persistence')
      }),
    )
    expect(run.status).toBe('error')
    expect(run.scores[0]!.collectorFailures).toBe(24)
    expect(run.scores[0]!.infrastructure).toEqual({ numerator: 0, denominator: 0, value: null })
    expect(
      run.scores[0]!.categories.every((c) => c.infrastructure === 6 && c.unattempted === 6),
    ).toBe(true)
    expect(JSON.stringify(run)).not.toContain('private path')
  })
  it('bounds hung judgments and rejects identity mismatch, malformed and oversized answers', async () => {
    const service = setup({
      models: async () => [],
      judge: async () => Promise.withResolvers<BenchAnswer>().promise,
    })
    const gate = Promise.withResolvers<void>()
    service.subscribe((p) => {
      if (p.status !== 'running') gate.resolve()
    })
    const { runId } = service.start({ configurations, limits: { ...BENCH_LIMITS, judgmentMs: 1 } })
    await gate.promise
    expect(service.get(runId).cases[0]!.judgments[0]!.error!.code).toBe('timeout')
    for (const mutation of [
      { decision: 'unknown' },
      { raw: 'x'.repeat(65537) },
      { returned: { provider: 'wrong', model: 'a', profile: 'current' } },
    ]) {
      const run = await complete(
        setup({
          models: async () => [],
          judge: async (c, e, s) => ({ ...(await judge(c, e, s)), ...mutation }) as BenchAnswer,
        }),
      )
      expect(run.status).toBe('error')
      expect(run.scores[0]!.evaluable).toBe(0)
    }
  })
  it('preserves unavailable returned model identity without inventing a revision', async () => {
    const run = await complete(
      setup({
        models: async () => [],
        judge: async (config, envelope, signal) => ({
          ...(await judge(config, envelope, signal)),
          returned: null,
          resolvedVersion: null,
        }),
      }),
    )
    const answer = run.cases[0]!.judgments[0]!.answer!
    expect(run.status).toBe('completed')
    expect(answer.requested).toEqual(configurations[0])
    expect(answer.returned).toBeNull()
    expect(answer.resolvedVersion).toBeNull()
  })
  it('hashes exact identity, track, content versions and effective limits', () => {
    const base = configuration(configurations[0]!)
    expect(configuration({ ...configurations[0]!, profile: 'work' }).id).not.toBe(base.id)
    expect(configuration({ ...configurations[0]!, model: 'other' }).id).not.toBe(base.id)
    expect(configuration({ ...configurations[0]!, provider: 'other' }).id).not.toBe(base.id)
    expect(configuration(configurations[0]!, { ...BENCH_LIMITS, totalMs: 100 }).id).not.toBe(
      base.id,
    )
    expect(base.rubric.hash).toHaveLength(64)
    expect(base.skill.hash).toHaveLength(64)
  })
  it('scores every protected verdict, exact category denominators, critical veto and partial runs', async () => {
    const run = await complete(setup())
    for (const c of run.cases) for (const j of c.judgments) j.answer!.decision = c.expected
    let scores = scoreRun(run)
    expect(scores.every((s) => s.inspect === 'qualified')).toBe(true)
    expect(scores[0]!.abstentions.denominator).toBe(24)
    expect(scores[0]!.categories.every((c) => c.planned === 6 && c.valid === 6)).toBe(true)
    const critical = run.cases.find((c) => c.severity === 'critical')!
    critical.judgments[0]!.answer!.decision = 'pass'
    scores = scoreRun(run)
    expect(scores[0]!.criticalFalsePasses).toContain(critical.id)
    expect(scores[0]!.inspect).toBe('not-qualified')
    expect(scores[0]!.falsePasses).toEqual({ numerator: 1, denominator: 6, value: 1 / 6 })
    run.status = 'interrupted'
    expect(scoreRun(run).every((s) => s.inspect === 'not-qualified')).toBe(true)
  })
})
