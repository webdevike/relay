import { describe, expect, it } from 'vitest'
import type { OpenAsk } from '@evaos/contract'
import type { Turn, TurnRow } from '@evaos/chat-core/turns'
import { askRow, openAsks, waitingRows, waitingTurns } from './open-asks'

const ask = (id: string, over: Partial<OpenAsk> = {}): OpenAsk => ({
  id,
  source: 'replies',
  label: id,
  question: `Question ${id}?`,
  replies: ['Yes', 'No'],
  at: 100,
  ...over,
})
const row = (index: number, id: string, role: TurnRow['role'], at: number): TurnRow => ({
  index,
  id,
  role,
  text: '',
  at,
  ref: {},
})
const turn = (key: string, item: number): Turn => ({
  key,
  row: key,
  item,
  led: 'user',
  title: key,
  reply: '',
  flag: null,
})

// Two turns: u1 a1 | u2 a2 (a2 is the assistant bubble sent at 300).
const rows = [
  row(0, 'u1', 'user', 100),
  row(1, 'a1', 'assistant', 200),
  row(2, 'u2', 'user', 250),
  row(3, 'a2', 'assistant', 300),
]
const turns = [turn('t1', 0), turn('t2', 2)]

describe('open asks', () => {
  it('lists the asks Isaac has not closed here, oldest first', () => {
    const asks = [
      ask('00000002', { at: 20 }),
      ask('00000001', { at: 10 }),
      ask('00000003', { at: 30 }),
    ]
    expect(openAsks(asks, new Set(['00000003'])).map((a) => a.id)).toEqual(['00000001', '00000002'])
    expect(openAsks(null, new Set())).toEqual([])
  })

  it('finds the bubble an ask names, else the assistant bubble sent at its time (a re-keyed reply), never for a session ask', () => {
    expect(askRow(rows, ask('00000001', { messageId: 'a1' }))?.id).toBe('a1')
    expect(askRow(rows, ask('00000001', { messageId: 'gone', at: 300 }))?.id).toBe('a2')
    expect(askRow(rows, ask('00000001', { at: 250 }))).toBeNull()
    expect(askRow(rows, ask('00000001', { source: 'session', at: 300 }))).toBeNull()
  })

  it('keeps the oldest ask per bubble', () => {
    const first = ask('00000001', { messageId: 'a2' })
    const second = ask('00000002', { messageId: 'a2' })
    expect(waitingRows(rows, [first, second]).get('a2')).toBe(first)
  })

  it('puts each ask in the turn of its bubble, else the turn running when it was asked, else the newest', () => {
    const byBubble = ask('00000001', { messageId: 'a1' })
    const byTime = ask('00000002', { source: 'session', at: 260 })
    const early = ask('00000003', { source: 'ask', at: 1 })
    const out = waitingTurns(turns, rows, [byBubble, byTime, early])
    expect(out.get('t1')).toEqual([byBubble])
    expect(out.get('t2')).toEqual([byTime, early])
  })
})
