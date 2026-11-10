import { describe, expect, it } from 'vitest'
import {
  clampRaise,
  fullRouting,
  phaseSteps,
  roundHint,
  routingOverrides,
  spendMeter,
} from './council-view'

const council = {
  stage: 'build',
  round: 2,
  maxRounds: 3,
  parts: ['Head + hands', 'Body + legs'],
} as const

describe('phaseSteps', () => {
  it('marks the round the room is in and everything before it done', () => {
    const steps = phaseSteps({ ...council, parts: [...council.parts] }, false)
    expect(steps.map((s) => s.label)).toEqual([
      'Brief',
      'Contract',
      'Round 1',
      'Round 2',
      'Round 3',
      'Converge',
      'Deliver',
    ])
    expect(steps.map((s) => s.state)).toEqual([
      'done',
      'done',
      'done',
      'now',
      'todo',
      'todo',
      'todo',
    ])
  })

  it('says Plan when the work is not split', () => {
    const steps = phaseSteps({ stage: 'plan', round: 0, maxRounds: 1, parts: ['Whole'] }, false)
    expect(steps[1]).toMatchObject({ label: 'Plan', state: 'now' })
  })

  it('treats round 0 in a round stage as round 1 and clamps past the cap', () => {
    const a = phaseSteps({ stage: 'look', round: 0, maxRounds: 2, parts: ['Whole'] }, false)
    expect(a.find((s) => s.state === 'now')?.label).toBe('Round 1')
    const b = phaseSteps({ stage: 'judge', round: 9, maxRounds: 2, parts: ['Whole'] }, false)
    expect(b.find((s) => s.state === 'now')?.label).toBe('Round 2')
  })

  it('finishes every step once the room is resolved', () => {
    const steps = phaseSteps({ stage: 'deliver', round: 3, maxRounds: 3, parts: ['Whole'] }, true)
    expect(steps.every((s) => s.state === 'done')).toBe(true)
  })
})

describe('roundHint', () => {
  it('marks the stage inside a round', () => {
    expect(roundHint('integrate', true)?.map((s) => s.state)).toEqual([
      'done',
      'done',
      'now',
      'todo',
      'todo',
    ])
  })
  it('is absent outside a round', () => {
    expect(roundHint('brief', true)).toBeNull()
    expect(roundHint('converge', true)).toBeNull()
  })
  it('names the first move Build when the work is not split', () => {
    expect(roundHint('build', false)?.[0]?.label).toBe('Build')
  })
})

describe('spendMeter', () => {
  it('warns at 80 % of the cap, not before', () => {
    expect(spendMeter({ usd: 7.9, estimate: 5, cap: 10 }, false).warn).toBe(false)
    expect(spendMeter({ usd: 8, estimate: 5, cap: 10 }, false).warn).toBe(true)
  })
  it('warns while paused and keeps the bar inside 0..1', () => {
    const m = spendMeter({ usd: 15, estimate: 5, cap: 10 }, true)
    expect(m).toEqual({ ratio: 1, estimateAt: 0.5, warn: true })
  })
})

describe('clampRaise', () => {
  it('allows the current notch and one more, never fewer or two more', () => {
    expect(clampRaise(3, 1)).toBe(3)
    expect(clampRaise(3, 4)).toBe(4)
    expect(clampRaise(3, 6)).toBe(4)
  })
  it('stops at the top notch', () => {
    expect(clampRaise(6, 6)).toBe(6)
  })
})

describe('routingOverrides', () => {
  it('keeps only the roles moved off their default provider', () => {
    expect(routingOverrides(fullRouting({}))).toEqual({})
    expect(routingOverrides(fullRouting({ judge: 'anthropic', builder: 'openai' }))).toEqual({
      judge: 'anthropic',
      builder: 'openai',
    })
  })
})
