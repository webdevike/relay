import { describe, expect, it, vi } from 'vitest'
import {
  backgroundJobs,
  claudeSubagentDone,
  ompSubagentEnded,
  subagentOver,
  subagentsFromListing,
} from './jobs'

const j = (o: unknown) => JSON.stringify(o)
const call = j({
  type: 'message',
  message: {
    role: 'assistant',
    content: [{ type: 'toolCall', id: 't1', arguments: { command: 'npm   test' } }],
  },
})
const started = j({
  type: 'message',
  timestamp: '2026-01-01T00:00:00Z',
  message: {
    role: 'toolResult',
    toolCallId: 't1',
    details: { async: { state: 'running', jobId: 'j1' } },
  },
})

describe('backgroundJobs', () => {
  it('starts a job labelled by its command', () => {
    expect(backgroundJobs([call, started].join('\n'))).toEqual([
      { id: 'j1', label: 'npm test', kind: 'job', startedAt: Date.parse('2026-01-01T00:00:00Z') },
    ])
  })
  it('ends on a delivery', () => {
    const end = j({ type: 'custom_message', details: { jobs: [{ jobId: 'j1' }] } })
    expect(backgroundJobs([call, started, end].join('\n'))).toEqual([])
  })
  it('ends on a completed snapshot but not a running one', () => {
    const done = j({
      type: 'message',
      message: { details: { jobs: [{ id: 'j1', status: 'completed' }] } },
    })
    const run = j({
      type: 'message',
      message: { details: { jobs: [{ id: 'j1', status: 'running' }] } },
    })
    expect(backgroundJobs([call, started, done].join('\n'))).toEqual([])
    expect(backgroundJobs([call, started, run].join('\n'))).toHaveLength(1)
  })
  it('reads custom_message top-level details and skips task jobs', () => {
    const custom = j({
      type: 'custom_message',
      details: { async: { state: 'running', jobId: 'c1' } },
    })
    const task = j({
      type: 'message',
      message: { details: { async: { state: 'running', jobId: 'k', type: 'task' } } },
    })
    const jobs = backgroundJobs([custom, task].join('\n'))
    expect(jobs.map((x) => x.id)).toEqual(['c1'])
    expect(jobs[0]?.label).toBe('c1')
  })
  it('one-lines long labels to 160 chars', () => {
    const long = j({
      type: 'message',
      message: {
        content: [{ type: 'toolCall', id: 't2', arguments: { command: 'x'.repeat(400) } }],
      },
    })
    const s = j({
      type: 'message',
      message: { toolCallId: 't2', details: { async: { state: 'running', jobId: 'j2' } } },
    })
    expect(Array.from(backgroundJobs([long, s].join('\n'))[0]?.label ?? '')).toHaveLength(160)
  })
  it('orders oldest first', () => {
    const a = j({
      type: 'message',
      message: { details: { async: { state: 'running', jobId: 'a' } } },
    })
    const b = j({
      type: 'message',
      message: { details: { async: { state: 'running', jobId: 'b' } } },
    })
    expect(backgroundJobs([a, b].join('\n')).map((x) => x.id)).toEqual(['a', 'b'])
  })
  it('skips lines without markers and ignores malformed JSON', () => {
    const spy = vi.spyOn(JSON, 'parse')
    backgroundJobs(['{"type":"message","message":{"content":"hello"}}', '{"x":1}'].join('\n'))
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
    expect(backgroundJobs('{"async": nope\n' + [call, started].join('\n'))).toHaveLength(1)
  })
})

describe('subagentsFromListing', () => {
  it('pairs jsonl with md and sorts newest first', () => {
    expect(
      subagentsFromListing([
        { name: 'a.jsonl', mtimeMs: 1 },
        { name: 'a.md', mtimeMs: 2 },
        { name: 'b.jsonl', mtimeMs: 5 },
        { name: 'notes.txt', mtimeMs: 9 },
      ]),
    ).toEqual([
      { name: 'b', file: 'b.jsonl', mtimeMs: 5, done: false },
      { name: 'a', file: 'a.jsonl', mtimeMs: 1, done: true, resultMtimeMs: 2 },
    ])
  })
  it('says when the `.md` was written, so a transcript newer than it is seen', () => {
    expect(
      subagentsFromListing([
        { name: 'a.jsonl', mtimeMs: 9000 },
        { name: 'a.md', mtimeMs: 2000 },
      ]),
    ).toEqual([{ name: 'a', file: 'a.jsonl', mtimeMs: 9000, done: true, resultMtimeMs: 2000 }])
  })
  it('yields nothing for md alone', () => {
    expect(subagentsFromListing([{ name: 'a.md', mtimeMs: 1 }])).toEqual([])
  })
})

describe('subagentOver', () => {
  const msg = (m: unknown) => j({ type: 'message', message: m })
  const result = msg({ role: 'toolResult', toolName: 'yield', content: [] })
  const followUp = msg({ role: 'user', content: 'one more thing' })
  const listed = (mtimeMs: number, resultMtimeMs?: number) =>
    subagentsFromListing([
      { name: 'a.jsonl', mtimeMs },
      ...(resultMtimeMs === undefined ? [] : [{ name: 'a.md', mtimeMs: resultMtimeMs }]),
    ])[0]!

  it('is over once omp wrote the `.md` and the transcript has not moved since', () => {
    expect(subagentOver(listed(5000, 5000), [followUp, result].join('\n'))).toBe(true)
    expect(subagentOver(listed(5200, 5000), '')).toBe(true)
  })
  it('is running again when a follow-up woke it: the transcript is newer than the `.md` and does not end', () => {
    expect(subagentOver(listed(9000, 5000), [result, followUp].join('\n'))).toBe(false)
  })
  it('is over again at its next result, even though the old `.md` is older than the transcript', () => {
    expect(subagentOver(listed(9000, 5000), [result, followUp, result].join('\n'))).toBe(true)
  })
  it('without a `.md` it is over only where its transcript ends', () => {
    expect(subagentOver(listed(9000), [followUp].join('\n'))).toBe(false)
    expect(subagentOver(listed(9000), [followUp, result].join('\n'))).toBe(true)
  })
})

describe('claudeSubagentDone', () => {
  const asst = (content: unknown[]) => j({ uuid: 'u', type: 'assistant', message: { content } })
  it('is done on a plain assistant reply', () => {
    expect(claudeSubagentDone(asst([{ type: 'text', text: 'ok' }]))).toBe(true)
  })
  it('is not done ending on tool_use or a user record', () => {
    expect(claudeSubagentDone(asst([{ type: 'tool_use', id: 'x' }]))).toBe(false)
    expect(
      claudeSubagentDone([asst([{ type: 'text' }]), j({ uuid: 'v', type: 'user' })].join('\n')),
    ).toBe(false)
  })
})

describe('ompSubagentEnded', () => {
  const msg = (m: unknown) => j({ type: 'message', message: m })
  const result = msg({ role: 'toolResult', toolName: 'yield', content: [] })
  const exit = j({ type: 'custom', customType: 'session_exit', data: { reason: 'dispose' } })
  const start = j({ type: 'custom', customType: 'tool_execution_start', data: {} })
  it('ends on the yield result or session_exit, with trailing blank lines and a half-written line', () => {
    expect(ompSubagentEnded([start, result].join('\n') + '\n\n')).toBe(true)
    expect(ompSubagentEnded([result, exit].join('\n') + '\n')).toBe(true)
    expect(ompSubagentEnded([result, start].join('\n'))).toBe(true)
    expect(ompSubagentEnded(`${result}\n{"type":"mess`)).toBe(true)
  })
  it('does not end mid-work or after a follow-up', () => {
    expect(ompSubagentEnded('')).toBe(false)
    expect(ompSubagentEnded(msg({ role: 'toolResult', toolName: 'read' }))).toBe(false)
    expect(ompSubagentEnded([result, msg({ role: 'user', content: 'more' })].join('\n'))).toBe(
      false,
    )
  })
})
