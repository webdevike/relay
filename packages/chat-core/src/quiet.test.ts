import { describe, expect, it } from 'vitest'
import { dropQuietTurns } from './quiet'
import { makeMessage, type ChatMessage } from './message'

const ids = (list: ChatMessage[]) => dropQuietTurns(list).map((m) => m.id)

describe('dropQuietTurns', () => {
  it('drops a turn whose only reply is (nothing to report), prompt, thinking and tools included', () => {
    expect(
      ids([
        makeMessage('u1', 'user', 'hi'),
        makeMessage('a1', 'assistant', 'Hello.'),
        makeMessage('u2', 'user', "[From Astra's background jobs] Heartbeat"),
        makeMessage('t2', 'thinking', 'nothing new'),
        makeMessage('x2', 'tool', 'read'),
        makeMessage('a2', 'assistant', ' (nothing to report)\n'),
        makeMessage('u3', 'user', 'next'),
      ]),
    ).toEqual(['u1', 'a1', 'u3'])
  })

  it('keeps a turn with a real reply, and a turn still waiting for one', () => {
    const list = [
      makeMessage('u1', 'user', '[background]'),
      makeMessage('a1', 'assistant', '(nothing to report)'),
      makeMessage('a2', 'assistant', 'ENG-6409 needs your review.'),
      makeMessage('u2', 'user', 'pending'),
    ]
    expect(ids(list)).toEqual(['u1', 'a1', 'a2', 'u2'])
  })

  it('keeps a turn another assistant popped into, without the silent reply', () => {
    const penny = { id: 'penny', title: 'Penny' }
    const list = [
      makeMessage('u1', 'user', '@Penny what does a 2TB USB4 SSD cost?'),
      makeMessage('x1', 'tool', 'relay-linux assistant consult'),
      makeMessage('g1', 'guest', 'Penny joined the chat', {
        guest: { kind: 'join', agent: penny },
      }),
      makeMessage('g2', 'guest', 'Penny: $189', {
        guest: { kind: 'say', agent: penny, text: '$189' },
      }),
      makeMessage('a1', 'assistant', '(nothing to report)'),
    ]
    expect(ids(list)).toEqual(['u1', 'x1', 'g1', 'g2'])
  })
})
