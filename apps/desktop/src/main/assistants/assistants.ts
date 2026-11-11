// The Assistants area's data, ported from native EvaOS (eva::load_agents, assistants_view.rs,
// relay::assistant_session): the registry's agents, each with where its thread stands as Relay
// reports it and its last reply as its session file records it.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { z } from 'zod'
import {
  AssistantPortraitSchema,
  type Assistant,
  type AssistantPortrait,
  type AssistantStatus,
  type Assistants,
} from '@evaos/contract'
import { oneLine } from '@evaos/chat-core/session'
import { isNothingToReport } from '@evaos/chat-core/quiet'
import { stripComputerPlan } from '@evaos/chat-core/computer-plan'
import { sessionId } from '@evaos/chat-core/session-id'
import type { RelaySession } from '../relay/feed'
import { ASK_TOOL } from '../relay/away'

/** The registry, relative to the Eva root. */
export const REGISTRY_FILE = '.omp/assistant/agents.json'

/** How much of the end of a session file is searched for the last reply. */
export const TAIL_BYTES = 256 * 1024

/** Characters of a reply kept for its one-line preview. */
export const PREVIEW_CHARS = 200

export interface Agent {
  id: string
  title: string
  /** Empty when the registry gives none. */
  scope: string
  /** The portrait: the registry's designed one, else notionists from its seed, else from the id. */
  avatar: AssistantPortrait
  /** The omp model its session starts on (`provider/id`, maybe `:thinking`), when the registry names one. */
  model?: string
}

const AgentSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  scope: z.string().optional().catch(undefined),
  /** A notionists seed, or a designed portrait; anything else draws the id's notionists face. */
  avatar: z.union([z.string(), AssistantPortraitSchema]).optional().catch(undefined),
  model: z.string().trim().min(1).optional().catch(undefined),
})

/** Longest registry id the host takes. */
const MAX_ID = 32

/**
 * `Drive Buddy` -> `drive-buddy`: the registry id Relay Host makes from a new assistant's name
 * (apps/linux/src/assistant/admin.ts `idFromTitle`; keep the two in step). Empty when nothing usable is left.
 */
export function assistantIdFrom(title: string): string {
  const slug = title
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_ID)
    .replace(/-+$/, '')
  return slug === '' ? '' : /^[a-z]/.test(slug) ? slug : `a-${slug}`.slice(0, MAX_ID)
}

/** The registry's agents in file order; empty when it is missing or unreadable (native load_agents). */
export function parseRegistry(text: string): Agent[] {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return []
  }
  const agents = (raw as { agents?: unknown } | null)?.agents
  if (!Array.isArray(agents)) return []
  const out: Agent[] = []
  for (const a of agents) {
    const r = AgentSchema.safeParse(a)
    if (!r.success) continue
    const { id, title, scope, avatar, model } = r.data
    const seed = typeof avatar === 'string' ? avatar.trim() || id : id
    out.push({
      id,
      title,
      scope: scope ?? '',
      avatar: typeof avatar === 'object' ? avatar : { style: 'notionists', seed },
      ...(model ? { model } : {}),
    })
  }
  return out
}

const HostAgentSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  scope: z.string().optional().catch(undefined),
  /** A notionists seed; `portrait`, when there is one, is drawn instead. */
  avatar: z.string().optional().catch(undefined),
  portrait: AssistantPortraitSchema.optional().catch(undefined),
})

/** The host's `assistant.agents` list as the registry's agents; null when it is not a list. */
export function parseHostAgents(raw: unknown): Agent[] | null {
  if (!Array.isArray(raw)) return null
  return raw.flatMap((a) => {
    const r = HostAgentSchema.safeParse(a)
    if (!r.success) return []
    const { id, title, scope, avatar, portrait } = r.data
    return [
      {
        id,
        title,
        scope: scope ?? '',
        avatar: portrait ?? { style: 'notionists' as const, seed: avatar?.trim() || id },
      },
    ]
  })
}

/** The session Relay lists for agent `agent`'s thread, if any (native relay::assistant_session). */
export function assistantSession(
  sessions: ReadonlyMap<string, RelaySession> | null,
  agent: string,
): RelaySession | undefined {
  if (sessions === null) return undefined
  for (const s of sessions.values()) if (s.kind === 'assistant' && s.assistant === agent) return s
  return undefined
}

/**
 * Where a thread stands: no session is Not started, working is Working, a question or an
 * approval is Needs you, anything else Idle (native assistants_view::Status::of). omp's `ask` tool
 * blocks while Relay still says `working` (its detail `ask`): that thread waits on Isaac too.
 */
export function statusOf(session: RelaySession | undefined): AssistantStatus {
  switch (session?.status) {
    case undefined:
      return 'not-started'
    case 'working':
      return session.detail === ASK_TOOL ? 'needs-you' : 'working'
    case 'waiting':
    case 'needs_permission':
      return 'needs-you'
    case 'idle':
    case 'ended':
      return 'idle'
  }
}

export interface Reply {
  text: string
  /** When omp wrote it, epoch ms; null when its record has no readable timestamp. */
  at: number | null
}

/**
 * The newest assistant message in `tail` that has text, newest last in the file. Turns that only
 * called tools have none and are skipped (native assistants_view::last_reply), and so are
 * background turns answered "(nothing to report)".
 */
export function lastReply(tail: string): Reply | null {
  const lines = tail.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!
    if (!line.includes('"role":"assistant"')) continue
    let record: {
      type?: unknown
      timestamp?: unknown
      message?: { role?: unknown; content?: unknown }
    }
    try {
      record = JSON.parse(line)
    } catch {
      continue
    }
    if (record?.type !== 'message' || record.message?.role !== 'assistant') continue
    const content = record.message.content
    let text: string
    if (typeof content === 'string') text = content
    else if (Array.isArray(content))
      text = content
        .filter(
          (b): b is { type: 'text'; text: string } =>
            typeof b === 'object' && b !== null && b.type === 'text' && typeof b.text === 'string',
        )
        .map((b) => b.text)
        .join(' ')
    else continue
    const one = oneLine(stripComputerPlan(text), PREVIEW_CHARS)
    if (one === '' || isNothingToReport(one)) continue
    const ms = typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : NaN
    return { text: one, at: Number.isNaN(ms) ? null : ms }
  }
  return null
}

/** The last `TAIL_BYTES` of `file`, from the start of its first whole line; null when unreadable. */
export function readTail(file: string, bytes = TAIL_BYTES): string | null {
  let fd: number
  try {
    fd = fs.openSync(file, 'r')
  } catch {
    return null
  }
  try {
    const size = fs.fstatSync(fd).size
    const start = Math.max(0, size - bytes)
    const buf = Buffer.alloc(size - start)
    let read = 0
    while (read < buf.length) {
      const n = fs.readSync(fd, buf, read, buf.length - read, start + read)
      if (n === 0) break
      read += n
    }
    const text = buf.subarray(0, read).toString('utf8')
    if (start === 0) return text
    const cut = text.indexOf('\n')
    return cut < 0 ? '' : text.slice(cut + 1)
  } catch {
    return null
  } finally {
    fs.closeSync(fd)
  }
}

export interface AssistantsDeps {
  evaRoot: string
  /** Every sessions dir the chat list spans; assistant threads live in Eva's. */
  sessionsDirs: readonly string[]
  /** Relay's sessions by id while connected, else null. */
  relay: () => ReadonlyMap<string, RelaySession> | null
  /**
   * A thin client's registry: the agents the Mini's Relay Host lists (`assistant.agents`), null
   * until it has answered (the Eva root's file stands in meanwhile). Absent on the Mini itself.
   */
  hostAgents?: () => Agent[] | null
}

/**
 * The registry's agents with their threads. The registry is reread when its file changes; a
 * session file's last reply is reread only when the file does (native reply_of's cache).
 */
export class AssistantsService {
  private registry: { mtimeMs: number; agents: Agent[] } | null = null
  private readonly files = new Map<string, string>()
  private readonly replies = new Map<
    string,
    { mtimeMs: number; size: number; reply: Reply | null }
  >()

  constructor(private readonly deps: AssistantsDeps) {}

  agents(): Agent[] {
    const hosted = this.deps.hostAgents?.()
    if (hosted) return hosted
    const file = path.join(this.deps.evaRoot, REGISTRY_FILE)
    let mtimeMs: number
    try {
      mtimeMs = fs.statSync(file).mtimeMs
    } catch {
      this.registry = null
      return []
    }
    if (this.registry?.mtimeMs !== mtimeMs) {
      let text = ''
      try {
        text = fs.readFileSync(file, 'utf8')
      } catch {
        // Unreadable reads as empty, like native.
      }
      this.registry = { mtimeMs, agents: parseRegistry(text) }
    }
    return this.registry.agents
  }

  list(): Assistants {
    const sessions = this.deps.relay()
    const agents: Assistant[] = this.agents().map((agent) => {
      const session = assistantSession(sessions, agent.id)
      const file = session ? this.fileOf(session.id) : null
      const status = statusOf(session)
      return {
        id: agent.id,
        title: agent.title,
        scope: agent.scope,
        avatar: agent.avatar,
        ...(agent.model ? { model: agent.model } : {}),
        status,
        // Relay's detail is the running tool while it works (an open `ask` already reads Needs you).
        tool: status === 'working' ? (session?.detail ?? null) : null,
        file,
        reply: file ? this.replyOf(file) : null,
      }
    })
    return { agents, relayUp: sessions !== null }
  }

  /** The session file for omp session `id`, newest when several dirs hold one. */
  private fileOf(id: string): string | null {
    const known = this.files.get(id)
    if (known !== undefined && fs.existsSync(known)) return known
    let best: { file: string; mtimeMs: number } | null = null
    for (const dir of this.deps.sessionsDirs) {
      let names: string[]
      try {
        names = fs.readdirSync(dir)
      } catch {
        continue
      }
      for (const name of names) {
        if (!name.endsWith('.jsonl') || sessionId(name) !== id) continue
        const file = path.join(dir, name)
        try {
          const mtimeMs = fs.statSync(file).mtimeMs
          if (!best || mtimeMs > best.mtimeMs) best = { file, mtimeMs }
        } catch {
          // Gone between the listing and the stat.
        }
      }
    }
    if (best === null) {
      this.files.delete(id)
      return null
    }
    this.files.set(id, best.file)
    return best.file
  }

  private replyOf(file: string): Reply | null {
    let st: fs.Stats
    try {
      st = fs.statSync(file)
    } catch {
      this.replies.delete(file)
      return null
    }
    const seen = this.replies.get(file)
    if (seen && seen.mtimeMs === st.mtimeMs && seen.size === st.size) return seen.reply
    const tail = readTail(file)
    const reply = tail === null ? null : lastReply(tail)
    this.replies.set(file, { mtimeMs: st.mtimeMs, size: st.size, reply })
    return reply
  }
}
