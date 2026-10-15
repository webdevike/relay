import type { Batch } from '@evaos/contract'
import type { ChatMessage, SessionMeta } from '@evaos/chat-core/message'
import type { ChatState } from './chat-store'

export interface Snapshot {
  seq: number
  messages: ChatMessage[]
  meta: SessionMeta
  running: boolean
}

export interface DrainStats {
  batches: number
  gaps: number
  snapshots: number
  lastSeq: number
}

interface Store {
  getState(): ChatState
}

export interface StreamDrainOptions {
  store: Store
  /** Subscribes to `chat.batch`; returns an unsubscribe. */
  subscribe?: (cb: (b: Batch) => void) => () => void
  requestSnapshot: (paneId: string) => Promise<Snapshot | null>
  raf?: (cb: () => void) => unknown
  /** Called with the per-pane stats after every change (e2e only). */
  onStats?: (paneId: string, s: DrainStats) => void
  /** The reconnecting label stays at least this long so it does not flicker. */
  minReconnectMs?: number
  now?: () => number
  setTimeout?: (fn: () => void, ms: number) => unknown
}

/**
 * Drains main's `{ paneId, seq, ops }` batches once per animation frame (D-15). A seq that is not
 * exactly last + 1 means a batch was lost: the pane shows `Reconnecting to the stream.` and
 * recovers from `chat.snapshot`; stale and duplicate batches are ignored.
 */
export function createStreamDrain(opts: StreamDrainOptions) {
  const raf = opts.raf ?? ((cb) => requestAnimationFrame(cb))
  const now = opts.now ?? (() => Date.now())
  const later = opts.setTimeout ?? ((fn, ms) => setTimeout(fn, ms))
  const minReconnect = opts.minReconnectMs ?? 400
  const queues = new Map<string, Batch[]>()
  const stash = new Map<string, Batch[]>()
  const resyncing = new Set<string>()
  const reconnectSince = new Map<string, number>()
  const stats = new Map<string, DrainStats>()
  let scheduled = false
  let disposed = false

  const statsOf = (paneId: string): DrainStats => {
    let s = stats.get(paneId)
    if (!s) {
      s = { batches: 0, gaps: 0, snapshots: 0, lastSeq: 0 }
      stats.set(paneId, s)
    }
    return s
  }
  const report = (paneId: string): void => opts.onStats?.(paneId, { ...statsOf(paneId) })

  const lastSeq = (paneId: string): number => {
    const q = queues.get(paneId)
    const tail = q?.[q.length - 1]
    return tail ? tail.seq : (opts.store.getState().panes[paneId]?.lastSeq ?? 0)
  }

  const resync = (paneId: string): void => {
    resyncing.add(paneId)
    queues.delete(paneId)
    reconnectSince.set(paneId, now())
    opts.store.getState().setReconnecting(paneId, true)
    statsOf(paneId).gaps += 1
    report(paneId)
    void opts
      .requestSnapshot(paneId)
      .then((snap) => {
        if (disposed) return
        resyncing.delete(paneId)
        if (!snap) return
        queues.delete(paneId)
        opts.store.getState().applySnapshot(paneId, snap)
        const st = statsOf(paneId)
        st.snapshots += 1
        st.lastSeq = snap.seq
        report(paneId)
        const wait = Math.max(0, minReconnect - (now() - (reconnectSince.get(paneId) ?? 0)))
        const clear = (): void => opts.store.getState().setReconnecting(paneId, false)
        if (wait === 0) clear()
        else later(clear, wait)
        // Batches that arrived while the snapshot was in flight continue from its seq. A held
        // batch the snapshot cannot reach (main restarted its seq, for example after the pane was
        // reopened on another file) is dropped: re-stashing it would resync forever. The next
        // live batch resyncs once more if anything is still missing.
        const held = (stash.get(paneId) ?? []).sort((a, b) => a.seq - b.seq)
        stash.delete(paneId)
        for (const b of held) {
          const last = lastSeq(paneId)
          if (b.seq <= last) continue
          if (b.seq !== last + 1) {
            statsOf(paneId).gaps += 1
            report(paneId)
            break
          }
          push(b)
        }
      })
      .catch(() => {
        resyncing.delete(paneId)
      })
  }

  const drain = (): void => {
    scheduled = false
    for (const [paneId, batches] of queues) {
      if (batches.length === 0) continue
      queues.delete(paneId)
      const ops = batches.flatMap((b) => b.ops)
      const seq = batches[batches.length - 1]!.seq
      opts.store.getState().applyOps(paneId, ops, seq)
      const st = statsOf(paneId)
      st.batches += batches.length
      st.lastSeq = seq
      report(paneId)
    }
  }

  function push(batch: Batch): void {
    const { paneId } = batch
    if (!opts.store.getState().panes[paneId]) return
    if (resyncing.has(paneId)) {
      const held = stash.get(paneId) ?? []
      held.push(batch)
      stash.set(paneId, held)
      return
    }
    const last = lastSeq(paneId)
    if (batch.seq <= last) return
    if (batch.seq !== last + 1) {
      resync(paneId)
      const held = stash.get(paneId) ?? []
      held.push(batch)
      stash.set(paneId, held)
      return
    }
    const q = queues.get(paneId) ?? []
    q.push(batch)
    queues.set(paneId, q)
    if (!scheduled) {
      scheduled = true
      raf(drain)
    }
  }

  const unsubscribe = opts.subscribe?.(push)
  return {
    push,
    dispose(): void {
      disposed = true
      unsubscribe?.()
    },
  }
}
