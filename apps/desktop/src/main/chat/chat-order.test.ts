import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createConfigStore } from '../config-store'
import {
  archiveDue,
  ChatOrder,
  DAY_MS,
  isRead,
  nextReturn,
  ORDER_FILE,
  runStart,
  wake,
  type Look,
} from './chat-order'

const at = (secs: number): number => 1_000_000_000 + secs * 1000

describe('return time (ported from order.rs)', () => {
  it('the first look records a baseline without reshuffling', () => {
    // A chat already saved keeps its time, even while it writes.
    expect(nextReturn(at(10), null, 'working', at(50), at(60))).toBe(at(10))
    // A new chat's baseline is its file's time.
    expect(nextReturn(null, null, 'working', at(50), at(60))).toBe(at(50))
    expect(nextReturn(null, null, 'idle', at(50), at(60))).toBe(at(50))
    expect(nextReturn(null, null, null, at(50), at(60))).toBe(at(50))
  })

  it('finishing or blocking is a return and replying is not', () => {
    const stored = at(10)
    expect(nextReturn(stored, 'working', 'idle', at(55), at(60))).toBe(at(60))
    expect(nextReturn(stored, 'working', 'blocked', at(55), at(60))).toBe(at(60))
    expect(nextReturn(stored, 'idle', 'blocked', at(55), at(60))).toBe(at(60))
    expect(nextReturn(stored, 'blocked', 'ended', at(55), at(60))).toBe(at(60))
    expect(nextReturn(stored, 'working', 'working', at(55), at(60))).toBe(at(10))
    expect(nextReturn(stored, 'idle', 'working', at(55), at(60))).toBe(at(10))
    expect(nextReturn(stored, 'blocked', 'working', at(55), at(60))).toBe(at(10))
    expect(nextReturn(stored, 'blocked', 'idle', at(55), at(60))).toBe(at(10))
    expect(nextReturn(stored, 'idle', 'idle', at(55), at(60))).toBe(at(10))
  })

  it('a chat written while unobserved comes back at its file time', () => {
    expect(nextReturn(at(10), null, null, at(40), at(60))).toBe(at(40))
    expect(nextReturn(at(10), 'idle', null, at(40), at(60))).toBe(at(40))
    expect(nextReturn(at(50), null, null, at(40), at(60))).toBe(at(50))
    expect(nextReturn(at(10), null, 'idle', at(40), at(60))).toBe(at(40))
    expect(nextReturn(at(10), null, 'blocked', at(40), at(60))).toBe(at(40))
  })

  it('a run starts when it starts working and ends when it stops', () => {
    expect(runStart(null, 'idle', 'working', null, at(5))).toBe(at(5))
    expect(runStart(at(5), 'working', 'working', null, at(9))).toBe(at(5))
    // Already working at the first look: from Isaac's last message.
    expect(runStart(null, null, 'working', at(2), at(9))).toBe(at(2))
    for (const now of ['blocked', 'idle', 'ended', null] as const) {
      expect(runStart(at(5), 'working', now, null, at(9))).toBeNull()
    }
    // Back to work after an approval: a new run.
    expect(runStart(null, 'blocked', 'working', at(1), at(9))).toBe(at(9))
  })

  it('read means opened since the last return', () => {
    expect(isRead(null, at(10))).toBe(false)
    expect(isRead(at(5), at(10))).toBe(false)
    expect(isRead(at(10), at(10))).toBe(true)
    expect(isRead(at(20), at(10))).toBe(true)
  })

  it('idle chats settle after the auto-settle days', () => {
    const three = 3 * DAY_MS
    const now = at(10 * 24 * 3600)
    const old = now - 4 * DAY_MS
    const fresh = now - DAY_MS
    expect(archiveDue(old, false, false, false, now, three)).toBe(true)
    expect(archiveDue(fresh, false, false, false, now, three)).toBe(false)
    expect(archiveDue(old, true, false, false, now, three)).toBe(false)
    expect(archiveDue(old, false, true, false, now, three)).toBe(false)
    expect(archiveDue(old, false, false, true, now, three)).toBe(false)
    expect(archiveDue(old, false, false, false, now, null)).toBe(false)
  })

  it('a snooze wakes early on a return or a need, else on time', () => {
    const snooze = { until: at(100), at: at(10) }
    expect(wake(snooze, at(5), false, at(50))).toBeNull()
    expect(wake(snooze, at(20), false, at(50))).toBe('early')
    expect(wake(snooze, at(5), true, at(50))).toBe('early')
    expect(wake(snooze, at(5), false, at(100))).toBe('timer')
  })
})

describe('ChatOrder', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
  })
  const store = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'evaos-order-'))
    dirs.push(d)
    return createConfigStore(d)
  }
  const look = (o: Partial<Look> & { id: string }): Look => ({
    updated: at(0),
    phase: null,
    owned: false,
    relay: false,
    running: false,
    pinned: false,
    archived: false,
    sent: null,
    ...o,
  })

  it('tracks an owned run: start, return on finishing, and an ended run when the process goes', () => {
    const order = new ChatOrder(store())
    order.track([look({ id: 'a', phase: 'idle', owned: true, running: true })], at(10), null)
    expect(order.returned('a', at(0))).toBe(at(0))
    order.track([look({ id: 'a', phase: 'working', owned: true, running: true })], at(20), null)
    expect(order.started('a')).toBe(at(20))
    expect(order.returned('a', at(0))).toBe(at(0))
    order.track([look({ id: 'a', phase: 'idle', owned: true, running: true })], at(30), null)
    expect(order.started('a')).toBeNull()
    expect(order.returned('a', at(0))).toBe(at(30))
    order.track([look({ id: 'a', phase: 'working', owned: true, running: true })], at(40), null)
    // The process went away mid-run: it ended now.
    order.track([look({ id: 'a' })], at(50), null)
    expect(order.returned('a', at(0))).toBe(at(50))
  })

  it('a Relay run that vanishes ended, but only while Relay stayed connected', () => {
    const order = new ChatOrder(store())
    const relay = (id: string) => look({ id, phase: 'working', relay: true, running: true })
    order.track([relay('a'), relay('b')], at(10), null, false)
    order.track([relay('a'), relay('b')], at(20), null, true)
    // Relay stopped listing `a` while connected; `b` was last seen as Relay dropped.
    order.track([look({ id: 'a' }), relay('b')], at(30), null, true)
    order.track([look({ id: 'a' }), look({ id: 'b' })], at(40), null, false)
    expect([order.returned('a', at(0)), order.returned('b', at(0))]).toEqual([at(30), at(0)])
  })

  it('an owned run first seen working starts now; one found outside counts from the last prompt', () => {
    const order = new ChatOrder(store())
    order.track(
      [
        look({ id: 'mine', phase: 'working', owned: true, running: true, sent: at(1) }),
        look({ id: 'term', phase: 'working', running: true, sent: at(1) }),
      ],
      at(500),
      null,
    )
    expect([order.started('mine'), order.started('term')]).toEqual([at(500), at(1)])
  })

  it('auto-settles idle chats after the days, never a running, pinned or snoozed one', () => {
    const order = new ChatOrder(store())
    const old = at(0)
    const now = old + 4 * DAY_MS
    order.snooze('s', now + DAY_MS, old)
    const due = order.track(
      [
        look({ id: 'idle', updated: old }),
        look({ id: 'run', updated: old, running: true }),
        look({ id: 'pin', updated: old, pinned: true }),
        look({ id: 's', updated: old }),
        look({ id: 'done', updated: old, archived: true }),
      ],
      now,
      3 * DAY_MS,
    )
    expect(due).toEqual(['idle'])
  })

  it('unsettling counts as activity: kept holds off auto-settle for another stretch', () => {
    const order = new ChatOrder(store())
    const old = at(0)
    const now = old + 4 * DAY_MS
    order.keep('k', now - DAY_MS)
    expect(order.kept('k')).toBe(now - DAY_MS)
    expect(order.track([look({ id: 'k', updated: old })], now, 3 * DAY_MS)).toEqual([])
    expect(order.track([look({ id: 'k', updated: old })], now + 3 * DAY_MS, 3 * DAY_MS)).toEqual([
      'k',
    ])
  })

  it('a due snooze wakes with a Woke mark that opening clears', () => {
    const order = new ChatOrder(store())
    order.track([look({ id: 'a' })], at(1), null)
    order.snooze('a', at(100), at(2))
    expect(order.wakes('a')).toBe(at(100))
    order.track([look({ id: 'a' })], at(50), null)
    expect(order.wakes('a')).toBe(at(100))
    order.track([look({ id: 'a' })], at(100), null)
    expect(order.wakes('a')).toBeNull()
    expect(order.woke('a')).toBe(at(100))
    expect(order.markRead('a', at(0), at(120))).toBe(true)
    expect(order.woke('a')).toBeNull()
    expect(order.opened('a')).toBe(at(120))
    // Already read since its return: nothing changes.
    expect(order.markRead('a', at(0), at(130))).toBe(false)
    expect(order.opened('a')).toBe(at(120))
  })

  it('persists native keys in chat-order.json and keeps unknown keys', () => {
    const config = store()
    config.writeJson(ORDER_FILE, { collapsed: ['Relay'] })
    const order = new ChatOrder(config)
    order.track([look({ id: 'a', updated: at(5) })], at(10), null)
    order.markRead('a', at(5), at(11))
    order.keep('a', at(12))
    order.snooze('b', at(100), at(13))
    const doc = config.readJson<Record<string, unknown>>(ORDER_FILE, {})
    expect(doc).toEqual({
      collapsed: ['Relay'],
      returned: { a: at(5) },
      opened: { a: at(11) },
      kept: { a: at(12) },
      snoozed: { b: { until: at(100), at: at(13) } },
      woke: {},
    })
    const again = new ChatOrder(config)
    expect([again.returned('a', 0), again.opened('a'), again.kept('a'), again.wakes('b')]).toEqual([
      at(5),
      at(11),
      at(12),
      at(100),
    ])
    again.forget('a')
    expect(config.readJson<Record<string, unknown>>(ORDER_FILE, {}).returned).toEqual({})
  })
})
