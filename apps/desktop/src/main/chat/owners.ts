// Which assistant started a session: each assistant records the sessions it starts (auto-work,
// delegated project work) in `work/eva/agents/<id>/sessions.json` (.omp/tools/eva-project.ts
// registerSession), and marks one `closedAt` once its job no longer needs it (closeSession).
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { ChatOwner } from '@evaos/contract'
import { sessionId } from '@evaos/chat-core/session-id'
import { z } from 'zod'

const Entries = z.array(
  z.object({
    sessionFile: z.string(),
    closedAt: z.string().nullish(),
  }),
)

interface Cached {
  mtimeMs: number
  size: number
  owners: Map<string, ChatOwner>
}

/** Session id to owner across every assistant's sessions.json, re-read only when one changes. */
export class SessionOwners {
  private readonly cache = new Map<string, Cached>()

  constructor(private readonly evaRoot: string) {}

  current(): ReadonlyMap<string, ChatOwner> {
    const dir = path.join(this.evaRoot, 'work/eva/agents')
    let agents: string[]
    try {
      agents = fs.readdirSync(dir)
    } catch {
      return new Map()
    }
    const out = new Map<string, ChatOwner>()
    for (const agent of agents.sort()) {
      for (const [id, owner] of this.of(agent, path.join(dir, agent, 'sessions.json'))) {
        if (!out.has(id)) out.set(id, owner)
      }
    }
    return out
  }

  private of(agent: string, file: string): Map<string, ChatOwner> {
    let st: fs.Stats
    try {
      st = fs.statSync(file)
    } catch {
      this.cache.delete(agent)
      return new Map()
    }
    const hit = this.cache.get(agent)
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.owners
    const owners = new Map<string, ChatOwner>()
    try {
      const parsed = Entries.safeParse(JSON.parse(fs.readFileSync(file, 'utf8')))
      if (parsed.success) {
        // A session registered twice keeps its last entry.
        for (const e of parsed.data) {
          owners.set(sessionId(e.sessionFile), { agent, closed: Boolean(e.closedAt) })
        }
      }
    } catch {
      // Mid-write or broken: no owners from this assistant until it is valid again.
    }
    this.cache.set(agent, { mtimeMs: st.mtimeMs, size: st.size, owners })
    return owners
  }
}
