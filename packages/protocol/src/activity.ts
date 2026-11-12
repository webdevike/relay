// Activity: everything agents are running, as one list the host builds (so the Mini and the MacBook
// agree) and pushes to every device as `activity.snapshot`. Four kinds: a helper (a subagent an
// assistant's `task` call started), a session (an omp chat of its own: an assistant thread, an
// auto-work run, a job), a harness (a non-omp agent in a herdr pane: claude, codex, muse, opencode)
// and a canvas room. Relay desktop's chat-core/activity.ts mirrors the schema line for line.
import { z } from "zod";
import { ActivityEta } from "./eta";

const ms = z.number().finite();

export const ACTIVITY_KINDS = ["helper", "session", "harness", "canvas"] as const;
export const ActivityKind = z.enum(ACTIVITY_KINDS);
export type ActivityKind = z.infer<typeof ActivityKind>;

/** `waiting` is waiting on Isaac: an approval, a question, a permission prompt. */
export const ACTIVITY_STATUSES = ["working", "waiting", "done", "failed"] as const;
export const ActivityStatus = z.enum(ACTIVITY_STATUSES);
export type ActivityStatus = z.infer<typeof ActivityStatus>;

/** Who owns an item: a thread key (`assistant:nova`, `session:<omp id>`), or `other` for what no chat started. */
export const ActivityOwner = z.string().min(1).max(200);

/** Where a click goes. */
export const ActivityOpen = z.discriminatedUnion("to", [
  /** A chat: an assistant's page or an omp session by id. */
  z.object({ to: z.literal("chat"), thread: ActivityOwner, session: z.string().max(200).optional() }),
  /** A helper's transcript (the `.jsonl` path on the host). */
  z.object({ to: z.literal("subagent"), file: z.string().max(4096), name: z.string().max(200) }),
  /** A herdr pane, attached view-only in the Terminal tab. */
  z.object({ to: z.literal("terminal"), pane: z.string().max(100) }),
  /** A live canvas room. */
  z.object({ to: z.literal("canvas"), slug: z.string().regex(/^[a-z0-9-]{1,80}$/) }),
]);
export type ActivityOpen = z.infer<typeof ActivityOpen>;

export const ActivityItem = z.object({
  /** Stable across snapshots: `helper:<path>`, `session:<id>`, `harness:<pane>`, `canvas:<slug>`. */
  id: z.string().min(1).max(4200),
  kind: ActivityKind,
  owner: ActivityOwner,
  title: z.string().max(300),
  status: ActivityStatus,
  /** The latest tool intent or status line; for `waiting`, what Isaac is being asked. */
  intent: z.string().max(400),
  /** When this run began; a resumed helper starts a new run. */
  startedAt: ms,
  updatedAt: ms,
  model: z.string().max(120).optional(),
  /** Dollars spent so far, when the source says (a canvas room's agent). */
  cost: z.number().finite().nonnegative().optional(),
  /** How long a working run has left, when the host can tell (`etaView` reads it). */
  eta: ActivityEta.optional(),
  open: ActivityOpen,
});
export type ActivityItem = z.infer<typeof ActivityItem>;

export const MAX_ACTIVITY = 300;
const DAY_MS = 24 * 60 * 60 * 1000;

const active = (item: ActivityItem): boolean => item.status === "working" || item.status === "waiting";

/**
 * The next list from the last one and what the sources report now (`found`). `answered` names the
 * kinds whose source answered this time; items of any other kind stay as they were, so a herdr that
 * did not reply does not end every harness.
 *
 * - An item the sources no longer report ends: working or waiting becomes done (it finished or its
 *   session went idle), and finished ones leave a day after they last changed.
 * - An item that was finished and is reported working again (a helper woken by a follow-up message)
 *   is a new run: working, started now.
 * - An item still active keeps its start; `updatedAt` moves only when status, intent or the
 *   question changed.
 */
export function mergeActivity(
  previous: readonly ActivityItem[],
  found: readonly ActivityItem[],
  answered: ReadonlySet<ActivityKind>,
  now: number,
): ActivityItem[] {
  const before = new Map(previous.map((item) => [item.id, item]));
  const out = new Map<string, ActivityItem>();
  for (const item of found) {
    const was = before.get(item.id);
    if (was === undefined) {
      out.set(item.id, item);
    } else if (active(item) && !active(was)) {
      out.set(item.id, { ...item, startedAt: now, updatedAt: now });
    } else if (active(item)) {
      const same = was.status === item.status && was.intent === item.intent;
      out.set(item.id, { ...item, startedAt: was.startedAt, updatedAt: same ? was.updatedAt : now });
    } else {
      // Finished: the source's own end time when it has one, else when this host first saw it.
      out.set(item.id, was.status === item.status ? { ...item, startedAt: was.startedAt, updatedAt: was.updatedAt } : item);
    }
  }
  for (const was of previous) {
    if (out.has(was.id)) continue;
    if (!answered.has(was.kind)) out.set(was.id, was);
    else if (active(was)) out.set(was.id, { ...was, status: "done", updatedAt: now });
    else if (now - was.updatedAt < DAY_MS) out.set(was.id, was);
  }
  return [...out.values()]
    .sort((a, b) => Number(active(b)) - Number(active(a)) || b.updatedAt - a.updatedAt)
    .slice(0, MAX_ACTIVITY);
}
