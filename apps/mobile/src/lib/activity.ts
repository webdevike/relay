/**
 * Pure rules for the running chips in an assistant thread's header (`agents/RunningChips`):
 * everything the host's activity list says this assistant has in progress (sessions, helpers,
 * harnesses, canvas rooms) plus the sessions it started for its own work while they run, each
 * once. The detail lives in the Artifacts sheet's Working group (`artifacts/format.ts` `taskGroups`).
 */
import { ownedActive, type ActivityItem } from "@evaos/chat-core/activity";
import type { AgentSession } from "@relay/protocol";

export interface RunningChip {
  id: string;
  label: string;
  /** Blocked on Isaac: drawn in the warning tone, and first. */
  waiting: boolean;
  /** The omp session this chip is, when it is one: a tap opens it. */
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
function sessionOf(item: ActivityItem, links: SessionLinks): string | undefined {
  if (item.kind === "session") return item.open.to === "chat" ? item.open.session : undefined;
  if (item.kind !== "helper" || item.open.to !== "subagent" || links.threadSession === null) return undefined;
  const file = item.open.file;
  const name = file.slice(file.lastIndexOf("/") + 1).replace(/\.jsonl$/, "");
  const id = `${links.threadSession}:${name}`;
  return links.sessions[id]?.parentId === links.threadSession ? id : undefined;
}

/**
 * What runs for `thread`: the activity items in progress (newest first) and then the assistant's
 * `owned` sessions (`state/agents` `ownedBy`) that are working or waiting on Isaac, one chip per item
 * id and per session; a stale owned session (idle, ended) shows nowhere. What waits on Isaac comes first.
 */
export function runningChips(items: readonly ActivityItem[], thread: string, links: SessionLinks, owned: readonly AgentSession[]): RunningChip[] {
  const seen = new Set<string>();
  const out: RunningChip[] = [];
  const add = (key: string, chip: RunningChip): void => {
    if (seen.has(key)) return;
    seen.add(key);
    out.push(chip);
  };
  for (const item of ownedActive(items, thread).sort((a, b) => b.startedAt - a.startedAt)) {
    const sessionId = sessionOf(item, links);
    add(sessionId === undefined ? item.id : `session:${sessionId}`, { id: item.id, label: item.title, waiting: item.status === "waiting", ...(sessionId === undefined ? {} : { sessionId }) });
  }
  for (const session of owned) {
    if (session.status !== "working" && session.status !== "waiting" && session.status !== "needs_permission") continue;
    add(`session:${session.id}`, { id: `owned:${session.id}`, label: session.title.replace(/ auto-work$/, ""), waiting: session.status !== "working", sessionId: session.id });
  }
  // Stable: each half keeps its order behind what waits on Isaac.
  return out.sort((a, b) => Number(b.waiting) - Number(a.waiting));
}
