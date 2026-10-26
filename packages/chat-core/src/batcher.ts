import type { ChatMessage, Dialog, Goal, SessionMeta } from './message'

/** A chat omp runs outside this app, driven through Relay; `job` when Eva's job launcher started it. */
export type AwayView = { job: boolean }

export type MetaPatch = {
  running?: boolean
  connected?: boolean
  error?: string | null
  notice?: string | null
  model?: [string, string] | null
  contextTokens?: number | null
  contextWindow?: number | null
  thinking?: string | null
  dialog?: Dialog | null
  /** omp's goal while active or paused. */
  goal?: Goal | null
  /** A `/handoff` is generating; omp sends no progress, only its final `command_output`. */
  handingOff?: boolean
  sessionFile?: string | null
  away?: AwayView | null
  /** The session's name, once omp or Relay has one. */
  title?: string
}

/** `at` is the row's index in the full list after the batch; used only when the id is new to the renderer. */
export type Op =
  | { op: 'upsert'; message: ChatMessage; at?: number }
  | { op: 'remove'; id: string }
  | { op: 'meta'; patch: MetaPatch }

export type Batch = { paneId: string; seq: number; ops: Op[] }

/** The whole pane state a resync replaces: everything a MetaPatch can carry must be here too. */
export interface Snapshot {
  seq: number
  messages: ChatMessage[]
  meta: SessionMeta
  running: boolean
  /** False once omp exited or was closed (drives the renderer's `stopped`). */
  connected: boolean
  error: string | null
  dialog?: Dialog | null
  goal?: Goal | null
  handingOff?: boolean
  sessionFile?: string | null
  away?: AwayView | null
  title?: string
}

export type SnapshotState = Pick<
  Snapshot,
  | 'running'
  | 'connected'
  | 'error'
  | 'dialog'
  | 'goal'
  | 'handingOff'
  | 'sessionFile'
  | 'away'
  | 'title'
>

/** Coalesces ops between flushes (last upsert per id wins) and stamps each non-empty batch with seq + 1. */
export class SeqBatcher {
  private seq = 0
  private upserts = new Map<string, { message: ChatMessage; at?: number }>()
  private removes = new Set<string>()
  private meta: MetaPatch = {}

  constructor(readonly paneId: string) {}

  markUpsert(message: ChatMessage, at?: number): void {
    this.upserts.set(message.id, { message, at })
  }

  markRemove(id: string): void {
    this.upserts.delete(id)
    this.removes.add(id)
  }

  markMeta(patch: MetaPatch): void {
    Object.assign(this.meta, patch)
  }

  get currentSeq(): number {
    return this.seq
  }

  flush(): Batch | null {
    const hasMeta = Object.keys(this.meta).length > 0
    if (this.upserts.size === 0 && this.removes.size === 0 && !hasMeta) return null
    const ops: Op[] = []
    for (const id of this.removes) ops.push({ op: 'remove', id })
    const ups = [...this.upserts.values()].sort((a, b) => (a.at ?? 1e12) - (b.at ?? 1e12))
    for (const u of ups) {
      ops.push(
        u.at === undefined
          ? { op: 'upsert', message: u.message }
          : { op: 'upsert', message: u.message, at: u.at },
      )
    }
    if (hasMeta) ops.push({ op: 'meta', patch: this.meta })
    this.upserts = new Map()
    this.removes = new Set()
    this.meta = {}
    this.seq += 1
    return { paneId: this.paneId, seq: this.seq, ops }
  }

  /** The current seq with the reducer's state. Pending (unflushed) ops are already part of `messages`, so they are discarded. */
  snapshot(messages: ChatMessage[], meta: SessionMeta, state: SnapshotState): Snapshot {
    return { seq: this.seq, messages, meta, ...state }
  }
}
