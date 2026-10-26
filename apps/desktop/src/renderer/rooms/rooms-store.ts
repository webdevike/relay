import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import type { Room, RoomAgent, RoomMessage, RoomReaction } from './types'

export interface RoomsState {
  rooms: Record<string, Room>
  /** Room ids, newest first. */
  order: string[]
  /** null shows the new-room form. */
  activeRoomId: string | null
}

const initial = (): RoomsState => ({ rooms: {}, order: [], activeRoomId: null })

export const roomsStore = createStore<RoomsState>(initial)

export function useRooms<T>(selector: (s: RoomsState) => T): T {
  return useStore(roomsStore, selector)
}

let seq = 0
export const nextId = (prefix: string): string => `${prefix}-${Date.now().toString(36)}-${++seq}`

/** Consecutive messages by one author within this window share one header. */
export const GROUP_WINDOW_MS = 120_000

export interface MessageGroup {
  author: string
  messages: RoomMessage[]
}

/**
 * Collapses consecutive same-author messages posted within 120 s of the previous one under one
 * header. A summary never joins a group: it is pinned and rendered on its own.
 */
export function groupMessages(messages: readonly RoomMessage[]): MessageGroup[] {
  const groups: MessageGroup[] = []
  let prev: RoomMessage | null = null
  for (const m of messages) {
    const last = groups[groups.length - 1]
    const joins =
      last !== undefined &&
      prev !== null &&
      prev.kind === 'message' &&
      m.kind === 'message' &&
      prev.author === m.author &&
      m.ts - prev.ts <= GROUP_WINDOW_MS
    if (joins) last.messages.push(m)
    else groups.push({ author: m.author, messages: [m] })
    prev = m
  }
  return groups
}

/** Adds `by` to the emoji's reaction, or removes it; an emptied reaction disappears. */
export function toggleReactionIn(
  reactions: readonly RoomReaction[],
  emoji: string,
  by: string,
): RoomReaction[] {
  const i = reactions.findIndex((r) => r.emoji === emoji)
  if (i === -1) return [...reactions, { emoji, by: [by] }]
  const r = reactions[i]!
  const had = r.by.includes(by)
  const next = had ? r.by.filter((b) => b !== by) : [...r.by, by]
  const out = reactions.slice()
  if (next.length === 0) out.splice(i, 1)
  else out[i] = { emoji, by: next }
  return out
}

function patchRoom(s: RoomsState, roomId: string, f: (r: Room) => Room): RoomsState {
  const room = s.rooms[roomId]
  if (!room) return s
  const next = f(room)
  return next === room ? s : { ...s, rooms: { ...s.rooms, [roomId]: next } }
}

const set = (f: (s: RoomsState) => RoomsState): void => roomsStore.setState(f)

export function createRoom(prompt: string, agents: RoomAgent[], now = Date.now()): Room {
  const room: Room = {
    id: nextId('room'),
    title: prompt.trim().split('\n')[0] || 'Untitled room',
    prompt: prompt.trim(),
    agents,
    messages: [],
    typing: [],
    status: 'live',
    startedAt: now,
  }
  set((s) => ({
    rooms: { ...s.rooms, [room.id]: room },
    order: [room.id, ...s.order],
    activeRoomId: room.id,
  }))
  return room
}

export function post(roomId: string, msg: RoomMessage): void {
  set((s) =>
    patchRoom(s, roomId, (r) => ({
      ...r,
      messages: [...r.messages, msg],
      typing: r.typing.filter((id) => id !== msg.author),
    })),
  )
}

export function toggleReaction(roomId: string, msgId: string, emoji: string, by: string): void {
  set((s) =>
    patchRoom(s, roomId, (r) => {
      const i = r.messages.findIndex((m) => m.id === msgId)
      if (i === -1) return r
      const m = r.messages[i]!
      const messages = r.messages.slice()
      messages[i] = { ...m, reactions: toggleReactionIn(m.reactions, emoji, by) }
      return { ...r, messages }
    }),
  )
}

export function setTyping(roomId: string, agentId: string, on: boolean): void {
  set((s) =>
    patchRoom(s, roomId, (r) => {
      const has = r.typing.includes(agentId)
      if (has === on) return r
      return { ...r, typing: on ? [...r.typing, agentId] : r.typing.filter((id) => id !== agentId) }
    }),
  )
}

export function resolve(roomId: string, summary: RoomMessage): void {
  set((s) =>
    patchRoom(s, roomId, (r) => ({
      ...r,
      messages: [...r.messages, { ...summary, kind: 'summary' }],
      typing: [],
      status: 'resolved',
      resolvedAt: summary.ts,
    })),
  )
}

export function setActive(roomId: string | null): void {
  set((s) => (s.activeRoomId === roomId ? s : { ...s, activeRoomId: roomId }))
}

export function resetRoomsForTests(): void {
  roomsStore.setState(initial())
}
