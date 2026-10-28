import { useEffect, useState } from 'react'
import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import { notifications } from '@mantine/notifications'
import type { ArtifactAction, ArtifactTab } from '@evaos/chat-core/artifacts'
import type { ArtifactsActed, ArtifactsView } from '@evaos/contract'
import { invoke, on } from '../ipc'

export interface ThreadView {
  loaded: boolean
  items: ArtifactsView['items']
  tabs: ArtifactsView['tabs']
}

/** An agent's new tab, announced once under the bar until Isaac acts on it or closes it. */
export interface TabNotice {
  thread: string
  tab: string
  by: string
  title: string
}

/**
 * The Artifacts panel's threads as main last heard them from Relay, the tab open in each, and the
 * one-time notices of tabs agents added.
 */
export interface ArtifactsState {
  up: boolean
  threads: Record<string, ThreadView>
  /** The tab shown per thread; absent: the first visible one. */
  active: Record<string, string>
  notices: TabNotice[]
}

const SEEN_KEY = 'eva.artifacts.noticed'

/** Tabs whose notice already showed (`thread\ntab`), so each is announced once across launches. */
function noticed(): Set<string> {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(SEEN_KEY) ?? '[]')
    return new Set(Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [])
  } catch {
    return new Set()
  }
}

function markNoticed(key: string): void {
  const seen = [...noticed(), key].slice(-500)
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify(seen))
  } catch {
    // Private storage off: the notice may show again next launch.
  }
}

export const artifactsStore = createStore<ArtifactsState>(() => ({
  up: false,
  threads: {},
  active: {},
  notices: [],
}))

export function useArtifacts<T>(selector: (s: ArtifactsState) => T): T {
  return useStore(artifactsStore, selector)
}

/** Fresh agent tabs in `tabs` not yet announced. */
export function newNotices(
  thread: string,
  tabs: readonly ArtifactTab[],
  seen: ReadonlySet<string>,
): TabNotice[] {
  return tabs
    .filter(
      (t) => t.fresh === true && !t.hidden && t.createdBy !== 'isaac' && t.createdBy !== 'default',
    )
    .filter((t) => !seen.has(`${thread}\n${t.id}`))
    .map((t) => ({ thread, tab: t.id, by: t.createdBy, title: t.title }))
}

export function applyView(v: ArtifactsView): void {
  const thread = v.thread
  if (thread === null) {
    artifactsStore.setState({ up: v.up })
    return
  }
  const fresh = v.loaded ? newNotices(thread, v.tabs, noticed()) : []
  for (const n of fresh) markNoticed(`${n.thread}\n${n.tab}`)
  artifactsStore.setState((s) => ({
    up: v.up,
    threads: { ...s.threads, [thread]: { loaded: v.loaded, items: v.items, tabs: v.tabs } },
    notices: [
      ...s.notices.filter((n) => !fresh.some((f) => f.thread === n.thread && f.tab === n.tab)),
      ...fresh,
    ],
  }))
}

let listeners = 0
let stop: (() => void) | null = null

/** Follows main's pushes while any panel is mounted: watched threads' snapshots and Relay's state. */
export function startArtifacts(): () => void {
  if (listeners++ === 0) {
    const offChanged = on('artifacts.changed', applyView)
    const offStatus = on('artifacts.status', ({ up }) => artifactsStore.setState({ up }))
    stop = () => {
      offChanged()
      offStatus()
    }
  }
  return () => {
    if (--listeners === 0) {
      stop?.()
      stop = null
    }
  }
}

/**
 * The thread a panel shows for `target` (an assistant page or a chat), watched while mounted and
 * shown; null for a page that is neither or a chat without a session yet. Resolved again when
 * Relay comes up, since only Relay says which sessions are an assistant's.
 */
export function useArtifactsThread(
  target: { file: string; agent: string | null } | null,
  shown: boolean,
): string | null {
  const up = useArtifacts((s) => s.up)
  const [thread, setThread] = useState<string | null>(null)
  const file = target?.file ?? null
  const agent = target?.agent ?? null
  useEffect(() => {
    setThread(null)
    if (file === null || !shown) return
    let live = true
    let watched: string | null = null
    void invoke('artifacts.watch', { file, agent }).then((r) => {
      if (!r.ok) return
      const t = r.value.thread
      if (!live) {
        if (t !== null) void invoke('artifacts.unwatch', { thread: t })
        return
      }
      watched = t
      applyView(r.value)
      setThread(t)
    })
    return () => {
      live = false
      if (watched !== null) void invoke('artifacts.unwatch', { thread: watched })
    }
  }, [file, agent, up, shown])
  return thread
}

export function setActiveTab(thread: string, tab: string): void {
  artifactsStore.setState((s) => ({ active: { ...s.active, [thread]: tab } }))
}

export function dismissNotice(thread: string, tab: string): void {
  artifactsStore.setState((s) => ({
    notices: s.notices.filter((n) => !(n.thread === thread && n.tab === tab)),
  }))
}

/** Does `action` on `thread` as Isaac; a refusal or a failure shows the host's words. */
export async function act(thread: string, action: ArtifactAction): Promise<ArtifactsActed> {
  const r = await invoke('artifacts.act', { thread, action })
  const out: ArtifactsActed = r.ok ? r.value : { ok: false, error: r.error.message }
  if (!out.ok) {
    notifications.show({
      color: 'red',
      title: "Artifacts didn't change",
      message: out.error ?? 'Relay refused it.',
    })
  }
  return out
}
