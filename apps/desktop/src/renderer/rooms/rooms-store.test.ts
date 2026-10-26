import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Room as RoomDto } from '@evaos/contract'
import {
  applyRoom,
  applyRooms,
  groupMessages,
  resetRoomsForTests,
  roomsStore,
  setActive,
  startRoom,
  toggleReaction,
  toggleReactionIn,
} from './rooms-store'
import type { RoomMessage } from './types'

const invoke = vi.fn<(channel: string, input: unknown) => Promise<unknown>>()
const on = vi.fn(() => () => undefined)
vi.mock('../ipc', () => ({
  invoke: (channel: string, input: unknown) => invoke(channel, input),
  on: () => on(),
}))

const msg = (id: string, author: string, ts: number, kind: RoomMessage['kind'] = 'message') => ({
  id,
  author,
  text: id,
  ts,
  reactions: [],
  kind,
})

const dto = (id: string, extra: Partial<RoomDto> = {}): RoomDto => ({
  id,
  title: `Room ${id}`,
  prompt: `Room ${id}`,
  agents: [
    {
      id: 'pm',
      name: 'Jonah Reyes',
      title: 'Product Manager',
      role: 'PM',
      brief: 'b',
      model: 'openai-codex/gpt-6.1-terra',
      tools: 'none',
      color: 'violet',
    },
  ],
  messages: [],
  presence: {},
  phase: 'open',
  rounds: 0,
  startedAt: 1000,
  ...extra,
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
      msg('a', 'pm', 0),
      msg('b', 'pm', 60_000),
      msg('c', 'pm', 200_000),
      msg('d', 'ops', 200_500),
      msg('e', 'pm', 201_000),
    ])
    expect(groups.map((g) => [g.author, g.messages.map((m) => m.id)])).toEqual([
      ['pm', ['a', 'b']],
      ['pm', ['c']],
      ['ops', ['d']],
      ['pm', ['e']],
    ])
  })

  it('never groups a summary', () => {
    const groups = groupMessages([
      msg('a', 'pm', 0),
      msg('s', 'pm', 1000, 'summary'),
      msg('b', 'pm', 2000),
    ])
    expect(groups.map((g) => g.messages.map((m) => m.id))).toEqual([['a'], ['s'], ['b']])
  })
})

describe('rooms store', () => {
  beforeEach(() => {
    resetRoomsForTests()
    invoke.mockReset()
  })

  it('mirrors rooms from main with portraits, newest first, and keeps order on updates', () => {
    applyRoom(dto('r1'))
    applyRoom(dto('r2'))
    const s = roomsStore.getState()
    expect(s.order).toEqual(['r2', 'r1'])
    expect(s.rooms.r1!.agents[0]!.avatar.startsWith('data:image/svg+xml')).toBe(true)
    applyRoom(dto('r1', { phase: 'resolved', resolvedAt: 5000, messages: [msg('m1', 'pm', 2000)] }))
    expect(roomsStore.getState().order).toEqual(['r2', 'r1'])
    expect(roomsStore.getState().rooms.r1).toMatchObject({ phase: 'resolved', resolvedAt: 5000 })
    applyRooms([dto('r3'), dto('r1')])
    expect(roomsStore.getState().order).toEqual(['r3', 'r1'])
    expect(roomsStore.getState().rooms.r2).toBeUndefined()
  })

  it('startRoom opens the new room, or keeps the error on the form', async () => {
    invoke.mockResolvedValueOnce({ ok: true, value: { roomId: 'r9' } })
    await startRoom('Should we?', ['pm'])
    expect(invoke).toHaveBeenCalledWith('rooms.create', { prompt: 'Should we?', agentIds: ['pm'] })
    expect(roomsStore.getState().activeRoomId).toBe('r9')
    invoke.mockResolvedValueOnce({ ok: false, error: { code: 'internal', message: 'omp missing' } })
    await startRoom('x', ['pm'])
    expect(roomsStore.getState().createError).toBe('omp missing')
    setActive(null)
    expect(roomsStore.getState().activeRoomId).toBeNull()
  })

  it("toggles Isaac's reaction locally and tells main", async () => {
    applyRoom(dto('r1', { messages: [msg('m1', 'pm', 2000)] }))
    invoke.mockResolvedValue({ ok: true, value: { reacted: true } })
    await toggleReaction('r1', 'm1', '👍')
    expect(roomsStore.getState().rooms.r1!.messages[0]!.reactions).toEqual([
      { emoji: '👍', by: ['isaac'] },
    ])
    expect(invoke).toHaveBeenCalledWith('rooms.react', {
      roomId: 'r1',
      messageId: 'm1',
      emoji: '👍',
    })
    await toggleReaction('r1', 'nope', '👍')
    expect(roomsStore.getState().rooms.r1!.messages[0]!.reactions).toEqual([
      { emoji: '👍', by: ['isaac'] },
    ])
  })
})
