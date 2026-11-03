import { describe, expect, it, vi } from 'vitest'
import { backgroundJobs, claudeSubagentDone, subagentsFromListing } from './jobs'

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
      { name: 'a', file: 'a.jsonl', mtimeMs: 1, done: true },
    ])
  })
  it('yields nothing for md alone', () => {
    expect(subagentsFromListing([{ name: 'a.md', mtimeMs: 1 }])).toEqual([])
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
