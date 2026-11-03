import { describe, expect, it } from 'vitest'
import type { AstraTurn } from '@evaos/contract'
import {
  astraThreads,
  mergeTimeline,
  showsTyping,
  threadReplyText,
  threadSnippet,
  type AstraBlock,
  type AstraThread,
  type TimelineEntry,
} from './astra-timeline'

const turn = (id: string, role: AstraTurn['role'], at?: number, text = id): AstraTurn => ({
  id,
  role,
  text,
  streaming: false,
  ...(at === undefined ? {} : { at }),
})

const shape = (threads: AstraThread[]) =>
  threads.map((t) => [
    t.root.id,
    t.replies.map((b) =>
      b.kind === 'ask' ? `ask:${b.turn.text}` : `reply:${b.turns.map((x) => x.id).join('+')}`,
    ),
  ])

describe('astra threads', () => {
  it('makes each composer ask a root and her answers and tools one reply under it', () => {
    const threads = astraThreads([
      turn('u1', 'user', 10, '@Astra is this safe?'),
      turn('x1', 'tool', 10),
      turn('a1', 'assistant', 12),
      turn('a2', 'assistant', 13),
      turn('u2', 'user', 20, '@Astra and the tests?'),
      turn('a3', 'assistant'),
    ])
    expect(shape(threads)).toEqual([
      ['u1', ['reply:x1+a1+a2']],
      ['u2', ['reply:a3']],
    ])
    expect(threads.map((t) => t.at)).toEqual([10, 20])
  })

  it('puts a reply typed in a thread under that thread, even an older one, without its naming line', () => {
    const first = '@Astra is   this "safe"?'
    const threads = astraThreads([
      turn('u1', 'user', 10, first),
      turn('a1', 'assistant', 11),
      turn('u2', 'user', 20, '@Astra second question'),
      turn('a2', 'assistant', 21),
      turn('u3', 'user', 30, threadReplyText(first, 'what about nulls?')),
      turn('a3', 'assistant', 31),
    ])
    expect(threadSnippet(first)).toBe("@Astra is this 'safe'?")
    expect(shape(threads)).toEqual([
      ['u1', ['reply:a1', 'ask:what about nulls?', 'reply:a3']],
      ['u2', ['reply:a2']],
    ])
  })

  it('reads a reply past a client surface tag', () => {
    const tagged = `<surface>iPhone - Relay</surface>\n${threadReplyText('u1', 'more')}`
    expect(shape(astraThreads([turn('u1', 'user', 1), turn('u2', 'user', 2, tagged)]))).toEqual([
      ['u1', ['ask:more']],
    ])
  })

  it('gives the newest ask a pending reply slot of hers', () => {
    const one = astraThreads([turn('u1', 'user', 10)], true)
    expect(one[0]!.replies).toEqual([{ kind: 'reply', id: 'u1-pending', at: 10, turns: [] }])
    const reply = astraThreads(
      [
        turn('u1', 'user', 10),
        turn('a1', 'assistant', 11),
        turn('u2', 'user', 12, threadReplyText('u1', 'more')),
      ],
      true,
    )
    expect(shape(reply)).toEqual([['u1', ['reply:a1', 'ask:more', 'reply:']]])
    expect(
      astraThreads([turn('u1', 'user', 10), turn('a1', 'assistant', 11)], true)[0]!.replies,
    ).toHaveLength(1)
    expect(astraThreads([], true)).toEqual([])
  })

  it('shows typing until her answer streams text, and between tools', () => {
    const empty: AstraBlock = { kind: 'reply', id: 'p', turns: [] }
    expect(showsTyping(empty, true)).toBe(true)
    expect(showsTyping(empty, false)).toBe(false)
    const streaming = { ...turn('a', 'assistant'), text: 'Hel', streaming: true }
    expect(showsTyping({ kind: 'reply', id: 'r', turns: [streaming] }, true)).toBe(false)
    expect(
      showsTyping({ kind: 'reply', id: 'r', turns: [streaming, turn('t', 'tool')] }, true),
    ).toBe(true)
  })

  it('interleaves comments and threads by root time, comments first on a tie, untimed last', () => {
    const comments = [
      { id: 'c1', at: 5 },
      { id: 'c2', at: 10 },
      { id: 'c3', at: 30 },
    ]
    const threads = astraThreads([
      turn('u1', 'user', 10),
      turn('a1', 'assistant', 15),
      turn('u2', 'user'),
      turn('a2', 'assistant'),
    ])
    const ids = (rows: Array<TimelineEntry<{ id: string; at: number }>>) =>
      rows.map((r) => (r.kind === 'comment' ? r.item.id : r.thread.id))
    expect(ids(mergeTimeline(comments, (c) => c.at, threads))).toEqual([
      'c1',
      'c2',
      'u1',
      'c3',
      'u2',
    ])
  })
})
