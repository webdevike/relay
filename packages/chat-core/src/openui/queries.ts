/**
 * Live data for OpenUI widgets: `name = Query("tool", {args}, defaults, refreshSec)` statements run
 * through a host-supplied client (dashboards and canvas `ui` nodes; chat has none, so there a Query
 * shows its defaults). A runner keeps one entry per Query statement: the defaults until the first
 * answer, then the latest answer (a failed refetch keeps the last data and reports a warning). It
 * fetches again when the evaluated args change, on `@Run(name)`, and every `refreshSec` while the
 * widget is on screen (`start` / `stop`, driven by the runtime's subscribers). Pure TypeScript (no
 * Node, DOM or code evaluation), so it runs under Hermes and in the Electron renderer.
 *
 * Port of ~/Eva/work/relay/packages/protocol/src/openui/queries.ts.
 */
import type { ParseResult } from './lang/parser/types'
import { evaluate } from './lang/runtime/evaluator'

/** Shortest refresh interval a Query may ask for, in seconds. */
export const MIN_REFRESH_SEC = 10
/** Longest refresh interval, in seconds (an hour). */
export const MAX_REFRESH_SEC = 3600

/** Runs one read-only host query tool; rejects with an Error whose message the widget reports. */
export interface OpenUIQueryClient {
  run(tool: string, args: Record<string, unknown>): Promise<unknown>
}

/** One Query statement evaluated against the current state. */
export interface QueryCall {
  /** The statement name (`jobs` in `jobs = Query(...)`), how the tree refers to its data. */
  id: string
  /** The tool name, or null when the first argument is not a string. */
  tool: string | null
  args: Record<string, unknown>
  defaults: unknown
  /** The refresh interval as written, in seconds; null when there is none. */
  refreshSec: number | null
  /** Tool plus args: a new key is a new fetch. */
  key: string
}

/** What a Query reports besides its data: a failed fetch, an unknown tool, no client. */
export interface QueryIssue {
  id: string
  message: string
}

/** Evaluates every Query statement's tool, args, defaults and refresh against `getState`. */
export function queryCalls(
  result: ParseResult | null,
  getState: (name: string) => unknown,
): QueryCall[] {
  if (!result) return []
  const ctx = { getState, resolveRef: () => null }
  return result.queryStatements.map((statement): QueryCall => {
    const tool = statement.toolAST ? evaluate(statement.toolAST, ctx) : null
    const rawArgs = statement.argsAST ? evaluate(statement.argsAST, ctx) : {}
    const args =
      typeof rawArgs === 'object' && rawArgs !== null && !Array.isArray(rawArgs)
        ? (rawArgs as Record<string, unknown>)
        : {}
    const refresh = statement.refreshAST ? evaluate(statement.refreshAST, ctx) : null
    const name = typeof tool === 'string' && tool !== '' ? tool : null
    return {
      id: statement.statementId,
      tool: name,
      args,
      defaults: statement.defaultsAST ? evaluate(statement.defaultsAST, ctx) : null,
      refreshSec: typeof refresh === 'number' && Number.isFinite(refresh) ? refresh : null,
      key: JSON.stringify([name, args]),
    }
  })
}

interface Entry {
  call: QueryCall
  /** The latest answer for `call.key`'s predecessor or itself; undefined until one arrives. */
  data: unknown
  error: string | null
  /** When `data` arrived (epoch ms), 0 before. */
  fetchedAt: number
  /** Key of the fetch in flight, null when none. */
  inFlight: string | null
  timer: ReturnType<typeof setInterval> | null
  timerSec: number | null
}

export class QueryRunner {
  private readonly entries = new Map<string, Entry>()
  private active = false

  constructor(
    private readonly client: OpenUIQueryClient | null,
    private readonly onChange: () => void,
    private readonly now: () => number = Date.now,
  ) {}

  /** Takes the program's current Query calls; fetches the new or changed ones while active. */
  sync(calls: readonly QueryCall[]): void {
    const ids = new Set(calls.map((call) => call.id))
    for (const [id, entry] of this.entries)
      if (!ids.has(id)) {
        this.clearTimer(entry)
        this.entries.delete(id)
      }
    for (const call of calls) {
      const entry = this.entries.get(call.id)
      if (!entry) {
        this.entries.set(call.id, {
          call,
          data: undefined,
          error: null,
          fetchedAt: 0,
          inFlight: null,
          timer: null,
          timerSec: null,
        })
        continue
      }
      const changed = entry.call.key !== call.key
      entry.call = call
      if (changed) entry.fetchedAt = 0
    }
    if (this.active) this.refreshDue()
  }

  /** The data the tree sees for statement `id`: the latest answer, else the defaults. */
  value(id: string): unknown {
    const entry = this.entries.get(id)
    if (!entry) return null
    return entry.data === undefined ? entry.call.defaults : entry.data
  }

  /** `@Run(id)`: fetch now, whatever the age of the data. */
  refetch(id: string): void {
    const entry = this.entries.get(id)
    if (entry) this.fetch(entry)
  }

  /** The widget is on screen: fetch what is stale and keep refreshing. */
  start(): void {
    this.active = true
    this.refreshDue()
  }

  /** Off screen: no more fetching (an answer in flight still lands). */
  stop(): void {
    this.active = false
    for (const entry of this.entries.values()) this.clearTimer(entry)
  }

  issues(): QueryIssue[] {
    const out: QueryIssue[] = []
    for (const [id, entry] of this.entries) {
      if (this.client === null)
        out.push({
          id,
          message:
            'Query shows its defaults here: live data runs on dashboards and canvas ui nodes',
        })
      else if (entry.call.tool === null)
        out.push({ id, message: "Query's first argument must be a tool name string" })
      else if (entry.error !== null) out.push({ id, message: `${entry.call.tool}: ${entry.error}` })
    }
    return out
  }

  private refreshDue(): void {
    for (const entry of this.entries.values()) {
      const sec = clampRefresh(entry.call.refreshSec)
      const stale =
        entry.fetchedAt === 0 || (sec !== null && this.now() - entry.fetchedAt >= sec * 1000)
      if (stale) this.fetch(entry)
      if (entry.timerSec !== sec) {
        this.clearTimer(entry)
        if (sec !== null && this.client !== null) {
          entry.timerSec = sec
          entry.timer = setInterval(() => {
            this.fetch(entry)
          }, sec * 1000)
        }
      }
    }
  }

  private fetch(entry: Entry): void {
    const { client } = this
    const { tool, args, key } = entry.call
    if (client === null || tool === null || entry.inFlight === key) return
    entry.inFlight = key
    // A client that throws synchronously still lands as a failed fetch.
    Promise.resolve()
      .then(() => client.run(tool, args))
      .then(
        (data) => {
          if (entry.inFlight === key) entry.inFlight = null
          if (entry.call.key !== key || this.entries.get(entry.call.id) !== entry) return
          entry.data = data
          entry.error = null
          entry.fetchedAt = this.now()
          this.onChange()
        },
        (error: unknown) => {
          if (entry.inFlight === key) entry.inFlight = null
          if (entry.call.key !== key || this.entries.get(entry.call.id) !== entry) return
          entry.error = error instanceof Error ? error.message : String(error)
          // Try again at the next interval (or the next start), not in a tight loop.
          entry.fetchedAt = this.now()
          this.onChange()
        },
      )
  }

  private clearTimer(entry: Entry): void {
    clearInterval(entry.timer ?? undefined)
    entry.timer = null
    entry.timerSec = null
  }
}

/** A refresh interval in range, or null for none (a Query without one fetches once). */
export function clampRefresh(sec: number | null): number | null {
  if (sec === null || sec <= 0) return null
  return Math.min(MAX_REFRESH_SEC, Math.max(MIN_REFRESH_SEC, sec))
}
