import { beforeEach, describe, expect, it } from 'vitest'
import { ROSTER } from './roster'
import {
  createRoom,
  groupMessages,
  post,
  resetRoomsForTests,
  resolve,
  roomsStore,
  setActive,
  setTyping,
  toggleReaction,
  toggleReactionIn,
} from './rooms-store'
import type { RoomMessage } from './types'

const msg = (id: string, author: string, ts: number, kind: RoomMessage['kind'] = 'message') => ({
  id,
  author,
  text: id,
  ts,
  reactions: [],
  kind,
})

describe('toggleReactionIn', () => {
  it('adds, joins, leaves and drops an emptied reaction', () => {
    const a = toggleReactionIn([], '👍', 'builder')
    expect(a).toEqual([{ emoji: '👍', by: ['builder'] }])
    const b = toggleReactionIn(a, '👍', 'isaac')
    expect(b).toEqual([{ emoji: '👍', by: ['builder', 'isaac'] }])
    const c = toggleReactionIn(b, '🔥', 'isaac')
    expect(c.map((r) => r.emoji)).toEqual(['👍', '🔥'])
    const d = toggleReactionIn(c, '👍', 'isaac')
    expect(d[0]).toEqual({ emoji: '👍', by: ['builder'] })
    const e = toggleReactionIn(d, '🔥', 'isaac')
    expect(e).toEqual([{ emoji: '👍', by: ['builder'] }])
    expect(a).toEqual([{ emoji: '👍', by: ['builder'] }])
  })
})

describe('groupMessages', () => {
  it('collapses consecutive same-author messages within 120 s', () => {
    const groups = groupMessages([
      msg('1', 'pm', 0),
      msg('2', 'pm', 60_000),
      msg('3', 'pm', 180_001),
      msg('4', 'ops', 180_002),
      msg('5', 'pm', 180_003),
    ])
    expect(groups.map((g) => [g.author, g.messages.map((m) => m.id)])).toEqual([
      ['pm', ['1', '2']],
      ['pm', ['3']],
      ['ops', ['4']],
      ['pm', ['5']],
    ])
  })

  it('never groups a summary', () => {
    const groups = groupMessages([
      msg('1', 'pm', 0),
      msg('2', 'pm', 1000, 'summary'),
      msg('3', 'pm', 2000),
    ])
    expect(groups.map((g) => g.messages.map((m) => m.id))).toEqual([['1'], ['2'], ['3']])
  })
})

describe('rooms store', () => {
  beforeEach(() => resetRoomsForTests())

  it('creates, posts, types, reacts and resolves', () => {
    const room = createRoom('Should we?\nmore', ROSTER.slice(0, 2), 1000)
    expect(room.title).toBe('Should we?')
    expect(roomsStore.getState().activeRoomId).toBe(room.id)
    expect(roomsStore.getState().order).toEqual([room.id])

    setTyping(room.id, 'pm', true)
    setTyping(room.id, 'ops', true)
    setTyping(room.id, 'pm', true)
    expect(roomsStore.getState().rooms[room.id]!.typing).toEqual(['pm', 'ops'])

    post(room.id, msg('m1', 'pm', 2000))
    const after = roomsStore.getState().rooms[room.id]!
    expect(after.typing).toEqual(['ops'])
    expect(after.messages.map((m) => m.id)).toEqual(['m1'])

    toggleReaction(room.id, 'm1', '👍', 'isaac')
    expect(roomsStore.getState().rooms[room.id]!.messages[0]!.reactions).toEqual([
      { emoji: '👍', by: ['isaac'] },
    ])
    toggleReaction(room.id, 'nope', '👍', 'isaac')

    resolve(room.id, msg('s', 'pm', 3000))
    const done = roomsStore.getState().rooms[room.id]!
    expect(done.status).toBe('resolved')
    expect(done.resolvedAt).toBe(3000)
    expect(done.typing).toEqual([])
    expect(done.messages[1]).toMatchObject({ id: 's', kind: 'summary' })

    setActive(null)
    expect(roomsStore.getState().activeRoomId).toBeNull()
  })

  it('lists the newest room first', () => {
    const a = createRoom('a', ROSTER.slice())
    const b = createRoom('b', ROSTER.slice())
    expect(roomsStore.getState().order).toEqual([b.id, a.id])
  })
})
