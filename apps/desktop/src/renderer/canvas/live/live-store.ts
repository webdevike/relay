import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import type { CanvasRoom, CanvasRooms } from '@evaos/contract'
import { placeOf, type Place } from '@evaos/shell-core'
import { invoke, on } from '../../ipc'
import { listStore } from '../../chat/list/list-store'

/** The Relay host's canvas rooms as main last sent them; null until the first list arrives. */
export const liveStore = createStore<{ data: CanvasRooms | null }>(() => ({ data: null }))

export function useLiveRooms<T>(selector: (s: { data: CanvasRooms | null }) => T): T {
  return useStore(liveStore, selector)
}

/** The live room on board `slug`, if one is. */
export function liveRoomOn(data: CanvasRooms | null, slug: string): CanvasRoom | null {
  return data?.rooms.find((r) => r.slug === slug && r.live) ?? null
}

/** A host path (an agent's avatar) as a URL the app can load, null without a host. */
export function hostUrl(data: CanvasRooms | null, path: string | undefined): string | null {
  if (!path || !data?.origin) return null
  try {
    return new URL(path, data.origin).toString()
  } catch {
    return null
  }
}

/**
 * The chat a room came from, where this app can show it: an assistant's thread page, or the chat
 * whose session id the room names (when the chat list has it). Null when neither is known.
 */
export function originPlace(room: CanvasRoom): Place | null {
  if (room.chat.assistant) return placeOf(`agent:${room.chat.assistant}`)
  const id = room.chat.sessionId
  const row = id ? listStore.getState().list?.rows.find((r) => r.id === id) : undefined
  return row ? placeOf('chat', { chat: row.file }) : null
}

/** Loads the rooms once and follows main's pushes (Relay pushes every change). */
export function startCanvasLive(): () => void {
  const off = on('canvas.live.changed', (data) => liveStore.setState({ data }))
  void invoke('canvas.live.rooms', {}).then((r) => {
    if (r.ok) liveStore.setState({ data: r.value })
  })
  return off
}
