import { useEffect, useMemo } from 'react'
import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import type { AsksView, OpenAsk } from '@evaos/contract'
import { invoke, on } from '../../ipc'
import { openAsks } from './open-asks'

/**
 * Assistant threads' open asks as main last heard them from the host, by agent id (null: the host
 * sends none, an older one). Ids Isaac closed here hide at once (`closed`, `agent:id`) and drop out
 * once the host's snapshot no longer lists them.
 */
export interface AsksState {
  byAgent: Record<string, readonly OpenAsk[] | null>
  closed: ReadonlySet<string>
}

export const asksStore = createStore<AsksState>(() => ({ byAgent: {}, closed: new Set() }))

export function useAsks<T>(selector: (s: AsksState) => T): T {
  return useStore(asksStore, selector)
}

const closedKey = (agent: string, id: string): string => `${agent}:${id}`

/** Ids of `agent` hidden here, as bare ask ids. */
export function closedOf(closed: ReadonlySet<string>, agent: string): ReadonlySet<string> {
  const prefix = `${agent}:`
  return new Set([...closed].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length)))
}

export function applyAsks(view: AsksView): void {
  asksStore.setState((s) => {
    const open = new Set((view.asks ?? []).map((a) => closedKey(view.agent, a.id)))
    const kept = [...s.closed].filter((k) => !k.startsWith(`${view.agent}:`) || open.has(k))
    return {
      byAgent: { ...s.byAgent, [view.agent]: view.asks },
      closed: kept.length === s.closed.size ? s.closed : new Set(kept),
    }
  })
}

/** Follows main's pushes of each watched thread's open asks. */
export function startAsks(): () => void {
  return on('asks.changed', applyAsks)
}

/** The agent an assistant thread's reaction thread (`assistant:<id>`) belongs to; null for any other. */
export function askAgentOf(thread: string | null): string | null {
  return thread !== null && thread.startsWith('assistant:')
    ? thread.slice('assistant:'.length)
    : null
}

/** Watches `agent`'s open asks while the caller is mounted. */
export function useWatchedAsks(agent: string | null): void {
  useEffect(() => startAsks(), [])
  useEffect(() => {
    if (agent === null) return
    let live = true
    void invoke('asks.watch', { agent }).then((r) => {
      if (live && r.ok) applyAsks(r.value)
    })
    return () => {
      live = false
      void invoke('asks.unwatch', { agent })
    }
  }, [agent])
}

/** `agent`'s asks still open (oldest first). */
export function useOpenAsks(agent: string | null): readonly OpenAsk[] {
  const asks = useAsks((s) => (agent === null ? null : (s.byAgent[agent] ?? null)))
  const closed = useAsks((s) => s.closed)
  return useMemo(
    () => openAsks(asks, agent === null ? new Set() : closedOf(closed, agent)),
    [asks, closed, agent],
  )
}

/**
 * Closes `ask` of `agent`'s thread: hidden at once, sent to the host (`answer` is the words Isaac
 * chose). Shown again when the host could not be told.
 */
export async function resolveAsk(
  agent: string,
  ask: OpenAsk,
  how: 'answered' | 'dismissed',
  answer?: string,
): Promise<void> {
  const key = closedKey(agent, ask.id)
  asksStore.setState((s) => ({ closed: new Set([...s.closed, key]) }))
  const r = await invoke('asks.resolve', {
    agent,
    id: ask.id,
    how,
    ...(answer === undefined ? {} : { answer }),
  })
  if (r.ok && r.value.sent) return
  asksStore.setState((s) => ({ closed: new Set([...s.closed].filter((k) => k !== key)) }))
}
