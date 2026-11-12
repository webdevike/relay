import { describe, expect, it } from 'vitest'
import {
  NAV_HISTORY_CAP,
  emptyHistory,
  moveTo,
  placeOf,
  visit,
  type NavHistory,
  type Spot,
} from './index'

const spot = (over: Partial<Spot> = {}): Spot => ({
  ws: 'chat:a',
  tab: 1,
  place: placeOf('chat', { chat: 'a.jsonl' }),
  front: null,
  scroll: null,
  ...over,
})

const at = (n: number): Spot => spot({ place: placeOf('chat', { chat: `${n}.jsonl` }) })

describe('visit', () => {
  it('pushes a new spot and points at it', () => {
    const h = visit(visit(emptyHistory(), at(1)), at(2))
    expect(h.entries).toHaveLength(2)
    expect(h.index).toBe(1)
  })

  it('refreshes the current entry for the same place instead of repeating it', () => {
    const h = visit(visit(emptyHistory(), at(1)), {
      ...at(1),
      scroll: { offset: 40, pinned: false },
    })
    expect(h.entries).toHaveLength(1)
    expect(h.entries[0]?.scroll).toEqual({ offset: 40, pinned: false })
  })

  it('tells the same place in another tab, or with another tool tab in front, apart', () => {
    let h: NavHistory = visit(emptyHistory(), at(1))
    h = visit(h, { ...at(1), tab: 2 })
    h = visit(h, { ...at(1), tab: 2, front: 'web:9' })
    expect(h.entries).toHaveLength(3)
  })

  it('drops the forward entries when Isaac goes somewhere new after stepping back', () => {
    let h: NavHistory = emptyHistory()
    for (const n of [1, 2, 3]) h = visit(h, at(n))
    h = moveTo(moveTo(h, 1), 0)
    h = visit(h, at(9))
    expect(h.entries.map((s) => s.place.chat)).toEqual(['1.jsonl', '9.jsonl'])
    expect(h.index).toBe(1)
  })

  it('keeps the newest NAV_HISTORY_CAP entries', () => {
    let h: NavHistory = emptyHistory()
    for (let n = 0; n < NAV_HISTORY_CAP + 25; n++) h = visit(h, at(n))
    expect(h.entries).toHaveLength(NAV_HISTORY_CAP)
    expect(h.entries[0]?.place.chat).toBe('25.jsonl')
    expect(h.index).toBe(NAV_HISTORY_CAP - 1)
  })
})

describe('moveTo', () => {
  it('leaves the history untouched for an index out of range or the current one', () => {
    const h = visit(visit(emptyHistory(), at(1)), at(2))
    expect(moveTo(h, 5)).toBe(h)
    expect(moveTo(h, -1)).toBe(h)
    expect(moveTo(h, 1)).toBe(h)
    expect(moveTo(h, 0).index).toBe(0)
  })
})
