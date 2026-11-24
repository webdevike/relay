/**
 * Pure rules for the running cards in an assistant thread's card stack (`agents/CardStack`):
 * everything the host's activity list says this assistant has in progress (sessions, helpers,
 * harnesses, canvas rooms) plus the sessions it started for its own work while they run, each
 * once, with what a running card shows (since when, the model, the recent work). The detail lives
 * in the Artifacts sheet's Working group (`artifacts/format.ts` `taskGroups`).
 */
import { ownedActive, type ActivityItem } from "@evaos/chat-core/activity";
import { cardModel, cardVendor, recentWork, type CardVendor } from "@evaos/chat-core/card-stack";
import type { AgentSession } from "@relay/protocol";

export interface RunningCard {
  /** The activity item's id, or `owned:<session id>` for an owned session the activity list lacks. */
  id: string;
  title: string;
  /** Blocked on Isaac: its card leads with a hand, and it comes first. */
  waiting: boolean;
  /**
   * The omp session Open session opens: the card's own (a session, or a helper's mirrored transcript), else
   * for a helper with no transcript of its own the session it runs under. Absent only when there is none.
   */
  sessionId?: string;
  /** When the run started, for its ticking clock; absent when nothing says (an owned session with no activity item). */
  startedAt?: number;
  /** The model as the card names it ("Opus 5.5 high"); null when the source names none. */
  model: string | null;
  /** Whose logo shows beside the model; null when unknown (no logo). */
  vendor: CardVendor | null;
  /** The last few things it did, oldest first (at most 4): the host's log, else its latest line alone. */
  work: string[];
}

/** The thread's omp session and the sessions the phone lists: how a helper card finds its transcript. */
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

interface CardSession {
  id: string;
  /** The card is this very session; false: the session it runs under (so several cards may share it). */
  own: boolean;
}

/**
 * The session a card opens. A session item opens its own. A helper opens its own transcript, the
 * session the bridge mirrors as `<parent id>:<name>`: under the thread's session first, then under
 * whichever session lists it (a helper of an owned session or of another helper). With no mirror it
 * opens the parent its transcript path names, else the thread's session.
 */
function sessionOf(item: ActivityItem, links: SessionLinks): CardSession | undefined {
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

/** What a running card shows of an activity item: the host's model, vendor and log when it sends them (an older host sends none). */
function itemRun(item: ActivityItem): Pick<RunningCard, "startedAt" | "model" | "vendor" | "work"> {
  const work = recentWork({ intent: item.intent, ...(item.log === undefined ? {} : { log: item.log }) });
  return { startedAt: item.startedAt, model: cardModel(item.model, item.thinking), vendor: cardVendor(item.model, item.vendor), work };
}

/**
 * What runs for `thread`: the activity items in progress (newest first) and then the assistant's
 * `owned` sessions (`state/agents` `ownedBy`) that are working or waiting on Isaac, one card per item
 * id and per session; a stale owned session (idle, ended) shows nowhere. What waits on Isaac comes first.
 * An owned session the thread's items lack reads its own fields, or its session item under another
 * owner when the host lists one.
 */
export function runningCards(items: readonly ActivityItem[], thread: string, links: SessionLinks, owned: readonly AgentSession[]): RunningCard[] {
  const seen = new Set<string>();
  const out: RunningCard[] = [];
  const add = (key: string, card: RunningCard): void => {
    if (seen.has(key)) return;
    seen.add(key);
    out.push(card);
  };
  for (const item of ownedActive(items, thread).sort((a, b) => b.startedAt - a.startedAt)) {
    const target = sessionOf(item, links);
    add(target?.own === true ? `session:${target.id}` : item.id, {
      id: item.id,
      title: item.title,
      waiting: item.status === "waiting",
      ...(target === undefined ? {} : { sessionId: target.id }),
      ...itemRun(item),
    });
  }
  for (const session of owned) {
    if (session.status !== "working" && session.status !== "waiting" && session.status !== "needs_permission") continue;
    const listed = items.find((item) => item.id === `session:${session.id}`);
    const run =
      listed === undefined
        ? {
            model: cardModel(session.model, session.thinkingLevel),
            vendor: cardVendor(session.model, session.modelVendor),
            work: recentWork({ intent: session.lastActivity }),
          }
        : itemRun(listed);
    add(`session:${session.id}`, { id: `owned:${session.id}`, title: session.title.replace(/ auto-work$/, ""), waiting: session.status !== "working", sessionId: session.id, ...run });
  }
  // Stable: each half keeps its order behind what waits on Isaac.
  return out.sort((a, b) => Number(b.waiting) - Number(a.waiting));
}
