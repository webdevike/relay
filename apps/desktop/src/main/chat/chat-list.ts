import * as fs from 'node:fs'
import * as path from 'node:path'
import type { ChatList, ChatPrefs, ChatRow } from '@evaos/contract'
import { CHAT_AGENTS } from '@evaos/chat-core/agent'
import { isRecentlyActive } from '@evaos/chat-core/chat-groups'
import { sessionId } from '@evaos/chat-core/session-id'
import { sessionsDirs } from '@evaos/chat-core/sessions-dir'
import { rowStatus } from '@evaos/chat-core/status'
import { resolveWorkLine, type Place, type WorkLink } from '@evaos/chat-core/work'
import type { ConfigStore } from '../config-store'
import type { Env } from '../env'
import { awayOf } from '../relay/away'
import type { RelaySession } from '../relay/feed'
import { ChatOrder, DAY_MS, type Look, type Phase } from './chat-order'
import { SessionScanner, type ReadFrom, type SessionFacts } from './session-scan'
import { WorkLedgers, gitBranch, keepsWorktree } from './work-line'

export const LIST_ERROR =
  'Could not read your chats. Check that the sessions folder exists, then reload.'

const CHAT_FILE = 'chat.json'

/**
 * The sessions dirs the chat list spans. Live: the app's own dir first, then every omp store's
 * dir for the Eva root (native sessions_dirs), each once. Fixtures and e2e: the fixture dir only.
 */
export function chatSessionsDirs(
  env: Pick<Env, 'live' | 'sessionsDir' | 'evaRoot' | 'agentDir'>,
): string[] {
  if (!env.live) return [env.sessionsDir]
  const real = (p: string): string => {
    try {
      return fs.realpathSync(p)
    } catch {
      return p
    }
  }
  const out: string[] = []
  const seen = new Set<string>()
  for (const dir of [env.sessionsDir, ...sessionsDirs(env.evaRoot, env.agentDir)]) {
    const key = real(dir)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(dir)
  }
  return out
}

export interface ChatListDeps {
  /** Every sessions dir the list spans (`chatSessionsDirs`). */
  sessionsDirs: readonly string[]
  /** omp's agent dir: `session-pins.json`. */
  agentDir: string
  /** The Eva checkout: `work/items` ledgers for the work line. */
  evaRoot: string
  config: ConfigStore
  /** Idle days before a chat auto-settles into `archived_chats`; null turns it off. */
  autoSettleDays?: number | null
  /** `~` for tool-call paths. */
  home?: string | null
  now?: () => number
  /** Session files this app owns a live process for. */
  liveFiles?: () => ReadonlySet<string>
  /** Live state of a session file this app owns, else null. */
  liveStatus?: (file: string) => { working: boolean; dialog: 'confirm' | 'other' | null } | null
  /**
   * Relay's sessions by id while it is connected, else null. While connected, Relay alone says
   * which chats outside this app run; while it is not, a chat written in the last ten minutes does.
   */
  relay?: () => ReadonlyMap<string, RelaySession> | null
  /** Test seam: how a session file's bytes are read. */
  readFrom?: ReadFrom
}

/** Mirrors `SessionIdSchema` in the contract. */
export const SESSION_ID_RE = /^[A-Za-z0-9._-]{1,128}$/

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []

/** Adds `ids` to chat.json `archived_chats` (sorted); every other key survives. */
function settle(config: ConfigStore, ids: readonly string[]): void {
  const existing = config.readForMerge(CHAT_FILE)
  const set = new Set(strings(existing.archived_chats))
  for (const id of ids) set.add(id)
  config.writeJson(CHAT_FILE, { ...existing, archived_chats: [...set].sort() })
}

interface Found {
  file: string
  st: fs.Stats
}

/**
 * Every omp session across the sessions dirs as list rows, with the raw facts the renderer's
 * look needs: agent, work, return-time order, snoozes. Session files are scanned incrementally
 * (cached by mtime and size); the order persists in chat-order.json.
 */
export class ChatListService {
  /** Titles set by a rename until the file changes (the running omp may not have written it yet). */
  private overrides = new Map<string, { title: string; mtimeMs: number; size: number }>()
  /** Each listed chat's session file mtime, by id, as of the last list. */
  private updated = new Map<string, number>()
  /** Chats waiting on Isaac at the last list (they cannot be snoozed). */
  private blocked = new Set<string>()
  /** Relay was connected at the last list. */
  private relayWasUp = false
  private readonly now: () => number
  private readonly liveFiles: () => ReadonlySet<string>
  private readonly scanner: SessionScanner
  private readonly ledgers: WorkLedgers
  private readonly order: ChatOrder

  constructor(private readonly deps: ChatListDeps) {
    this.now = deps.now ?? Date.now
    this.liveFiles = deps.liveFiles ?? (() => new Set())
    this.scanner = new SessionScanner(deps.home ?? null, deps.readFrom)
    this.ledgers = new WorkLedgers(deps.evaRoot)
    this.order = new ChatOrder(deps.config)
  }

  /** Reads `file` again on the next list (its header at least), or every file. */
  invalidate(file?: string): void {
    if (file === undefined) this.scanner.clear()
    else this.scanner.stale(file)
  }

  /** Shows `title` for `file` until its mtime or size changes. */
  setTitle(file: string, title: string): void {
    try {
      const st = fs.statSync(file)
      this.overrides.set(file, { title, mtimeMs: st.mtimeMs, size: st.size })
    } catch {
      this.overrides.delete(file)
    }
  }

  /** Marks chat `id` read now (native mark_read; also clears its Woke mark). True when that changed anything. */
  markRead(id: string): boolean {
    const at = this.now()
    return this.order.markRead(id, this.updated.get(id) ?? at, at)
  }

  /** Snoozes chat `id` until `untilMs`, or ends its snooze (null). A chat waiting on Isaac cannot be snoozed. */
  snooze(id: string, untilMs: number | null): void {
    if (untilMs === null) return this.order.unsnooze(id)
    if (this.blocked.has(id)) throw new Error('This chat is waiting on you. Answer it first.')
    this.order.snooze(id, untilMs, this.now())
  }

  /** Isaac took chat `id` out of Settled: counts as activity (native keep_unarchived). */
  keep(id: string): void {
    this.order.keep(id, this.now())
  }

  /** Drops a deleted chat's order marks. */
  forget(id: string): void {
    this.order.forget(id)
  }

  private prefs(): { prefs: ChatPrefs; archived: Set<string> } {
    const raw = this.deps.config.readJson<unknown>(CHAT_FILE, {})
    const src = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
    const assignedRaw = src.chat_assignments
    const chat_assignments: Record<string, string> = {}
    if (typeof assignedRaw === 'object' && assignedRaw !== null && !Array.isArray(assignedRaw)) {
      for (const [id, name] of Object.entries(assignedRaw)) {
        // Same predicates as ChatPrefsSchema, so one legacy entry cannot fail list or category saves.
        if (typeof name === 'string' && name.length <= 120 && SESSION_ID_RE.test(id)) {
          chat_assignments[id] = name
        }
      }
    }
    const agent = CHAT_AGENTS.find((a) => a === src.chat_agent)
    return {
      prefs: {
        chat_categories: strings(src.chat_categories),
        chat_group_order: strings(src.chat_group_order),
        chat_assignments,
        collapsed_groups: strings(src.collapsed_groups),
        chat_agent: agent ?? 'Eva',
      },
      archived: new Set(strings(src.archived_chats)),
    }
  }

  private pins(): Set<string> {
    try {
      const v: unknown = JSON.parse(
        fs.readFileSync(path.join(this.deps.agentDir, 'session-pins.json'), 'utf8'),
      )
      return new Set(strings(v))
    } catch {
      return new Set()
    }
  }

  /** Every session file across the dirs, one per session id (the newest when a copy exists). */
  private files(): Map<string, Found> | null {
    const byId = new Map<string, Found>()
    let readable = false
    for (const dir of this.deps.sessionsDirs) {
      let names: string[]
      try {
        names = fs.readdirSync(dir)
      } catch {
        continue
      }
      readable = true
      for (const name of names) {
        if (!name.endsWith('.jsonl')) continue
        const file = path.join(dir, name)
        let st: fs.Stats
        try {
          st = fs.statSync(file)
        } catch {
          continue
        }
        if (!st.isFile()) continue
        const id = sessionId(file)
        const prev = byId.get(id)
        if (!prev || st.mtimeMs > prev.st.mtimeMs) byId.set(id, { file, st })
      }
    }
    return readable ? byId : null
  }

  list(): ChatList {
    const { prefs, archived } = this.prefs()
    const found = this.files()
    if (found === null) return { rows: [], prefs, error: LIST_ERROR }
    const pins = this.pins()
    const live = this.liveFiles()
    const relay = this.deps.relay?.() ?? null
    const relayHeld = relay !== null && this.relayWasUp
    this.relayWasUp = relay !== null
    const now = this.now()
    const work = this.ledgers.current()
    const place = new PlaceReader(work)
    const seen = new Set<string>()
    const rows: ChatRow[] = []
    const looks: Look[] = []
    this.blocked.clear()
    this.updated.clear()
    for (const [id, { file, st }] of found) {
      seen.add(file)
      const f = this.scanner.facts(file, st)
      const owned = this.deps.liveStatus?.(file) ?? null
      const isLive = live.has(file) || owned !== null
      let title = f.lastTitle ?? f.headTitle ?? f.prompt
      const ov = this.overrides.get(file)
      if (ov) {
        if (ov.mtimeMs === st.mtimeMs && ov.size === st.size) title = ov.title
        else this.overrides.delete(file)
      }
      // Native lists no chat without a title or a prompt yet, unless this app is running it.
      if (title === null && !isLive) continue
      // This app's own process first, then Relay (native `away`), then, only while Relay is
      // unreachable, a session file written in the last ten minutes.
      const away = isLive || relay === null ? null : awayOf(relay.get(id))
      const running =
        isLive || away !== null || (relay === null && isRecentlyActive(st.mtimeMs, now))
      const phase: Phase | null = owned
        ? owned.dialog !== null
          ? 'blocked'
          : owned.working
            ? 'working'
            : 'idle'
        : away
          ? away.phase
          : running
            ? f.turnOpen
              ? 'working'
              : 'idle'
            : null
      const status = rowStatus({
        owned: owned !== null,
        working: away ? away.working : phase === 'working',
        dialog: owned?.dialog ?? away?.dialog ?? null,
        jobs: f.jobs.length,
        job: away?.job ?? false,
      })
      // Only an approval or a question blocks a snooze (native needs_you_at).
      if (status === 'needs-approval' || status === 'has-question') this.blocked.add(id)
      this.updated.set(id, st.mtimeMs)
      looks.push({
        id,
        updated: st.mtimeMs,
        phase,
        owned: owned !== null,
        relay: away !== null,
        running,
        pinned: pins.has(id),
        archived: archived.has(id),
        sent: f.lastSentMs ?? f.createdMs,
      })
      const shown = title || id
      rows.push({
        id,
        file,
        title: shown,
        mtimeMs: st.mtimeMs,
        archived: archived.has(id),
        pinned: pins.has(id),
        running,
        status,
        agent: f.agent,
        workedIn: f.workedIn,
        work: resolveWorkLine(place.of(f), shown, work),
        model: f.model,
        jobs: f.jobs.length,
        failed: f.failed,
        returnedMs: st.mtimeMs,
        openedMs: null,
        keptMs: null,
        snoozedUntilMs: null,
        wokeMs: null,
        startedMs: null,
      })
    }
    this.scanner.retain(seen)
    for (const file of this.overrides.keys()) if (!seen.has(file)) this.overrides.delete(file)

    const days = this.deps.autoSettleDays
    const due = this.order.track(looks, now, days == null ? null : days * DAY_MS, relayHeld)
    if (due.length > 0) {
      settle(this.deps.config, due)
      for (const id of due) archived.add(id)
    }
    for (const row of rows) {
      row.archived = archived.has(row.id)
      row.returnedMs = this.order.returned(row.id, row.mtimeMs)
      row.openedMs = this.order.opened(row.id)
      row.keptMs = this.order.kept(row.id)
      row.snoozedUntilMs = this.order.wakes(row.id)
      row.wokeMs = this.order.woke(row.id)
      row.startedMs = this.order.started(row.id)
    }
    rows.sort((a, b) => b.mtimeMs - a.mtimeMs || a.file.localeCompare(b.file))
    return { rows, prefs, error: null }
  }
}

/** A session's place (folder, active worktree, their branches), with fs reads shared across one list. */
class PlaceReader {
  private readonly branches = new Map<string, string | null>()
  private readonly kept = new Map<string, boolean>()
  private readonly evaDirs = new Map<string, boolean>()

  constructor(private readonly work: readonly WorkLink[]) {}

  private branch(dir: string): string | null {
    let b = this.branches.get(dir)
    if (b === undefined) {
      b = gitBranch(dir)
      this.branches.set(dir, b)
    }
    return b
  }

  of(f: SessionFacts): Place {
    let active: string | null = null
    for (let i = f.worktrees.length - 1; i >= 0 && active === null; i--) {
      const dir = f.worktrees[i]!
      let keep = this.kept.get(dir)
      if (keep === undefined) {
        keep = keepsWorktree(dir, this.work)
        this.kept.set(dir, keep)
      }
      if (keep) active = dir
    }
    // A cleaned-up worktree has no branch (not the Eva checkout's around where it was).
    const activeBranch =
      active !== null && fs.existsSync(path.join(active, '.git')) ? this.branch(active) : null
    let eva = false
    if (f.cwd !== null) {
      const cached = this.evaDirs.get(f.cwd)
      if (cached === undefined) {
        try {
          eva = fs.statSync(path.join(f.cwd, 'work/items')).isDirectory()
        } catch {
          eva = false
        }
        this.evaDirs.set(f.cwd, eva)
      } else eva = cached
    }
    return {
      cwd: f.cwd,
      active,
      activeBranch,
      cwdBranch: f.cwd === null ? null : this.branch(f.cwd),
      eva,
    }
  }
}
