import { describe, expect, it } from 'vitest'
import type { DecisionCard, PollCard, QuestionCard, RoomCard, RoomMessage } from '@evaos/contract'
import { catchUp, catchUpParts, sinceIndex, whereWeAre } from './decision-view'

const msg = (id: string, author: string, text = '', card?: RoomCard): RoomMessage => ({
  id,
  author,
  text,
  ts: 0,
  reactions: [],
  kind: 'message',
  mentions: [],
  ...(card ? { card } : {}),
})

const agents = [
  { id: 'astra', name: 'Astra' },
  { id: 'polaris', name: 'Polaris Vale' },
  { id: 'nova', name: 'Nova' },
].map((a) => ({
  ...a,
  title: '',
  role: '',
  brief: '',
  model: 'm',
  tools: 'full' as const,
  color: 'blue',
}))

const poll = (votes: Record<string, string>, extra: Partial<PollCard> = {}): PollCard => ({
  type: 'poll',
  id: 'm3',
  by: 'nova',
  question: 'Which store?',
  options: [
    { id: 'o1', label: 'SQLite now' },
    { id: 'o2', label: 'Postgres now' },
  ],
  votes,
  state: 'open',
  ...extra,
})
const ask = (answered?: string): QuestionCard => ({
  type: 'question',
  id: 'm5',
  by: 'polaris',
  text: 'Second host?',
  answers: ['Yes', 'No'],
  ...(answered ? { answered } : {}),
})
const record = (state: DecisionCard['state']): DecisionCard => ({
  type: 'decision',
  id: 'm6',
  by: 'nova',
  title: 'SQLite now',
  why: '',
  agree: ['nova'],
  dissent: [],
  alternatives: [],
  state,
})

const room = (messages: RoomMessage[]) => ({
  messages,
  agents,
  prompt: 'SQLite or Postgres?',
  title: 'Store',
})

describe('whereWeAre', () => {
  it('is nothing until a decision card shows up', () => {
    expect(whereWeAre(room([msg('m1', 'isaac', 'hi'), msg('m2', 'astra', 'hey')]))).toBeNull()
  })

  it('reads the poll: voting, leaning with its count, split', () => {
    expect(whereWeAre(room([msg('m3', 'nova', '', poll({}))]))).toEqual({
      question: 'Which store?',
      lean: { kind: 'voting' },
      you: null,
    })
    expect(
      whereWeAre(room([msg('m3', 'nova', '', poll({ astra: 'o2', nova: 'o1', polaris: 'o1' }))]))!
        .lean,
    ).toEqual({ kind: 'leaning', text: 'SQLite now', count: '2 of 3' })
    expect(
      whereWeAre(room([msg('m3', 'nova', '', poll({ astra: 'o2', nova: 'o1' }))]))!.lean,
    ).toEqual({
      kind: 'split',
    })
  })

  it('puts an open question first, then a proposed call, as what waits on Isaac', () => {
    const msgs = [
      msg('m3', 'nova', '', poll({ nova: 'o1' })),
      msg('m5', 'polaris', '', ask()),
      msg('m6', 'nova', '', record('proposed')),
    ]
    expect(whereWeAre(room(msgs))).toEqual({
      question: 'Which store?',
      lean: { kind: 'decided', text: 'SQLite now' },
      you: { kind: 'question', count: 1, target: 'm5' },
    })
    msgs[1] = msg('m5', 'polaris', '', ask('No'))
    expect(whereWeAre(room(msgs))!.you).toEqual({ kind: 'decision', target: 'm6' })
    msgs[2] = msg('m6', 'nova', '', record('accepted'))
    expect(whereWeAre(room(msgs))!.you).toBeNull()
    // A reopened call falls back to the poll; a question alone falls back to the room's question.
    msgs[2] = msg('m6', 'nova', '', record('reopened'))
    expect(whereWeAre(room(msgs))!.lean).toEqual({
      kind: 'leaning',
      text: 'SQLite now',
      count: '1 of 1',
    })
    expect(whereWeAre(room([msg('m5', 'polaris', '', ask())]))!.question).toBe(
      'SQLite or Postgres?',
    )
  })
})

describe('catchUp', () => {
  const thread = [
    msg('m1', 'isaac', 'SQLite or Postgres?'),
    msg('m2', 'astra', 'Postgres.'),
    msg('m3', 'nova', 'Voting.', poll({})),
    msg('m4', 'system', 'Isaac voted SQLite now'),
    msg('m5', 'polaris', '', ask()),
    msg('m6', 'nova', 'Calling it.', record('proposed')),
    msg('m7', 'polaris', 'Agreed.'),
  ]

  it('counts what members said since, folds plain messages into one line, one per card', () => {
    const c = catchUp(room(thread), 1)
    expect([c.fresh, c.decisions, c.questions]).toEqual([5, 1, 1])
    expect(c.items).toEqual([
      { icon: 'list', text: '2 messages from Astra, Polaris', target: 'm2', you: false },
      { icon: 'poll', text: 'Vote opened: Which store?', target: 'm3', you: false },
      { icon: 'you', text: 'Polaris asks you: Second host?', target: 'm5', you: true },
      { icon: 'gavel', text: 'Decided: SQLite now. Accept or override', target: 'm6', you: true },
    ])
    expect(catchUpParts(c)).toEqual({ plain: '5 new · 1 decision', you: '1 question for you' })
  })

  it('counts only from where Isaac stopped; his own lines and the room notes are not news', () => {
    const c = catchUp(room(thread), 6)
    expect([c.fresh, c.decisions, c.questions]).toEqual([1, 0, 0])
    expect(catchUpParts(c)).toEqual({ plain: '1 new', you: null })
    expect(catchUp(room(thread), 7).fresh).toBe(0)
  })
})

describe('sinceIndex', () => {
  const thread = [
    msg('m1', 'isaac', 'hi'),
    msg('m2', 'astra', 'hey'),
    msg('m3', 'isaac', 'more'),
    msg('m4', 'system', 'Isaac voted A'),
    msg('m5', 'nova', 'ok'),
  ]

  it('marks the first message after the last one seen when members spoke since', () => {
    expect(sinceIndex(thread, 'm2')).toBe(2)
    expect(sinceIndex(thread, 'm1')).toBe(1)
  })

  it('is nothing when he saw it all, only he spoke since, or never visited', () => {
    expect(sinceIndex(thread, 'm5')).toBeNull()
    expect(sinceIndex(thread.slice(0, 4), 'm2')).toBeNull()
    expect(sinceIndex(thread, undefined)).toBeNull()
    expect(sinceIndex(thread, 'gone')).toBeNull()
  })
})
