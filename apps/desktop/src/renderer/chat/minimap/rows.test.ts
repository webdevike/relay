import { describe, expect, it } from 'vitest'
import { makeMessage } from '@evaos/chat-core/message'
import { buildTurns } from '@evaos/chat-core/turns'
import type { LogItem } from '../ChatLog'
import { turnRows } from './rows'

const T0 = 1_800_000_000_000
const msg = (m: ReturnType<typeof makeMessage>): LogItem => ({ kind: 'message', m })
const tool = (id: string, result: string | null) =>
  makeMessage(id, 'tool', 'ask', {
    tool: {
      call: id,
      input: '',
      result,
      isError: false,
      status: result === null ? 'running' : 'done',
    },
  })

describe('turnRows', () => {
  it('reads user and assistant rows with their position, timestamp and picture flag', () => {
    const rows = [
      ...turnRows([
        msg(makeMessage('u1', 'user', 'look', { at: T0, images: [{ label: 'a' }] })),
        msg(makeMessage('a1', 'assistant', 'seen', { at: T0 + 1, streaming: true })),
      ]),
    ]
    expect(rows.map((r) => [r.index, r.id, r.role, r.at, r.images, r.streaming])).toEqual([
      [0, 'u1', 'user', T0, true, false],
      [1, 'a1', 'assistant', T0 + 1, false, true],
    ])
  })

  it('opens tool groups: only an unanswered ask counts, at its group position', () => {
    const rows = [
      ...turnRows([
        msg(makeMessage('u1', 'user', 'go', { at: T0 })),
        { kind: 'tools', tools: [makeMessage('t0', 'tool', 'read'), tool('t1', null)] },
        { kind: 'tools', tools: [tool('t2', 'A')] },
      ]),
    ]
    expect(rows.map((r) => [r.index, r.role])).toEqual([
      [0, 'user'],
      [1, 'ask'],
    ])
  })

  it('leaves out notices, thinking and typing dots', () => {
    const rows = [
      ...turnRows([
        msg(makeMessage('n', 'notice', 'Error: x')),
        msg(makeMessage('t', 'thinking', 'hmm')),
        { kind: 'typing', who: 'Nova' },
      ]),
    ]
    expect(rows).toEqual([])
  })

  it('builds a flagged turn from an open ask card', () => {
    const turns = buildTurns(
      turnRows([
        msg(makeMessage('u1', 'user', 'x', { at: T0 })),
        { kind: 'tools', tools: [tool('t1', null)] },
      ]),
      undefined,
    )
    expect(turns).toHaveLength(1)
    expect(turns[0]!.flag).toBe('ask')
  })
})
