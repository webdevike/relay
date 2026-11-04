/**
 * Pure rules for the composer's activity badges on an assistant thread: what the host's activity
 * list says this assistant has in progress beyond its helpers (those are the Artifacts sheet's
 * subagent rows and the thread's own tool rows). The list itself lives in the Artifacts sheet's
 * Working group (`artifacts/format.ts` `taskGroups`).
 */
import { ownedActive, type ActivityItem } from "@evaos/chat-core/activity";

/** Badges shown before the rest fold into one "+N more". */
export const MAX_BADGES = 3;

export interface ActivityBadge {
  id: string;
  label: string;
  /** Blocked on Isaac: drawn in the warning tone, and first. */
  waiting: boolean;
}

export interface ActivityBadges {
  shown: ActivityBadge[];
  /** How many more are in progress than `shown` holds. */
  more: number;
}

/** What waits on Isaac first, then the newest run; helpers are left to the subagent rows. */
export function activityBadges(items: readonly ActivityItem[], thread: string): ActivityBadges {
  const all = ownedActive(items, thread)
    .filter((item) => item.kind !== "helper")
    .sort((a, b) => Number(b.status === "waiting") - Number(a.status === "waiting") || b.startedAt - a.startedAt);
  return {
    shown: all.slice(0, MAX_BADGES).map((item) => ({ id: item.id, label: item.title, waiting: item.status === "waiting" })),
    more: Math.max(0, all.length - MAX_BADGES),
  };
}
