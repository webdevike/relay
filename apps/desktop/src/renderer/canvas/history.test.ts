import { describe, expect, it } from 'vitest'
import { HISTORY_LIMIT, emptyHistory, record, redo, undo, type Snapshot } from './history'

const snap = (n: number): Snapshot<number> => ({ key: String(n), value: n })

describe('canvas history', () => {
  it('undoes and redoes one step at a time', () => {
    let h = emptyHistory<number>()
    h = record(h, snap(1)) // before the action that made 2
    h = record(h, snap(2)) // before the action that made 3
    const u1 = undo(h, snap(3))!
    expect(u1.state).toBe(2)
    const u2 = undo(u1.history, snap(2))!
    expect(u2.state).toBe(1)
    expect(undo(u2.history, snap(1))).toBeNull()
    const r1 = redo(u2.history, snap(1))!
    expect(r1.state).toBe(2)
    const r2 = redo(r1.history, snap(2))!
    expect(r2.state).toBe(3)
    expect(redo(r2.history, snap(3))).toBeNull()
  })

  it('a new action clears redo and skips a step equal to the last', () => {
    let h = record(emptyHistory<number>(), snap(1))
    const u = undo(h, snap(2))!
    h = record(u.history, snap(1))
    expect(h.future).toEqual([])
    expect(h.past).toHaveLength(1)
    expect(record(h, snap(1)).past).toHaveLength(1)
  })

  it('keeps at most the limit', () => {
    let h = emptyHistory<number>()
    for (let i = 0; i < HISTORY_LIMIT + 20; i++) h = record(h, snap(i))
    expect(h.past).toHaveLength(HISTORY_LIMIT)
    expect(h.past[0]!.value).toBe(20)
  })
})
