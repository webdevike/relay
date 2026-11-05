/**
 * Pure rules for the composer's activity chips on an assistant thread: everything the host's
 * activity list says this assistant has in progress (sessions, helpers, harnesses, canvas rooms),
 * each once, in one sideways-scrolling row. The detail lives in the Artifacts sheet's Working group
 * (`artifacts/format.ts` `taskGroups`).
 */
import { ownedActive, type ActivityItem } from "@evaos/chat-core/activity";

export interface ActivityBadge {
  id: string;
  label: string;
  /** Blocked on Isaac: drawn in the warning tone, and first. */
  waiting: boolean;
  /** The omp session this badge is, when it is one: a tap opens it. */
  sessionId?: string;
}

function sessionOf(item: ActivityItem): string | undefined {
  return item.kind === "session" && item.open.to === "chat" ? item.open.session : undefined;
}

/** What waits on Isaac first, then the newest run; one badge per item id and per session. */
export function activityBadges(items: readonly ActivityItem[], thread: string): ActivityBadge[] {
  const seen = new Set<string>();
  const out: ActivityBadge[] = [];
  const sorted = ownedActive(items, thread).sort((a, b) => Number(b.status === "waiting") - Number(a.status === "waiting") || b.startedAt - a.startedAt);
  for (const item of sorted) {
    const sessionId = sessionOf(item);
    const key = sessionId === undefined ? item.id : `session:${sessionId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ id: item.id, label: item.title, waiting: item.status === "waiting", ...(sessionId === undefined ? {} : { sessionId }) });
  }
  return out;
}

/** Session ids that are in progress for `thread`: the header chips skip these, the badges already show them. */
export function runningSessionIds(items: readonly ActivityItem[], thread: string): Set<string> {
  const ids = new Set<string>();
  for (const item of ownedActive(items, thread)) {
    const sessionId = sessionOf(item);
    if (sessionId !== undefined) ids.add(sessionId);
  }
  return ids;
}
