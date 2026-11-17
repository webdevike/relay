import { describe, expect, it } from 'vitest'
import { SpecialistRunsSchema } from '@evaos/contract'
import { callerOf, specialistRunsOf } from './runs'

const assistants = [
  { id: 'nova', file: '/s/nova.jsonl' },
  { id: 'astra', file: null },
]
const title = (file: string): string | null => (file === '/s/chat.jsonl' ? 'Fix the dock' : null)

describe('callerOf', () => {
  it('names an assistant by scope or by its thread file, a chat by its title, and says when nobody did', () => {
    expect(callerOf('agent:astra', assistants, title)).toEqual({ kind: 'assistant', id: 'astra' })
    expect(callerOf('/s/nova.jsonl', assistants, title)).toEqual({ kind: 'assistant', id: 'nova' })
    expect(callerOf('/s/chat.jsonl', assistants, title)).toEqual({
      kind: 'chat',
      file: '/s/chat.jsonl',
      title: 'Fix the dock',
    })
    expect(callerOf('cli', assistants, title)).toEqual({ kind: 'other', label: 'cli' })
    expect(callerOf(undefined, assistants, title)).toEqual({ kind: 'none' })
  })
})

describe('specialistRunsOf', () => {
  it("reads `atomic-agents runs` (its last stdout line) into the page's runs and usage", () => {
    const report = {
      since: '2026-11-10T00:00:00.000Z',
      days: 7,
      runs: [
        {
          run: 'r-2',
          agent: 'web-researcher',
          status: 'done',
          caller: 'agent:nova',
          summary: 'Which SSD?',
          model: 'anthropic/claude-haiku-5-5',
          job: 'answer',
          requestedAt: '2026-11-16T10:00:00.000Z',
          seconds: 29.4,
          cost: 0.0061,
        },
        {
          run: '20261117T080000-abcd1234',
          agent: 'gmail',
          status: 'failed',
          error: 'no key',
          startedAt: '2026-11-17T08:00:00.000Z',
        },
      ],
      agents: [
        {
          agent: 'web-researcher',
          calls: 2,
          failed: 0,
          cost: 0.012,
          callers: [{ caller: 'agent:nova', calls: 1 }, { calls: 1 }],
        },
      ],
    }
    const out = specialistRunsOf(
      `log line\n${JSON.stringify(report)}\n`,
      (raw) => callerOf(raw, assistants, title),
      5,
    )
    expect(SpecialistRunsSchema.parse(out)).toEqual(out)
    expect(out.runs[0]).toEqual({
      run: 'r-2',
      agent: 'web-researcher',
      caller: { kind: 'assistant', id: 'nova' },
      status: 'done',
      summary: 'Which SSD?',
      job: 'answer',
      error: null,
      model: 'anthropic/claude-haiku-5-5',
      at: Date.parse('2026-11-16T10:00:00.000Z'),
      seconds: 29.4,
      cost: 0.0061,
    })
    // A run nobody asked for (cron) has no request time: it dates from its start.
    expect(out.runs[1]).toMatchObject({
      caller: { kind: 'none' },
      at: Date.parse('2026-11-17T08:00:00.000Z'),
      job: null,
      error: 'no key',
    })
    expect(out.agents[0]!.callers).toEqual([
      { caller: { kind: 'assistant', id: 'nova' }, calls: 1 },
      { caller: { kind: 'none' }, calls: 1 },
    ])
    expect(() => specialistRunsOf('error: boom', () => ({ kind: 'none' }), 0)).toThrow()
  })
})
