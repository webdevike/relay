import { describe, expect, it } from 'vitest'
import type { Assistant, SpecialistRuns } from '@evaos/contract'
import { callerName, specialistsSummary } from './specialists-view'

const nova = { id: 'nova', title: 'Nova' } as Assistant

describe('callerName', () => {
  it('names an assistant by its title (else its id), a chat by its title, and says when nobody did', () => {
    expect(callerName({ kind: 'assistant', id: 'nova' }, [nova])).toBe('Nova')
    expect(callerName({ kind: 'assistant', id: 'penny' }, [nova])).toBe('Penny')
    expect(callerName({ kind: 'chat', file: '/s/a.jsonl', title: 'Fix the dock' }, [])).toBe(
      'Fix the dock',
    )
    expect(callerName({ kind: 'chat', file: '/s/a.jsonl', title: null }, [])).toBe('A chat')
    expect(callerName({ kind: 'other', label: 'cli' }, [])).toBe('cli')
    expect(callerName({ kind: 'none' }, [])).toBe('Caller not recorded')
  })
})

describe('specialistsSummary', () => {
  const data = (agents: SpecialistRuns['agents']): SpecialistRuns => ({
    available: true,
    error: null,
    days: 7,
    runs: [],
    agents,
    updatedAt: 0,
  })
  it('counts the week across specialists, with the cost when any reported one', () => {
    expect(
      specialistsSummary(
        data([
          { agent: 'web-researcher', calls: 2, failed: 0, cost: 0.012, callers: [] },
          { agent: 'gmail', calls: 1, failed: 1, cost: 0, callers: [] },
        ]),
      ),
    ).toBe('3 runs in 7 days, $0.01')
    expect(
      specialistsSummary(data([{ agent: 'gmail', calls: 1, failed: 0, cost: 0, callers: [] }])),
    ).toBe('1 run in 7 days')
    expect(specialistsSummary(data([]))).toBe('No runs in 7 days')
  })
})
