/**
 * Pure rules for the running chips in an assistant thread's header (`agents/RunningChips`):
 * everything the host's activity list says this assistant has in progress (sessions, helpers,
 * harnesses, canvas rooms) plus the sessions it started for its own work while they run, each
 * once. The detail lives in the Artifacts sheet's Working group (`artifacts/format.ts` `taskGroups`).
 */
import { ownedActive, type ActivityEta, type ActivityItem } from "@evaos/chat-core/activity";
import type { AgentSession } from "@relay/protocol";

export interface RunningChip {
  id: string;
  label: string;
  /** Blocked on Isaac: drawn in the warning tone, and first. */
  waiting: boolean;
  /**
   * The omp session a tap opens: the chip's own (a session, or a helper's mirrored transcript), else
   * for a helper with no transcript of its own the session it runs under. Absent only when there is none.
   */
  sessionId?: string;
  /** How long the run has left, when the host can tell: the chip draws it as a fill and a tap explains it first. */
  eta?: ActivityEta;
}

/** The thread's omp session and the sessions the phone lists: how a helper chip finds its transcript. */
export interface SessionLinks {
  threadSession: string | null;
  sessions: Readonly<Record<string, AgentSession>>;
}

/** A transcript file's name without its folders or `.jsonl`: the helper's name in `<parent id>:<name>`. */
function stemOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1).replace(/\.jsonl$/, "");
}

/** Whether `id` names one of the folders (or the file) of a transcript path: how a helper's file points at its parent session. */
function pathNames(file: string, id: string): boolean {
  return file
    .split("/")
    .map((part) => part.replace(/\.jsonl$/, ""))
    .some((part) => part === id || part.endsWith(`_${id}`));
}

interface ChipSession {
  id: string;
  /** The chip is this very session; false: the session it runs under (so several chips may share it). */
  own: boolean;
}

/**
 * The session a chip opens. A session item opens its own. A helper opens its own transcript, the
 * session the bridge mirrors as `<parent id>:<name>`: under the thread's session first, then under
 * whichever session lists it (a helper of an owned session or of another helper). With no mirror it
 * opens the parent its transcript path names, else the thread's session.
 */
function sessionOf(item: ActivityItem, links: SessionLinks): ChipSession | undefined {
  if (item.kind === "session") return item.open.to === "chat" && item.open.session !== undefined ? { id: item.open.session, own: true } : undefined;
  if (item.kind !== "helper" || item.open.to !== "subagent") return undefined;
  const file = item.open.file;
  const name = stemOf(file);
  const mirrored = (parent: string): string | undefined => {
    const id = `${parent}:${name}`;
    return links.sessions[id]?.parentId === parent ? id : undefined;
  };
  const underThread = links.threadSession === null ? undefined : mirrored(links.threadSession);
  if (underThread !== undefined) return { id: underThread, own: true };
  const elsewhere = Object.values(links.sessions).filter((session) => session.parentId !== undefined && session.id === `${session.parentId}:${name}`);
  const named = elsewhere.filter((session) => session.parentId !== undefined && pathNames(file, session.parentId));
  const found = named.length > 0 ? named : elsewhere.length === 1 ? elsewhere : [];
  if (found[0] !== undefined) return { id: found[0].id, own: true };
  const parent = Object.values(links.sessions).find((session) => session.parentId === undefined && pathNames(file, session.id));
  const fallback = parent?.id ?? links.threadSession ?? undefined;
  return fallback === undefined ? undefined : { id: fallback, own: false };
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
    const target = sessionOf(item, links);
    add(target?.own === true ? `session:${target.id}` : item.id, {
      id: item.id,
      label: item.title,
      waiting: item.status === "waiting",
      ...(target === undefined ? {} : { sessionId: target.id }),
      ...(item.eta === undefined ? {} : { eta: item.eta }),
    });
  }
  for (const session of owned) {
    if (session.status !== "working" && session.status !== "waiting" && session.status !== "needs_permission") continue;
    const eta = items.find((item) => item.id === `session:${session.id}`)?.eta;
    add(`session:${session.id}`, { id: `owned:${session.id}`, label: session.title.replace(/ auto-work$/, ""), waiting: session.status !== "working", sessionId: session.id, ...(eta === undefined ? {} : { eta }) });
  }
  // Stable: each half keeps its order behind what waits on Isaac.
  return out.sort((a, b) => Number(b.waiting) - Number(a.waiting));
}
