import { describe, expect, it } from 'vitest'
import type { Assistant, SpecialistAgent, SpecialistRun } from '@evaos/contract'
import { agentStatus, agentsSummary, callerName, runOrigin } from './specialists-view'

const nova = { id: 'nova', title: 'Nova' } as Assistant

const agent = (over: Partial<SpecialistAgent> = {}): SpecialistAgent => ({
  id: 'web-researcher',
  purpose: 'Answers a question with quoted sources.',
  format: 'folder',
  enabled: true,
  mode: 'live',
  model: 'anthropic/claude-sonnet-5-5',
  fallbackModel: null,
  candidates: [],
  thinking: null,
  how: 'ask',
  runs: { week: 0, failed: 0, running: 0, lastAt: null },
  trial: { on: false, arms: [] },
  error: null,
  ...over,
})

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

describe('runOrigin', () => {
  const run = (caller: SpecialistRun['caller'], job: string | null): SpecialistRun => ({
    run: 'r1',
    agent: 'mail-triage',
    caller,
    status: 'done',
    summary: null,
    job,
    error: null,
    model: null,
    at: 0,
    seconds: 3,
    cost: null,
  })
  it('names who asked, else the job that ran on its own', () => {
    expect(runOrigin(run({ kind: 'assistant', id: 'nova' }, 'triage'), [nova])).toBe(
      'Asked by Nova',
    )
    expect(runOrigin(run({ kind: 'none' }, 'triage'), [])).toBe('triage job')
    expect(runOrigin(run({ kind: 'none' }, null), [])).toBe('Caller not recorded')
  })
})

describe('agentStatus', () => {
  it('puts running first, then a file that does not load, then off, shadow and trial; a live agent at rest says nothing', () => {
    const running = { week: 3, failed: 0, running: 1, lastAt: 1 }
    const trial = { on: true, arms: ['a/one', 'b/two'] }
    expect(agentStatus(agent({ runs: running, error: 'bad yaml', mode: 'off' }))?.label).toBe(
      'Running',
    )
    expect(agentStatus(agent({ error: 'bad yaml', enabled: false }))?.label).toBe('Does not load')
    expect(agentStatus(agent({ enabled: false, mode: 'shadow', trial }))?.label).toBe('Off')
    expect(agentStatus(agent({ mode: 'off' }))?.label).toBe('Off')
    expect(agentStatus(agent({ mode: 'shadow', trial }))?.label).toBe('Shadow')
    expect(agentStatus(agent({ trial }))?.label).toBe('Trial')
    expect(agentStatus(agent({ trial: { on: false, arms: ['a/one', 'b/two'] } }))).toBeNull()
    expect(agentStatus(agent())).toBeNull()
    expect(agentStatus(agent({ mode: null }))).toBeNull()
  })
})

describe('agentsSummary', () => {
  it('counts the agents and names only the ones running or not loading', () => {
    expect(agentsSummary([agent()])).toBe('1 agent')
    expect(
      agentsSummary([
        agent({ runs: { week: 1, failed: 0, running: 2, lastAt: 1 } }),
        agent({ error: 'x' }),
        agent(),
      ]),
    ).toBe('3 agents, 1 running, 1 not loading')
  })
})
