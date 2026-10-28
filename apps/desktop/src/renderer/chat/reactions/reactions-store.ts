import { createContext, useEffect, useState } from 'react'
import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import { withIsaacReaction, type ThreadReactions } from '@evaos/chat-core/reactions'
import type { ReactionsView } from '@evaos/contract'
import { invoke, on } from '../../ipc'

/**
 * Tapbacks on chat bubbles, as main last heard them from Relay, by thread, bubble and reactor
 * (Isaac, or an assistant on his bubble). His tap applies at once (optimistic); the host's next
 * snapshot of the thread replaces it, and one that could not be sent is taken back.
 */
export interface ReactionsState {
  /** Relay is connected, so a reaction can be sent. */
  up: boolean
  threads: Record<string, ThreadReactions>
}

export const reactionsStore = createStore<ReactionsState>(() => ({ up: false, threads: {} }))

export function useReactions<T>(selector: (s: ReactionsState) => T): T {
  return useStore(reactionsStore, selector)
}

function applyView(v: ReactionsView): void {
  const thread = v.thread
  reactionsStore.setState((s) => ({
    up: v.up,
    threads: thread === null ? s.threads : { ...s.threads, [thread]: v.reactions },
  }))
}

/** Follows main's pushes: each watched thread's snapshots and Relay coming up or going down. */
export function startReactions(): () => void {
  const offChanged = on('reactions.changed', applyView)
  const offStatus = on('reactions.status', ({ up }) => reactionsStore.setState({ up }))
  return () => {
    offChanged()
    offStatus()
  }
}

/**
 * The reaction thread of the chat in `file` (an assistant page passes its `agent`), watched while
 * the caller is mounted; null for a chat without a session yet. Resolved again when Relay comes up,
 * since only Relay says which sessions are an assistant's.
 */
export function useReactionThread(file: string, agent: string | null): string | null {
  const up = useReactions((s) => s.up)
  const [thread, setThread] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    let watched: string | null = null
    void invoke('reactions.watch', { file, agent }).then((r) => {
      if (!r.ok) return
      const t = r.value.thread
      if (!live) {
        if (t !== null) void invoke('reactions.unwatch', { thread: t })
        return
      }
      watched = t
      applyView(r.value)
      setThread(t)
    })
    return () => {
      live = false
      if (watched !== null) void invoke('reactions.unwatch', { thread: watched })
    }
  }, [file, agent, up])
  return thread
}

/**
 * Puts Isaac's `emoji` on bubble `key` of `thread`, or takes his reaction off (null); the
 * assistants' stay. Shown at once; taken back when Relay could not be told.
 */
export async function react(
  thread: string,
  key: string,
  emoji: string | null,
  excerpt: string,
): Promise<void> {
  const before = reactionsStore.getState().threads[thread] ?? {}
  const { [key]: bubble, ...rest } = before
  const mine = emoji === null ? null : { emoji, excerpt, at: Date.now() }
  const after = withIsaacReaction(bubble, mine)
  const next: ThreadReactions = after === undefined ? rest : { ...rest, [key]: after }
  reactionsStore.setState((s) => ({ threads: { ...s.threads, [thread]: next } }))
  const r = await invoke('reactions.react', { thread, message: key, emoji, excerpt })
  if (r.ok && r.value.sent) return
  // Not sent: undo, unless a snapshot already replaced the guess.
  if (reactionsStore.getState().threads[thread] === next) {
    reactionsStore.setState((s) => ({ threads: { ...s.threads, [thread]: before } }))
  }
}

/** What a chat log's bubbles react in, and where Reply puts its quote. Absent: plain rows. */
export interface ReactionScopeValue {
  /** The chat's reaction thread; null while it has none (bubbles still get the menu). */
  thread: string | null
  /** Puts `text` into the chat's composer and focuses it. */
  reply(text: string): void
}

export const ReactionScope = createContext<ReactionScopeValue | null>(null)
