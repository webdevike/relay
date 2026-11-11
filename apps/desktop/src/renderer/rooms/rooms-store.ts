import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import {
  roomActivity,
  type ChatRoomSetup,
  type ChatRoomSetupPatch,
  type DecideAction,
  type Room as RoomDto,
} from '@evaos/contract'
import { setRoomTitles } from '../eva/names-store'
import { invoke, on } from '../ipc'
import { withPortrait } from './roster'
import type { Room, RoomMessage, RoomReaction } from './types'

export interface RoomsState {
  rooms: Record<string, Room>
  /** Room ids, latest activity first. */
  order: string[]
  /** The room whose title is being renamed in place, and where: its nav row or its header. */
  renaming: { id: string; where: RenameWhere } | null
  /** The room whose setup form shows in place of its chat (Members...), if any. */
  editing: string | null
}

export type RenameWhere = 'nav' | 'header'

const initial = (): RoomsState => ({ rooms: {}, order: [], renaming: null, editing: null })

export const roomsStore = createStore<RoomsState>(initial)

export function useRooms<T>(selector: (s: RoomsState) => T): T {
  return useStore(roomsStore, selector)
}

/** The room id a `room:<id>` place shows, else null. */
export function roomIdOf(page: string): string | null {
  return page.startsWith('room:') ? page.slice('room:'.length) : null
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

/** The rooms as the store keeps them: latest activity first, their titles named for tabs. */
function settle(rooms: Record<string, Room>): Pick<RoomsState, 'rooms' | 'order'> {
  const order = Object.values(rooms)
    .sort((a, b) => roomActivity(b) - roomActivity(a))
    .map((r) => r.id)
  setRoomTitles(Object.fromEntries(order.map((id) => [id, rooms[id]!.title])))
  return { rooms, order }
}

const set = (f: (s: RoomsState) => Partial<RoomsState>): void =>
  roomsStore.setState((s) => ({ ...s, ...f(s) }))

/** Main's room, people given their portraits. */
export const fromDto = (r: RoomDto): Room => ({ ...r, agents: r.agents.map(withPortrait) })

/** One room from main replaces what the store holds for it. */
export function applyRoom(dto: RoomDto): void {
  set((s) => settle({ ...s.rooms, [dto.id]: fromDto(dto) }))
}

/** Main's full list. */
export function applyRooms(dtos: readonly RoomDto[]): void {
  set(() => settle(Object.fromEntries(dtos.map((d) => [d.id, fromDto(d)]))))
}

/** A room main deleted. */
export function dropRoom(roomId: string): void {
  set((s) => {
    const rooms = { ...s.rooms }
    delete rooms[roomId]
    return {
      ...settle(rooms),
      renaming: s.renaming?.id === roomId ? null : s.renaming,
      editing: s.editing === roomId ? null : s.editing,
    }
  })
}

type Answer<T> = { ok: true; value: T } | { ok: false; error: { message: string } }

/** An action's failure as the message to show next to its control; null when it went through. */
const failure = (r: Answer<unknown>): string | null => (r.ok ? null : r.error.message)

/** A new idle chat room; answers its id, or why main refused it. */
export async function openRoom(
  setup: ChatRoomSetup,
): Promise<{ roomId: string } | { error: string }> {
  const r: Answer<{ roomId: string }> = await invoke('rooms.open', { setup })
  return r.ok ? { roomId: r.value.roomId } : { error: r.error.message }
}

/** A chat room's new setup (members replace the list). */
export async function updateRoom(
  roomId: string,
  setup: ChatRoomSetupPatch,
): Promise<string | null> {
  return failure(await invoke('rooms.update', { roomId, setup }))
}

export async function renameRoom(roomId: string, title: string): Promise<string | null> {
  return failure(await invoke('rooms.rename', { roomId, title }))
}

/** A chat room's copy (same setup, no messages); answers its id, or null when main refused. */
export async function duplicateRoom(roomId: string): Promise<string | null> {
  const r = await invoke('rooms.duplicate', { roomId })
  return r.ok ? r.value.roomId : null
}

export async function deleteRoom(roomId: string): Promise<string | null> {
  return failure(await invoke('rooms.delete', { roomId }))
}

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

export async function postToRoom(roomId: string, text: string): Promise<string | null> {
  return failure(await invoke('rooms.post', { roomId, text }))
}

// Isaac on a chat room's decision cards; each answers why main refused it, or null. Main's next
// `rooms.changed` carries the card's new state and the room's line about it.

/** His vote (`option` id); null, or his current pick again, takes it back. */
export async function voteInRoom(
  roomId: string,
  cardId: string,
  option: string | null,
): Promise<string | null> {
  return failure(await invoke('rooms.vote', { roomId, cardId, option }))
}

/** Calls a poll: `option`, else his vote, else the leader. */
export async function callRoomPoll(
  roomId: string,
  cardId: string,
  option?: string,
): Promise<string | null> {
  return failure(await invoke('rooms.callPoll', { roomId, cardId, ...(option ? { option } : {}) }))
}

export async function reopenRoomPoll(roomId: string, cardId: string): Promise<string | null> {
  return failure(await invoke('rooms.reopenPoll', { roomId, cardId }))
}

/** His answer to a member's question: posted, so the members talk again. */
export async function answerRoomAsk(
  roomId: string,
  cardId: string,
  answer: string,
): Promise<string | null> {
  return failure(await invoke('rooms.answerAsk', { roomId, cardId, answer }))
}

export async function decideInRoom(
  roomId: string,
  cardId: string,
  action: DecideAction,
  option?: string,
): Promise<string | null> {
  return failure(
    await invoke('rooms.decide', { roomId, cardId, action, ...(option ? { option } : {}) }),
  )
}

/**
 * Isaac's reaction, toggled here first so the click lands at once; main's next `rooms.changed`
 * carries the same state.
 */
export async function toggleReaction(roomId: string, msgId: string, emoji: string): Promise<void> {
  set((s) => {
    const room = s.rooms[roomId]
    if (!room) return {}
    const i = room.messages.findIndex((m) => m.id === msgId)
    if (i === -1) return {}
    const messages = room.messages.slice()
    const m = messages[i]!
    messages[i] = { ...m, reactions: toggleReactionIn(m.reactions, emoji, 'isaac') }
    return { rooms: { ...s.rooms, [roomId]: { ...room, messages } } }
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

/** Shows the title field of room `roomId` in its nav row or its header (null: none). */
export function setRenaming(roomId: string | null, where: RenameWhere = 'nav'): void {
  set(() => ({ renaming: roomId === null ? null : { id: roomId, where } }))
}

/** Shows the setup form of room `roomId` in place of its chat (null: back to the chat). */
export function setEditing(roomId: string | null): void {
  set(() => ({ editing: roomId }))
}

/** Mirrors main's rooms for the life of the window. */
export function startRooms(): () => void {
  const offChanged = on('rooms.changed', ({ room }) => applyRoom(room))
  const offRemoved = on('rooms.removed', ({ roomId }) => dropRoom(roomId))
  void invoke('rooms.list', {}).then((r) => {
    if (r.ok) applyRooms(r.value.rooms)
  })
  return () => {
    offChanged()
    offRemoved()
  }
}

export function resetRoomsForTests(): void {
  roomsStore.setState(initial())
}
