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
    title: z.string().nullish(),
    closedAt: z.string().nullish(),
  }),
)

/** A session an assistant registered: where its transcript is, whatever sessions dir it sits in. */
export interface OwnedFile {
  file: string
  title: string | null
  agent: string
  closed: boolean
}

interface Cached {
  mtimeMs: number
  size: number
  owners: Map<string, ChatOwner>
  files: Map<string, OwnedFile>
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
      for (const [id, owner] of this.of(agent, path.join(dir, agent, 'sessions.json')).owners) {
        if (!out.has(id)) out.set(id, owner)
      }
    }
    return out
  }

  /**
   * The transcript of the session `id` an assistant registered, found in its sessions.json however
   * far the file is from the chat list's sessions dirs (a session started in a project folder
   * lives under that folder's own dir). Null when no assistant registered it.
   */
  fileOf(id: string): OwnedFile | null {
    return this.entries().find((e) => e.id === id)?.owned ?? null
  }

  /** Whether `file` is a transcript an assistant registered (real paths compared). */
  owns(file: string): boolean {
    const real = (p: string): string => {
      try {
        return fs.realpathSync(p)
      } catch {
        return p
      }
    }
    const want = real(file)
    return this.entries().some((e) => real(e.owned.file) === want)
  }

  private entries(): { id: string; owned: OwnedFile }[] {
    const dir = path.join(this.evaRoot, 'work/eva/agents')
    let agents: string[]
    try {
      agents = fs.readdirSync(dir)
    } catch {
      return []
    }
    const out: { id: string; owned: OwnedFile }[] = []
    for (const agent of agents.sort()) {
      const { files } = this.of(agent, path.join(dir, agent, 'sessions.json'))
      for (const [id, owned] of files) out.push({ id, owned })
    }
    return out
  }

  private of(agent: string, file: string): Cached {
    let st: fs.Stats
    try {
      st = fs.statSync(file)
    } catch {
      this.cache.delete(agent)
      return { mtimeMs: 0, size: 0, owners: new Map(), files: new Map() }
    }
    const hit = this.cache.get(agent)
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit
    const owners = new Map<string, ChatOwner>()
    const files = new Map<string, OwnedFile>()
    try {
      const parsed = Entries.safeParse(JSON.parse(fs.readFileSync(file, 'utf8')))
      if (parsed.success) {
        // A session registered twice keeps its last entry.
        for (const e of parsed.data) {
          const id = sessionId(e.sessionFile)
          const closed = Boolean(e.closedAt)
          owners.set(id, { agent, closed })
          files.set(id, { file: e.sessionFile, title: e.title || null, agent, closed })
        }
      }
    } catch {
      // Mid-write or broken: no owners from this assistant until it is valid again.
    }
    const cached = { mtimeMs: st.mtimeMs, size: st.size, owners, files }
    this.cache.set(agent, cached)
    return cached
  }
}
