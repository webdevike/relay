import { createContext, useCallback, useContext, useEffect, useMemo } from 'react'
import { notifications } from '@mantine/notifications'
import type { PinKind } from '@evaos/chat-core/artifacts'
import { pinsOf, type Pin } from '@evaos/chat-core/pins'
import { act, startArtifacts, useArtifacts, useArtifactsThread } from '../artifacts/artifacts-store'

/** What a chat's pin surfaces (the rail, the header popover, bubble actions) share. */
export interface PinsScopeValue {
  /** The thread the pins live in; null for a chat without a session yet. */
  thread: string | null
  /** Relay is connected, so a pin can be made or removed. */
  up: boolean
  /** The thread's pins, newest first. */
  pins: readonly Pin[]
  /** The session file Open on a file pin reveals against. */
  file: string
  pin(note: { kind: PinKind; label: string; value: string; source?: string }): void
  unpin(id: string): void
  /** Scrolls the chat to the message a pin came from (a quiet toast when it is no longer in the log). */
  reveal(source: string): void
}

export const PinsScope = createContext<PinsScopeValue | null>(null)

/** The pins context of the enclosing chat, or null outside one (bubbles then show no pin actions). */
export function usePinsScope(): PinsScopeValue | null {
  return useContext(PinsScope)
}

const revealers = new Map<string, (source: string) => boolean>()

/** A chat log says how to bring one of its messages (by bubble key) into view; true when it did. */
export function registerReveal(paneId: string, fn: (source: string) => boolean): () => void {
  revealers.set(paneId, fn)
  return () => {
    if (revealers.get(paneId) === fn) revealers.delete(paneId)
  }
}

/** The pins of the chat in `paneId` for its session `file` (or assistant `agent`): watched while `shown`. */
export function usePinsFor(
  paneId: string,
  file: string,
  agent: string | null,
  shown: boolean,
): PinsScopeValue {
  useEffect(() => startArtifacts(), [])
  const thread = useArtifactsThread(file === '' ? null : { file, agent }, shown)
  const up = useArtifacts((s) => s.up)
  const items = useArtifacts((s) => (thread === null ? undefined : s.threads[thread]?.items))
  const pins = useMemo(() => (items === undefined ? [] : pinsOf(items)), [items])
  const pin = useCallback<PinsScopeValue['pin']>(
    (note) => {
      if (thread !== null) void act(thread, { op: 'pin.add', ...note })
    },
    [thread],
  )
  const unpin = useCallback(
    (id: string) => {
      if (thread !== null) void act(thread, { op: 'pin', id, pinned: false })
    },
    [thread],
  )
  const reveal = useCallback(
    (source: string) => {
      if (revealers.get(paneId)?.(source) !== true) {
        notifications.show({ message: 'That message is no longer in this chat.', color: 'gray' })
      }
    },
    [paneId],
  )
  return useMemo(
    () => ({ thread, up: up && thread !== null, pins, file, pin, unpin, reveal }),
    [thread, up, pins, file, pin, unpin, reveal],
  )
}
