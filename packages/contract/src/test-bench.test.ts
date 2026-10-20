import { describe, expect, it } from 'vitest'
import { BENCH_LIMITS, BenchAnswerSchema, BenchStartSchema, testBenchInvoke } from './test-bench'

describe('Test Bench boundary', () => {
  const identity = { provider: 'test', model: 'exact', profile: 'current' }
  it('requires two to four configurations and bounded effective limits', () => {
    expect(BenchStartSchema.safeParse({ configurations: [identity] }).success).toBe(false)
    expect(
      BenchStartSchema.safeParse({ configurations: [identity, identity], limits: BENCH_LIMITS })
        .success,
    ).toBe(true)
    expect(
      BenchStartSchema.safeParse({
        configurations: [identity, identity],
        limits: { ...BENCH_LIMITS, captureMs: 30001 },
      }).success,
    ).toBe(false)
  })
  it('does not accept filesystem evidence paths or additional command keys', () => {
    expect(
      testBenchInvoke['testBench.evidence'].input.safeParse({
        runId: '../x',
        evidenceId: '/tmp/proof.png',
      }).success,
    ).toBe(false)
    expect(
      testBenchInvoke['testBench.models'].input.safeParse({ prompt: 'injected' }).success,
    ).toBe(false)
  })
  it('distinguishes validated decisions from malformed/provider output', () => {
    const answer = {
      raw: '{}',
      decision: 'insufficient-evidence',
      rationale: 'No observation',
      requested: identity,
      returned: identity,
      resolvedVersion: null,
      usage: null,
      cost: null,
    }
    expect(BenchAnswerSchema.parse(answer).cost).toBeNull()
    expect(BenchAnswerSchema.safeParse({ ...answer, decision: 'error' }).success).toBe(false)
    expect(BenchAnswerSchema.safeParse({ ...answer, credentials: 'sentinel' }).success).toBe(false)
  })
})
