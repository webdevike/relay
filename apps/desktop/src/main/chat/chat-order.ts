// The chat list's order, ported from the native app's chat_view/order.rs and sections.rs.
//
// - Return time: the latest moment a chat came back to Isaac: it finished replying (working,
//   then idle), started needing him (an approval or a question), died while working or blocked,
//   or was created. More output while it replies does not move it. The first look only records a
//   baseline (its file's time); a chat with no process returns when its file was written last.
// - Read: opened at or after its return.
// - Auto-settle: a chat with no process, not pinned or snoozed, idle for the auto-settle days
//   moves under Settled (chat.json `archived_chats`). Unsettling records `kept`, which counts as
//   activity.
// - Snoozes wake when their time passes, or early once the chat returns after the snooze was set
//   or needs Isaac; a woken chat keeps a Woke mark until it is opened.
//
// Return, read, kept, snooze and Woke times persist in `chat-order.json` (native keys, epoch ms);
// other keys in that file survive a save.
import type { ConfigStore } from '../config-store'

export const ORDER_FILE = 'chat-order.json'
/** Native inbox default `auto_settle_days`. */
export const AUTO_SETTLE_DAYS = 3
export const DAY_MS = 24 * 3600 * 1000

/** What a chat is doing, as the order sees it. */
export type Phase = 'idle' | 'working' | 'blocked' | 'ended'

export interface Snooze {
  until: number
  at: number
}

function returns(prev: Phase, now: Phase): boolean {
  switch (now) {
    case 'idle':
      return prev === 'working'
    case 'blocked':
      return prev !== 'blocked'
    case 'ended':
      return prev === 'working' || prev === 'blocked'
    case 'working':
      return false
  }
}

/**
 * The return time after one look. A change into idle from working, into blocked, or into ended
 * from working or blocked is a return at `at`. Nothing else moves a chat seen running; the first
 * look keeps what was saved (the file's time for a new chat) unless the chat sits idle, blocked
 * or ended and its file was written since. A chat seen with no process returns at its file time.
 */
export function nextReturn(
  stored: number | null,
  prev: Phase | null,
  now: Phase | null,
  updated: number,
  at: number,
): number {
  const caughtUp = stored === null ? updated : Math.max(stored, updated)
  const kept = stored ?? updated
  if (now === null) return caughtUp
  if (prev === null) return now === 'working' ? kept : caughtUp
  return returns(prev, now) ? at : kept
}

/**
 * When a chat's current run started: kept while it keeps working; on starting to work, `at`, or
 * Isaac's last message (`sent`) when it was already working at its first look; null once it stops.
 */
export function runStart(
  stored: number | null,
  prev: Phase | null,
  now: Phase | null,
  sent: number | null,
  at: number,
): number | null {
  if (now !== 'working') return null
  if (prev === 'working') return stored ?? at
  if (prev === null) return stored ?? sent ?? at
  return at
}

/** Opened at or after its return. */
export function isRead(opened: number | null, returned: number): boolean {
  return opened !== null && opened >= returned
}

/** Whether a chat should move under Settled: no process, not pinned or settled, idle for `afterMs`. */
export function archiveDue(
  last: number,
  running: boolean,
  pinned: boolean,
  archived: boolean,
  now: number,
  afterMs: number | null,
): boolean {
  return afterMs !== null && !running && !pinned && !archived && now - last >= afterMs
}

/** Whether `snooze` ends now: early when the chat needs Isaac or returned after it was set, else on time. */
export function wake(
  snooze: Snooze,
  returned: number,
  needsYou: boolean,
  now: number,
): 'early' | 'timer' | null {
  if (needsYou || returned > snooze.at) return 'early'
  return now >= snooze.until ? 'timer' : null
}

/** One chat at one look. */
export interface Look {
  id: string
  /** Its session file's mtime. */
  updated: number
  /** Its phase now when seen running (an owned process, Relay, or a recently written file), else null. */
  phase: Phase | null
  /** This app owns its process: if that process goes away mid-run, the chat ended. */
  owned: boolean
  /** The phase is Relay's: if Relay stops listing it mid-run while staying connected, it ended. */
  relay: boolean
  running: boolean
  pinned: boolean
  archived: boolean
  /** Isaac's last message in the session, else its creation, for a run seen already working. */
  sent: number | null
}

const isMs = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0

function times(v: unknown): Map<string, number> {
  const out = new Map<string, number>()
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return out
  for (const [id, at] of Object.entries(v)) if (isMs(at)) out.set(id, at)
  return out
}

function snoozes(v: unknown): Map<string, Snooze> {
  const out = new Map<string, Snooze>()
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return out
  for (const [id, s] of Object.entries(v)) {
    if (typeof s !== 'object' || s === null) continue
    const { until, at } = s as Record<string, unknown>
    if (isMs(until) && isMs(at)) out.set(id, { until, at })
  }
  return out
}

/** Return, read, kept, snooze and Woke times by session id, plus the in-memory run starts and phases. */
export class ChatOrder {
  private readonly returnedAt: Map<string, number>
  private readonly openedAt: Map<string, number>
  private readonly keptAt: Map<string, number>
  private readonly snoozed: Map<string, Snooze>
  private readonly wokeAt: Map<string, number>
  /** When each chat's current run started, while it works (not saved). */
  private readonly startedAt = new Map<string, number>()
  /** Each chat's phase at the last look, while seen running (not saved). */
  private readonly phases = new Map<string, { phase: Phase; owned: boolean; relay: boolean }>()
  private dirty = false

  constructor(private readonly config: ConfigStore) {
    const raw = config.readJson<unknown>(ORDER_FILE, {})
    const doc = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
    this.returnedAt = times(doc.returned)
    this.openedAt = times(doc.opened)
    this.keptAt = times(doc.kept)
    this.snoozed = snoozes(doc.snoozed)
    this.wokeAt = times(doc.woke)
  }

  /** The chat's return time; a chat never looked at falls back to its file's time. */
  returned(id: string, updated: number): number {
    return this.returnedAt.get(id) ?? updated
  }
  opened(id: string): number | null {
    return this.openedAt.get(id) ?? null
  }
  kept(id: string): number | null {
    return this.keptAt.get(id) ?? null
  }
  /** When its snooze ends, while snoozed. */
  wakes(id: string): number | null {
    return this.snoozed.get(id)?.until ?? null
  }
  woke(id: string): number | null {
    return this.wokeAt.get(id) ?? null
  }
  started(id: string): number | null {
    return this.startedAt.get(id) ?? null
  }

  private set(map: Map<string, number>, id: string, at: number): void {
    if (map.get(id) === at) return
    map.set(id, at)
    this.dirty = true
  }

  /**
   * Folds one look at every chat into the order: return times, run starts, due wakes, and returns
   * the ids due to auto-settle after `autoSettleMs` (null: off). `relayHeld`: Relay was connected
   * at the last look and still is (native take_alerts `up && was_up`). Saves when anything changed.
   */
  track(
    looks: readonly Look[],
    at: number,
    autoSettleMs: number | null,
    relayHeld = false,
  ): string[] {
    const archive: string[] = []
    const ids = new Set<string>()
    for (const look of looks) {
      const { id } = look
      ids.add(id)
      const before = this.phases.get(id) ?? null
      let now = look.phase
      // An owned process that went away mid-run ended the chat; so did a session Relay stopped
      // listing (or listed as ended) while it stayed connected. A dropped connection is no end.
      if (
        now === null &&
        (before?.owned || (before?.relay && relayHeld)) &&
        (before.phase === 'working' || before.phase === 'blocked')
      ) {
        now = 'ended'
      }
      const prev = now === null ? null : (before?.phase ?? null)
      this.set(
        this.returnedAt,
        id,
        nextReturn(this.returnedAt.get(id) ?? null, prev, now, look.updated, at),
      )
      // An owned process is one this app just started, so a run first seen working starts now; the
      // file's last prompt may not be written yet. Only a run found outside counts from `sent`.
      const sent = look.owned ? null : look.sent
      const start = runStart(this.startedAt.get(id) ?? null, prev, now, sent, at)
      if (start === null) this.startedAt.delete(id)
      else this.startedAt.set(id, start)
      if (look.phase === null) this.phases.delete(id)
      else this.phases.set(id, { phase: look.phase, owned: look.owned, relay: look.relay })

      const returned = this.returned(id, look.updated)
      const snooze = this.snoozed.get(id)
      if (snooze && wake(snooze, returned, now === 'blocked', at) !== null) {
        this.snoozed.delete(id)
        this.wokeAt.set(id, at)
        this.dirty = true
      }
      const last = Math.max(
        look.updated,
        returned,
        this.keptAt.get(id) ?? 0,
        this.wokeAt.get(id) ?? 0,
      )
      if (
        !this.snoozed.has(id) &&
        archiveDue(last, look.running, look.pinned, look.archived, at, autoSettleMs)
      ) {
        archive.push(id)
      }
    }
    for (const id of [...this.phases.keys()]) if (!ids.has(id)) this.phases.delete(id)
    for (const id of [...this.startedAt.keys()]) if (!ids.has(id)) this.startedAt.delete(id)
    this.save()
    return archive
  }

  /**
   * Marks chat `id` read now if it came back since it was last read; opening clears a Woke mark.
   * True when that changed anything.
   */
  markRead(id: string, updated: number, at: number): boolean {
    if (this.wokeAt.delete(id)) this.dirty = true
    if (!isRead(this.opened(id), this.returned(id, updated))) this.set(this.openedAt, id, at)
    const changed = this.dirty
    this.save()
    return changed
  }

  /** Isaac took chat `id` out of Settled: it counts as activity for auto-settle and fast settle. */
  keep(id: string, at: number): void {
    this.set(this.keptAt, id, at)
    this.save()
  }

  /** Snoozes chat `id` until `until`, replacing a snooze and clearing a Woke mark. */
  snooze(id: string, until: number, at: number): void {
    this.snoozed.set(id, { until, at })
    this.wokeAt.delete(id)
    this.dirty = true
    this.save()
  }

  /** Ends chat `id`'s snooze by hand: no Woke mark. */
  unsnooze(id: string): void {
    if (this.snoozed.delete(id)) this.dirty = true
    this.save()
  }

  /** Drops every mark of a deleted chat. */
  forget(id: string): void {
    for (const map of [this.returnedAt, this.openedAt, this.keptAt, this.wokeAt, this.snoozed]) {
      if (map.delete(id)) this.dirty = true
    }
    this.startedAt.delete(id)
    this.phases.delete(id)
    this.save()
  }

  private save(): void {
    if (!this.dirty) return
    this.dirty = false
    const obj = (map: Map<string, number>): Record<string, number> => Object.fromEntries(map)
    const existing = this.config.readForMerge(ORDER_FILE)
    this.config.writeJson(ORDER_FILE, {
      ...existing,
      returned: obj(this.returnedAt),
      opened: obj(this.openedAt),
      kept: obj(this.keptAt),
      snoozed: Object.fromEntries(this.snoozed),
      woke: obj(this.wokeAt),
    })
  }
}
