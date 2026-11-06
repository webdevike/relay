import { describe, expect, it } from 'vitest'
import { makeMessage, type ChatMessage } from '@evaos/chat-core/message'
import { placeRows } from './computer-rows'

const msg = (id: string, role: ChatMessage['role'], at?: number): ChatMessage =>
  makeMessage(id, role, id, at === undefined ? {} : { at })

describe('placeRows', () => {
  it('puts a run where Isaac sent it: later messages come below it, earlier ones above', () => {
    const session = [
      msg('q1', 'user', 100),
      msg('a1', 'assistant', 110),
      msg('t1', 'tool'),
      msg('q2', 'user', 300),
      msg('a2', 'assistant', 310),
    ]
    const run = [msg('cmd', 'user', 200), msg('done', 'assistant', 200)]
    expect(placeRows(session, run).map((m) => m.id)).toEqual([
      'q1',
      'a1',
      't1',
      'cmd',
      'done',
      'q2',
      'a2',
    ])
  })

  it('keeps a run that is newer than every message at the end, and two runs in their own places', () => {
    const session = [msg('q1', 'user', 100), msg('q2', 'user', 300)]
    const rows = [msg('r1', 'user', 50), msg('r2', 'user', 200), msg('r3', 'user', 400)]
    expect(placeRows(session, rows).map((m) => m.id)).toEqual(['r1', 'q1', 'r2', 'q2', 'r3'])
  })

  it('an unstamped reply still streaming stays after the run that came before it', () => {
    const session = [msg('q1', 'user', 100), msg('stream', 'assistant')]
    const rows = [msg('cmd', 'user', 200)]
    expect(placeRows(session, rows).map((m) => m.id)).toEqual(['q1', 'stream', 'cmd'])
  })
})
