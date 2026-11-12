// Activity: everything agents are running, as one list the host builds and pushes to every device
// (relay packages/protocol/src/activity.ts). This app does not depend on @relay/protocol, so the
// schema below is a copy with the same names: keep them in sync, line for line. The host is the only
// writer, so the Mini and the MacBook agree; what a client adds is only how it groups and draws it.
import { z } from 'zod'

const ms = z.number().finite()

export const ACTIVITY_KINDS = ['helper', 'session', 'harness', 'canvas'] as const
export const ActivityKind = z.enum(ACTIVITY_KINDS)
export type ActivityKind = z.infer<typeof ActivityKind>

/** `waiting` is waiting on Isaac: an approval, a question, a permission prompt. */
export const ACTIVITY_STATUSES = ['working', 'waiting', 'done', 'failed'] as const
export const ActivityStatus = z.enum(ACTIVITY_STATUSES)
export type ActivityStatus = z.infer<typeof ActivityStatus>

/** Who owns an item: a thread key (`assistant:nova`, `session:<omp id>`), or `other`. */
export const ActivityOwner = z.string().min(1).max(200)

/** Where a click goes. */
export const ActivityOpen = z.discriminatedUnion('to', [
  z.object({
    to: z.literal('chat'),
    thread: ActivityOwner,
    session: z.string().max(200).optional(),
  }),
  z.object({ to: z.literal('subagent'), file: z.string().max(4096), name: z.string().max(200) }),
  z.object({ to: z.literal('terminal'), pane: z.string().max(100) }),
  z.object({ to: z.literal('canvas'), slug: z.string().regex(/^[a-z0-9-]{1,80}$/) }),
])
export type ActivityOpen = z.infer<typeof ActivityOpen>

/** How long a working run has left (relay packages/protocol/src/eta.ts; `etaView` there reads it). */
export const ActivityEta = z.object({
  from: z.number().finite(),
  totalMs: z.number().finite().positive(),
  lowMs: z.number().finite().positive(),
  highMs: z.number().finite().positive(),
  typicalMs: z.number().finite().positive(),
  runs: z.number().int().nonnegative(),
  confidence: z.enum(['rough', 'confident']),
  overrunning: z.boolean(),
  steps: z.object({ done: z.number().int().nonnegative(), total: z.number().int().positive() }).optional(),
})
export type ActivityEta = z.infer<typeof ActivityEta>

export const ActivityItem = z.object({
  id: z.string().min(1).max(4200),
  kind: ActivityKind,
  owner: ActivityOwner,
  title: z.string().max(300),
  status: ActivityStatus,
  /** The latest tool intent or status line; for `waiting`, what Isaac is being asked. */
  intent: z.string().max(400),
  startedAt: ms,
  updatedAt: ms,
  model: z.string().max(120).optional(),
  /** Dollars spent so far, when the source says. */
  cost: z.number().finite().nonnegative().optional(),
  /** How long a working run has left, when the host can tell. */
  eta: ActivityEta.optional(),
  open: ActivityOpen,
})
export type ActivityItem = z.infer<typeof ActivityItem>

/** The label a row leads with. */
export const ACTIVITY_KIND_LABEL: Readonly<Record<ActivityKind, string>> = {
  helper: 'Helper',
  session: 'Session',
  harness: 'Harness',
  canvas: 'Canvas',
}

export const isActive = (item: ActivityItem): boolean =>
  item.status === 'working' || item.status === 'waiting'

/** The thread an assistant page or chat shows items for: `assistant:<id>` or `session:<id>`. */
export const sameOwner = (item: ActivityItem, thread: string | null): boolean =>
  thread !== null && item.owner === thread

/** What the Working tab and the composer chips draw: the items `thread` owns that are in progress. */
export function ownedActive(items: readonly ActivityItem[], thread: string | null): ActivityItem[] {
  return items.filter((i) => isActive(i) && sameOwner(i, thread) && !isSelf(i, thread))
}

/** An item that is the thread's own chat (an assistant listing itself). */
export const isSelf = (item: ActivityItem, thread: string | null): boolean =>
  item.open.to === 'chat' && item.open.thread === thread && item.owner === thread

export interface ActivitySections {
  /** Blocked on Isaac, oldest ask first. With a thread: its own; without one: any owner's. */
  waiting: ActivityItem[]
  /** In progress under this thread (helpers are the Artifacts rows, so they are not repeated here). */
  mine: ActivityItem[]
  /** In progress under other owners, grouped. Empty when a thread is given: its page shows its own work only. */
  others: Array<{ owner: string; items: ActivityItem[] }>
  /** Finished or failed today under this thread. */
  earlier: ActivityItem[]
}

const sameDay = (a: number, b: number): boolean =>
  new Date(a).toDateString() === new Date(b).toDateString()

/**
 * The popover's sections for `thread`. With a thread (an assistant's page or a chat) only what that
 * thread owns is listed: waiting on Isaac, running, finished today. Helpers of `thread` are left
 * out: the Artifacts rows draw those (with their transcripts), so one helper is never listed twice.
 * Without a thread (a page with no owner) everything is listed, the other owners grouped:
 * `ownerOrder` ranks them (assistants first); anything else sorts by name after them.
 */
export function activitySections(
  items: readonly ActivityItem[],
  thread: string | null,
  now: number,
  ownerOrder: readonly string[] = [],
): ActivitySections {
  const notMyHelper = (i: ActivityItem): boolean => !(i.kind === 'helper' && sameOwner(i, thread))
  const shown = items.filter((i) => notMyHelper(i) && !isSelf(i, thread))
  const waiting = shown
    .filter((i) => i.status === 'waiting' && (thread === null || sameOwner(i, thread)))
    .sort((a, b) => a.updatedAt - b.updatedAt)
  const working = shown.filter((i) => i.status === 'working')
  const mine = working.filter((i) => sameOwner(i, thread)).sort((a, b) => b.startedAt - a.startedAt)
  const byOwner = new Map<string, ActivityItem[]>()
  for (const i of thread === null ? working : []) {
    byOwner.set(i.owner, [...(byOwner.get(i.owner) ?? []), i])
  }
  const rank = (owner: string): number => {
    const at = ownerOrder.indexOf(owner)
    return at >= 0
      ? at
      : ownerOrder.length + (owner === 'other' || owner.startsWith('session:') ? 1 : 0)
  }
  const others = [...byOwner]
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([owner, list]) => ({ owner, items: list.sort((a, b) => b.startedAt - a.startedAt) }))
  const earlier = shown
    .filter(
      (i) =>
        (i.status === 'done' || i.status === 'failed') &&
        sameOwner(i, thread) &&
        sameDay(i.updatedAt, now),
    )
    .sort((a, b) => b.updatedAt - a.updatedAt)
  return { waiting, mine, others, earlier }
}
