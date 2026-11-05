/**
 * Pure rules for the composer's activity chips on an assistant thread: everything the host's
 * activity list says this assistant has in progress (sessions, helpers, harnesses, canvas rooms),
 * each once, in one sideways-scrolling row. The detail lives in the Artifacts sheet's Working group
 * (`artifacts/format.ts` `taskGroups`).
 */
import { ownedActive, type ActivityItem } from "@evaos/chat-core/activity";
import type { AgentSession } from "@relay/protocol";

export interface ActivityBadge {
  id: string;
  label: string;
  /** Blocked on Isaac: drawn in the warning tone, and first. */
  waiting: boolean;
  /** The omp session this badge is, when it is one: a tap opens it. */
  sessionId?: string;
}

/** The thread's omp session and the sessions the phone lists: how a helper chip finds its transcript. */
export interface SessionLinks {
  threadSession: string | null;
  sessions: Readonly<Record<string, AgentSession>>;
}

/**
 * The session a chip opens: a session item's own, or for a helper the transcript the bridge mirrors
 * as `<thread session>:<helper name>` (a subagent of the thread's session), when the host lists it.
 */
function sessionOf(item: ActivityItem, links: SessionLinks | undefined): string | undefined {
  if (item.kind === "session") return item.open.to === "chat" ? item.open.session : undefined;
  if (item.kind !== "helper" || item.open.to !== "subagent" || links?.threadSession == null) return undefined;
  const file = item.open.file;
  const name = file.slice(file.lastIndexOf("/") + 1).replace(/\.jsonl$/, "");
  const id = `${links.threadSession}:${name}`;
  return links.sessions[id]?.parentId === links.threadSession ? id : undefined;
}

/** What waits on Isaac first, then the newest run; one badge per item id and per session. */
export function activityBadges(items: readonly ActivityItem[], thread: string, links?: SessionLinks): ActivityBadge[] {
  const seen = new Set<string>();
  const out: ActivityBadge[] = [];
  const sorted = ownedActive(items, thread).sort((a, b) => Number(b.status === "waiting") - Number(a.status === "waiting") || b.startedAt - a.startedAt);
  for (const item of sorted) {
    const sessionId = sessionOf(item, links);
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
    const sessionId = sessionOf(item, undefined);
    if (sessionId !== undefined) ids.add(sessionId);
  }
  return ids;
}
