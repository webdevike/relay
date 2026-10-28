import { readFile } from 'node:fs/promises'
import * as path from 'node:path'
import type { LinearIssue } from '@evaos/contract'
import type { MainContext } from '../context'
import { handle } from '../ipc/handle'

/** How long a fetched issue is reused before the next hover asks Linear again. */
const TTL_MS = 2 * 60_000
const PRIORITY = ['No priority', 'Urgent', 'High', 'Medium', 'Low']

const QUERY = `query($id: String!) { issue(id: $id) {
  identifier title url updatedAt priority
  state { name type } assignee { name } project { name }
} }`

/** `LINEAR_API_KEY`, else `secrets/linear.env` in the Eva root (as EvaOS's linear source). */
async function apiKey(evaRoot: string): Promise<string | null> {
  if (process.env.LINEAR_API_KEY) return process.env.LINEAR_API_KEY
  const text = await readFile(path.join(evaRoot, 'secrets/linear.env'), 'utf8').catch(() => '')
  const m = /^\s*(?:export\s+)?LINEAR_API_KEY\s*=\s*["']?([^"'\s]+)/m.exec(text)
  return m?.[1] ?? null
}

interface Raw {
  identifier: string
  title: string
  url: string
  updatedAt: string
  priority: number
  state: { name: string; type: string }
  assignee: { name: string } | null
  project: { name: string } | null
}

export function toIssue(raw: Raw): LinearIssue {
  return {
    identifier: raw.identifier,
    title: raw.title,
    url: raw.url,
    state: raw.state.name,
    stateType: raw.state.type,
    priority: PRIORITY[raw.priority] ?? 'No priority',
    assignee: raw.assignee?.name ?? null,
    project: raw.project?.name ?? null,
    updatedAt: Date.parse(raw.updatedAt),
  }
}

async function fetchIssue(key: string, token: string): Promise<LinearIssue | null> {
  const res = await fetch('https://api.linear.app/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: token },
    body: JSON.stringify({ query: QUERY, variables: { id: key } }),
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error(`Linear answered ${res.status}`)
  const body = (await res.json()) as {
    data?: { issue: Raw | null } | null
    errors?: { message: string; extensions?: { code?: string } }[]
  }
  // An unknown identifier comes back as an "Entity not found" error, not a null issue.
  const notFound = body.errors?.some((e) => /not found/i.test(e.message)) ?? false
  if (body.errors?.length && !notFound) throw new Error(body.errors[0]!.message)
  return body.data?.issue ? toIssue(body.data.issue) : null
}

/** One issue by key, cached briefly; throws `no-linear-key` without an API key. */
export type LinearRead = (key: string) => Promise<LinearIssue | null>

/** Reads issues for the ticket badge card and the Artifacts status reader, through one cache. */
export function linearReader(evaRoot: string): LinearRead {
  const cache = new Map<string, { at: number; issue: Promise<LinearIssue | null> }>()
  return async (key) => {
    const hit = cache.get(key)
    if (hit && Date.now() - hit.at < TTL_MS) return hit.issue
    const token = await apiKey(evaRoot)
    if (!token) {
      throw Object.assign(new Error('No Linear API key (LINEAR_API_KEY or secrets/linear.env)'), {
        code: 'no-linear-key',
      })
    }
    const issue = fetchIssue(key, token)
    cache.set(key, { at: Date.now(), issue })
    // A failure is not cached: the next read retries.
    issue.catch(() => cache.delete(key))
    return issue
  }
}

/** The chat list's ticket badge card: one issue by key, fetched on hover. */
export function registerLinearIpc(ctx: MainContext, read: LinearRead): void {
  handle(ctx, 'linear.issue', ({ key }) => read(key))
}
