import { createStore, useStore } from 'zustand'
import {
  ConnectionIdSchema,
  type ConnectResult,
  type Connection,
  type ConnectionId,
} from '@evaos/contract'
import { invoke, on } from '../ipc'
import { findTarget, showSpotlight } from '../tour/tour-store'

export interface ConnectionsState {
  rows: Connection[] | null
  error: string | null
  /** The row a deep link (`?connect=<id>`) opened, with its Connect step shown. */
  focus: ConnectionId | null
  /** A row whose Connect or Disconnect is running. */
  busy: ConnectionId | null
  /** What the last Connect answered per row: a GitHub code, the step Isaac takes, an error. */
  notes: Partial<Record<ConnectionId, string>>
}

export const connectionsStore = createStore<ConnectionsState>(() => ({
  rows: null,
  error: null,
  focus: null,
  busy: null,
  notes: {},
}))

export function useConnections<T>(selector: (s: ConnectionsState) => T): T {
  return useStore(connectionsStore, selector)
}

export async function loadConnections(): Promise<void> {
  const r = await invoke('connections.list', {})
  connectionsStore.setState(
    r.ok ? { rows: r.value.connections, error: null } : { error: r.error.message },
  )
}

/** Keeps the list current while Settings > Connections is open. */
export function startConnections(): () => void {
  void loadConnections()
  return on('connections.changed', ({ connections }) =>
    connectionsStore.setState({ rows: connections, error: null }),
  )
}

const note = (id: ConnectionId, text: string | null): void =>
  connectionsStore.setState((s) => {
    const notes = { ...s.notes }
    if (text === null) delete notes[id]
    else notes[id] = text
    return { notes }
  })

const WAIT_MS = 3000

/** A deep link's `?connect=<id>`: opens that row's Connect step and points it out once drawn. */
export function focusConnection(id: string): void {
  const parsed = ConnectionIdSchema.safeParse(id)
  if (!parsed.success) return
  connectionsStore.setState({ focus: parsed.data })
  const target = `connection-${parsed.data}`
  const until = Date.now() + WAIT_MS
  const tryShow = (): void => {
    const row = connectionsStore.getState().rows?.find((r) => r.id === parsed.data)
    if (findTarget(target) !== null && row) {
      showSpotlight({
        target,
        title: row.title,
        caption:
          row.status === 'connected' ? `Connected: ${row.detail}` : `Connect ${row.title} here.`,
      })
    } else if (Date.now() < until) {
      setTimeout(tryShow, 100)
    }
  }
  setTimeout(tryShow, 0)
}

function describeResult(r: ConnectResult): string | null {
  if (r.status === 'connected') return null
  return r.code !== undefined ? `Enter ${r.code} on GitHub (opened in your browser).` : r.step
}

/** Connect from Settings: a Linear key, GitHub's device sign-in, or omp's browser sign-in. */
export async function connect(id: ConnectionId, secret?: string): Promise<boolean> {
  connectionsStore.setState({ busy: id })
  try {
    if (id === 'anthropic' || id === 'openai') {
      note(id, 'Finish signing in in your browser.')
      const runId = `connect-${id}-${Date.now()}`
      const r = await invoke('setup.run', { runId, run: { task: 'ai-login', provider: id } })
      note(
        id,
        r.ok && r.value.ok ? null : (r.ok ? r.value.message : r.error.message) || 'Sign-in failed',
      )
      await loadConnections()
      return r.ok && r.value.ok
    }
    const r = await invoke('connections.connect', secret === undefined ? { id } : { id, secret })
    note(id, r.ok ? describeResult(r.value) : r.error.message)
    if (r.ok) await loadConnections()
    return r.ok && r.value.status === 'connected'
  } finally {
    connectionsStore.setState({ busy: null })
  }
}

export async function disconnect(id: ConnectionId): Promise<void> {
  connectionsStore.setState({ busy: id })
  try {
    const r = await invoke('connections.disconnect', { id })
    note(id, r.ok ? null : r.error.message)
    if (r.ok) await loadConnections()
  } finally {
    connectionsStore.setState({ busy: null })
  }
}
