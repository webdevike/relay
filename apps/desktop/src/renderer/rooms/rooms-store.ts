import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import type { Room as RoomDto } from '@evaos/contract'
import type { CouncilRouting } from '@relay/protocol'
import { invoke, on } from '../ipc'
import { withPortrait } from './roster'
import type { Room, RoomMessage, RoomReaction } from './types'

export interface RoomsState {
  rooms: Record<string, Room>
  /** Room ids, newest first. */
  order: string[]
  /** null shows the new-room form. */
  activeRoomId: string | null
  /** Why the last Start room failed, shown on the form. */
  createError: string | null
}

const initial = (): RoomsState => ({ rooms: {}, order: [], activeRoomId: null, createError: null })

export const roomsStore = createStore<RoomsState>(initial)

export function useRooms<T>(selector: (s: RoomsState) => T): T {
  return useStore(roomsStore, selector)
}

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

const set = (f: (s: RoomsState) => RoomsState): void => roomsStore.setState(f)

/** Main's room, people given their portraits. */
export const fromDto = (r: RoomDto): Room => ({ ...r, agents: r.agents.map(withPortrait) })

/** One room from main replaces what the store holds for it; a new id goes to the top. */
export function applyRoom(dto: RoomDto): void {
  const room = fromDto(dto)
  set((s) => ({
    ...s,
    rooms: { ...s.rooms, [room.id]: room },
    order: s.order.includes(room.id) ? s.order : [room.id, ...s.order],
  }))
}

/** Main's full list (`rooms.list` is newest first). */
export function applyRooms(dtos: readonly RoomDto[]): void {
  set((s) => ({
    ...s,
    rooms: Object.fromEntries(dtos.map((d) => [d.id, fromDto(d)])),
    order: dtos.map((d) => d.id),
  }))
}

/** Starts a room in main and opens it; a failure stays on the form. */
export async function startRoom(prompt: string, agentIds: string[]): Promise<void> {
  set((s) => ({ ...s, createError: null }))
  const r = await invoke('rooms.create', { prompt, agentIds })
  if (!r.ok) {
    set((s) => ({ ...s, createError: r.error.message }))
    return
  }
  set((s) => ({ ...s, activeRoomId: r.value.roomId }))
}

/** What the New room form hands over for a council room. */
export interface CouncilStart {
  effort: number
  source: string
  refs: string[]
  renderCmd?: string
  /** Only the roles moved off their default provider. */
  routing: Partial<CouncilRouting>
}

/** Starts a council room (cast from the notch in main) and opens it; a failure stays on the form. */
export async function startCouncilRoom(prompt: string, council: CouncilStart): Promise<void> {
  set((s) => ({ ...s, createError: null }))
  const r = await invoke('rooms.create', { prompt, council })
  if (!r.ok) {
    set((s) => ({ ...s, createError: r.error.message }))
    return
  }
  set((s) => ({ ...s, activeRoomId: r.value.roomId }))
}

/** An action's failure as the message to show next to its button; null when it went through. */
const failure = (r: { ok: true } | { ok: false; error: { message: string } }): string | null =>
  r.ok ? null : r.error.message

/** One notch up on a live council room; its new seats join at the next round. */
export async function raiseRoom(roomId: string): Promise<string | null> {
  return failure(await invoke('rooms.raise', { roomId }))
}

/** The answer to the 80 % cap pause. */
export async function budgetRoom(
  roomId: string,
  choice: 'continue' | 'wrap',
): Promise<string | null> {
  return failure(await invoke('rooms.budget', { roomId, choice }))
}

/** Allow or deny a seat's outward action. */
export async function answerAsk(
  roomId: string,
  askId: string,
  allow: boolean,
): Promise<string | null> {
  return failure(await invoke('rooms.answer', { roomId, askId, allow }))
}

export async function postToRoom(roomId: string, text: string): Promise<void> {
  await invoke('rooms.post', { roomId, text })
}

/**
 * Isaac's reaction, toggled here first so the click lands at once; main's next `rooms.changed`
 * carries the same state.
 */
export async function toggleReaction(roomId: string, msgId: string, emoji: string): Promise<void> {
  set((s) => {
    const room = s.rooms[roomId]
    if (!room) return s
    const i = room.messages.findIndex((m) => m.id === msgId)
    if (i === -1) return s
    const m = room.messages[i]!
    const messages = room.messages.slice()
    messages[i] = { ...m, reactions: toggleReactionIn(m.reactions, emoji, 'isaac') }
    return { ...s, rooms: { ...s.rooms, [roomId]: { ...room, messages } } }
  })
  await invoke('rooms.react', { roomId, messageId: msgId, emoji })
}

export async function stopRoom(roomId: string): Promise<void> {
  await invoke('rooms.stop', { roomId })
}

/** Council: stop at the end of the round the room is in; the state stays on disk. */
export async function pauseRoom(roomId: string): Promise<string | null> {
  return failure(await invoke('rooms.pause', { roomId }))
}

/** Council: run a paused, wrapped or failed room on from its next round with the same seats. */
export async function resumeRoom(roomId: string): Promise<string | null> {
  return failure(await invoke('rooms.resume', { roomId }))
}

export function setActive(roomId: string | null): void {
  set((s) => (s.activeRoomId === roomId ? s : { ...s, activeRoomId: roomId }))
}

/** Mirrors main's rooms for the life of the window. */
export function startRooms(): () => void {
  const off = on('rooms.changed', ({ room }) => applyRoom(room))
  void invoke('rooms.list', {}).then((r) => {
    if (r.ok) applyRooms(r.value.rooms)
  })
  return off
}

export function resetRoomsForTests(): void {
  roomsStore.setState(initial())
}
