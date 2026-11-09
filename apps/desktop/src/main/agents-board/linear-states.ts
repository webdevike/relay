// Linear states for the Agents board: every ticket on it in one GraphQL request (plus Isaac's own
// In Progress tickets, which auto-work picks up), refreshed in the background at most every
// REFRESH_MS. A thin client has no Linear key: it asks its host one issue at a time instead.
import { z } from 'zod'
import type { LinearIssue } from '@evaos/contract'
import { toIssue, type LinearRead } from '../linear/linear-ipc'

export const REFRESH_MS = 3 * 60_000
const HOST_CONCURRENCY = 4

const FIELDS =
  'identifier title url updatedAt priority state { name type } assignee { name } project { name }'

export type LinearStatus = 'ok' | 'loading' | 'off' | 'error'

export interface LinearStates {
  get(key: string): LinearIssue | null
  /** Isaac's tickets In Progress in Linear. */
  started(): readonly LinearIssue[]
  status(): LinearStatus
  /** Asks for these keys: a refresh starts when one is new or the last is older than REFRESH_MS. */
  want(keys: readonly string[]): void
  onChange(cb: () => void): () => void
}

/** One request: these issues by team and number, and the viewer's In Progress tickets. */
export function batchQuery(keys: readonly string[]): {
  query: string
  variables: Record<string, number[]>
} {
  const byTeam = new Map<string, number[]>()
  for (const k of keys) {
    const m = /^([A-Z][A-Z0-9]*)-(\d+)$/.exec(k)
    if (m) byTeam.set(m[1]!, [...(byTeam.get(m[1]!) ?? []), Number(m[2])])
  }
  const teams = [...byTeam.keys()]
  const vars = teams.map((_, i) => `$n${i}: [Float!]`)
  const or = teams.map(
    (t, i) =>
      `{ and: [{ team: { key: { eq: ${JSON.stringify(t)} } } }, { number: { in: $n${i} } }] }`,
  )
  const issues =
    teams.length === 0
      ? ''
      : `issues(first: 250, filter: { or: [${or.join(', ')}] }) { nodes { ${FIELDS} } }`
  return {
    query: `query${vars.length ? `(${vars.join(', ')})` : ''} { ${issues}
  viewer { assignedIssues(first: 100, filter: { state: { name: { eq: "In Progress" } } }) { nodes { ${FIELDS} } } } }`,
    variables: Object.fromEntries(teams.map((t, i) => [`n${i}`, byTeam.get(t)!])),
  }
}

type Fetch = (keys: readonly string[]) => Promise<{ issues: LinearIssue[]; started: LinearIssue[] }>

/** No Linear key on this Mac: the board shows Linear as off, not failing. */
class NoLinearKey extends Error {}

const Node = z.object({
  identifier: z.string(),
  title: z.string(),
  url: z.string(),
  updatedAt: z.string(),
  priority: z.number(),
  state: z.object({ name: z.string(), type: z.string() }),
  assignee: z.object({ name: z.string() }).nullable(),
  project: z.object({ name: z.string() }).nullable(),
})
const Nodes = z.object({ nodes: z.array(Node) })
const BatchAnswer = z.object({
  data: z
    .object({ issues: Nodes.optional(), viewer: z.object({ assignedIssues: Nodes }) })
    .nullish(),
  errors: z.array(z.object({ message: z.string() })).optional(),
})

/** The batch with this Mac's Linear key. */
export function localBatch(token: () => Promise<string | null>): Fetch {
  return async (keys) => {
    const key = await token()
    if (!key) throw new NoLinearKey('no Linear key')
    const res = await fetch('https://api.linear.app/graphql', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: key },
      body: JSON.stringify(batchQuery(keys)),
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) throw new Error(`Linear answered ${res.status}`)
    const body = BatchAnswer.parse(await res.json())
    if (body.errors?.length || !body.data) throw new Error(body.errors?.[0]?.message ?? 'no data')
    return {
      issues: (body.data.issues?.nodes ?? []).map(toIssue),
      started: body.data.viewer.assignedIssues.nodes.map(toIssue),
    }
  }
}

/** A thin client: each issue through the host's cached reader; the host does not list Isaac's queue. */
export function hostBatch(read: LinearRead): Fetch {
  return async (keys) => {
    const issues: LinearIssue[] = []
    const queue = [...keys]
    await Promise.all(
      Array.from({ length: HOST_CONCURRENCY }, async () => {
        for (let k = queue.shift(); k !== undefined; k = queue.shift()) {
          const issue = await read(k).catch(() => null)
          if (issue) issues.push(issue)
        }
      }),
    )
    return { issues, started: [] }
  }
}

export function createLinearStates(
  fetchBatch: Fetch | null,
  now: () => number = Date.now,
): LinearStates {
  const issues = new Map<string, LinearIssue>()
  let started: LinearIssue[] = []
  let status: LinearStatus = fetchBatch ? 'loading' : 'off'
  let asked = new Set<string>()
  let lastAt = -Infinity
  let inFlight = false
  const listeners = new Set<() => void>()
  const refresh = (keys: readonly string[]): void => {
    if (!fetchBatch || inFlight) return
    inFlight = true
    lastAt = now()
    asked = new Set(keys)
    fetchBatch(keys)
      .then((r) => {
        for (const i of r.issues) issues.set(i.identifier, i)
        for (const i of r.started) issues.set(i.identifier, i)
        started = r.started
        status = 'ok'
      })
      .catch((e: unknown) => {
        status = e instanceof NoLinearKey ? 'off' : 'error'
      })
      .finally(() => {
        inFlight = false
        for (const cb of listeners) cb()
      })
  }
  return {
    get: (key) => issues.get(key) ?? null,
    started: () => started,
    status: () => status,
    want(keys) {
      if (keys.some((k) => !asked.has(k)) || now() - lastAt > REFRESH_MS) refresh(keys)
    },
    onChange(cb) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
  }
}
