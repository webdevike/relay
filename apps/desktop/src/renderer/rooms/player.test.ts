import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BEATS, REPLIES_TO_ISAAC, SCRIPT, compileBeats, type Beat } from './fixture'
import { createPlayer } from './player'
import { ROSTER } from './roster'
import { createRoom, resetRoomsForTests, roomsStore } from './rooms-store'

const beats: Beat[] = [
  { key: 'a', author: 'pm', lead: 500, typing: 1000, text: 'one' },
  {
    key: 'b',
    author: 'ops',
    lead: -400,
    typing: 1200,
    text: 'two',
    reactions: [{ emoji: '👍', by: 'pm', after: 300 }],
  },
  { key: 'c', author: 'pm', lead: 200, typing: 800, text: 'done', summary: true },
]

const roomOf = (id: string) => roomsStore.getState().rooms[id]!

describe('compileBeats', () => {
  it('orders typing before each post, overlaps negative leads and keeps reactions after', () => {
    const steps = compileBeats(beats)
    expect(steps.map((s) => [s.at, s.op.type, 'agent' in s.op ? s.op.agent : s.op.key])).toEqual([
      [500, 'typing', 'pm'],
      [1100, 'typing', 'ops'],
      [1500, 'message', 'a'],
      [2300, 'message', 'b'],
      [2500, 'typing', 'pm'],
      [2600, 'reaction', 'b'],
      [3300, 'resolve', 'c'],
    ])
    expect(compileBeats(beats, 100)[0]!.at).toBe(600)
  })

  it('the shipped script has about 25 messages, ends in one resolve and only uses the roster', () => {
    const ids = new Set(ROSTER.map((a) => a.id))
    expect(BEATS.length).toBe(25)
    expect(BEATS.filter((b) => b.summary)).toHaveLength(1)
    expect(SCRIPT[SCRIPT.length - 1]!.op.type).not.toBe('typing')
    expect(SCRIPT.filter((s) => s.op.type === 'resolve')).toHaveLength(1)
    for (const b of [...BEATS, ...REPLIES_TO_ISAAC.flat()]) {
      expect(ids.has(b.author)).toBe(true)
      for (const r of b.reactions ?? []) expect(ids.has(r.by)).toBe(true)
    }
    for (let i = 1; i < SCRIPT.length; i++)
      expect(SCRIPT[i]!.at).toBeGreaterThanOrEqual(SCRIPT[i - 1]!.at)
  })
})

describe('createPlayer', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    resetRoomsForTests()
  })
  afterEach(() => vi.useRealTimers())

  it('replays steps in order on timers and resolves the room', () => {
    const room = createRoom('q', ROSTER.slice())
    const player = createPlayer(room.id, compileBeats(beats), [])
    player.start()
    expect(roomOf(room.id).typing).toEqual([])
    vi.advanceTimersByTime(500)
    expect(roomOf(room.id).typing).toEqual(['pm'])
    vi.advanceTimersByTime(600)
    expect(roomOf(room.id).typing).toEqual(['pm', 'ops'])
    vi.advanceTimersByTime(400)
    expect(roomOf(room.id).typing).toEqual(['ops'])
    expect(roomOf(room.id).messages.map((m) => m.text)).toEqual(['one'])
    vi.advanceTimersByTime(1100)
    expect(roomOf(room.id).messages.map((m) => m.text)).toEqual(['one', 'two'])
    expect(roomOf(room.id).messages[1]!.reactions).toEqual([{ emoji: '👍', by: ['pm'] }])
    vi.advanceTimersByTime(700)
    const done = roomOf(room.id)
    expect(done.status).toBe('resolved')
    expect(done.messages.map((m) => m.kind)).toEqual(['message', 'message', 'summary'])
    expect(done.typing).toEqual([])
  })

  it('stop cancels pending steps', () => {
    const room = createRoom('q', ROSTER.slice())
    const player = createPlayer(room.id, compileBeats(beats), [])
    player.start()
    vi.advanceTimersByTime(1500)
    player.stop()
    vi.advanceTimersByTime(10_000)
    expect(roomOf(room.id).messages).toHaveLength(1)
    expect(roomOf(room.id).status).toBe('live')
  })

  it('an Isaac post injects a reply before the script continues, keeping the spacing', () => {
    const room = createRoom('q', ROSTER.slice())
    const reply: Beat[] = [{ key: 'r', author: 'ops', lead: 100, typing: 400, text: 'hi isaac' }]
    const player = createPlayer(room.id, compileBeats(beats), [reply])
    player.start()
    vi.advanceTimersByTime(1500)
    expect(roomOf(room.id).messages.map((m) => m.text)).toEqual(['one'])
    player.isaacPosts('wait')
    expect(roomOf(room.id).messages.map((m) => m.text)).toEqual(['one', 'wait'])
    expect(roomOf(room.id).messages[1]).toMatchObject({ author: 'isaac', kind: 'message' })
    vi.advanceTimersByTime(500)
    expect(roomOf(room.id).messages.map((m) => m.text)).toEqual(['one', 'wait', 'hi isaac'])
    // "two" was due 800 ms after the post; the 500 ms reply plus the 600 ms gap pushed it to 1900.
    vi.advanceTimersByTime(1399)
    expect(roomOf(room.id).messages.map((m) => m.text)).toEqual(['one', 'wait', 'hi isaac'])
    vi.advanceTimersByTime(1)
    expect(roomOf(room.id).messages.map((m) => m.text)).toEqual(['one', 'wait', 'hi isaac', 'two'])
    vi.advanceTimersByTime(5000)
    expect(roomOf(room.id).status).toBe('resolved')
  })
})
