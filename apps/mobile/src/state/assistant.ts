/**
 * The host's assistant threads (Astra, Nova, … from its registry) as it last sent them, one per
 * agent id. Not persisted: the host owns the registry (`assistant.agents`, asked on every welcome
 * and whenever the Assistants screen is focused, and pushed again when an agent's status or last
 * reply changes; each entry carries its scope, status and last reply) and each transcript, which it replays on `assistant.get` (asked while that agent's thread is on
 * screen) and after every turn. `pending` is the phone's optimistic echo of a sent turn, shown
 * until a snapshot carries it.
 */
import { create } from "zustand";
import { untagged, type AssistantAgent, type AssistantPortrait, type AssistantSnapshot, type AssistantStatus } from "@relay/protocol";
import { countOf } from "@/lib/format";
import { portraitOf } from "@/lib/portrait";
import type { Photo } from "@/lib/photo";
import { previewText } from "@/agents/markdown";
import { backgroundOf } from "@/lib/background";

export interface PendingTurn {
  /** The echo row's id, unique per send (the turn's `clientId`). */
  id: string;
  text: string;
  /** The photos sent with the turn, kept so the echo bubble can show them until the host lists refs. */
  images: Photo[];
  /** The newest row's time when the turn was sent; the turn lands as a row of Isaac's after it. */
  since: number;
  /** Isaac's rows the thread held when the turn was sent, none of which is the turn. */
  before: ReadonlySet<string>;
  /** The host acked it: it reached the assistant, which takes it as a turn once it is free (a steer waits for the work under way). */
  acked: boolean;
}

export interface AssistantThread {
  snapshot: AssistantSnapshot | null;
  /** Echoes of turns sent from here that the thread does not list yet, oldest first. */
  pending: readonly PendingTurn[];
  /** Messages whose sign-in the host took, shown submitted before its snapshot says so. */
  signedIn: Record<string, true>;
}

export const EMPTY_THREAD: AssistantThread = { snapshot: null, pending: [], signedIn: {} };

export interface AssistantStore {
  /** The host's registry in its order; null until the first `assistant.agents` answer. */
  agents: AssistantAgent[] | null;
  /** Threads by agent id; an agent the phone has heard nothing about yet has no entry. */
  threads: Record<string, AssistantThread>;
  /**
   * The host sends guest rows (another assistant joined, spoke, left, or works on something) with
   * their entry (`welcome.features` has ASSISTANT_GUESTS_FEATURE): they show as joined/left lines,
   * guest bubbles and work cards. Off, they stay the plain status and card rows.
   */
  guests: boolean;
  setAgents: (agents: AssistantAgent[]) => void;
  setGuests: (guests: boolean) => void;
  set: (agent: string, snapshot: AssistantSnapshot) => void;
  /** Echoes a turn sent to `agent`, after any still waiting. */
  addPending: (agent: string, turn: { id: string; text: string; images: Photo[] }) => void;
  /** The host acked the turn of echo `id`. */
  ackPending: (agent: string, id: string) => void;
  /** Drops echo `id` (its turn was refused, or never shows as a row). */
  dropPending: (agent: string, id: string) => void;
  /** The host acked the credentials for this message of `agent`'s thread. */
  markSignedIn: (agent: string, messageId: string) => void;
}

/**
 * The echoes `snapshot` has not taken yet; the same array when none settled. An echo retires once
 * the snapshot lists a row of Isaac's that was not there when its turn was sent and is newer than
 * the thread's newest row then: the turn itself, whatever the host made of its words (an
 * image-only turn has none). Each such row retires one echo, oldest first, so a second turn sent
 * while the first waits keeps its bubble until its own row lands. A background row (a job line,
 * another agent's hand-off) is not his turn.
 *
 * A new rev alone never retires one: the host bumps rev on every streaming tick, and a turn sent
 * while the assistant works is a steer that joins the transcript only when omp takes it, seconds or
 * minutes later. Retiring the echo on the first rev bump emptied the thread of the turn until
 * then, so it looked unsent and Isaac sent it again. A turn that leaves no row of his (a slash
 * command, one omp drops) retires once acked and the thread has gone idle with something newer
 * than the send.
 */
export function settlePending(snapshot: AssistantSnapshot, pending: readonly PendingTurn[]): readonly PendingTurn[] {
  if (pending.length === 0) return pending;
  const claimed = new Set<string>();
  const kept = pending.filter((echo) => {
    const row = snapshot.messages.find((message) => message.role === "user" && message.at > echo.since && !echo.before.has(message.id) && !claimed.has(message.id) && backgroundOf(message) === null);
    if (row !== undefined) {
      claimed.add(row.id);
      return false;
    }
    return !(echo.acked && !snapshot.busy && snapshot.messages.some((message) => message.role !== "user" && message.at > echo.since));
  });
  if (kept.length === pending.length) return pending;
  // A row that retired an earlier echo is that turn's, never a later one's, in this snapshot or the next.
  return claimed.size === 0 ? kept : kept.map((echo) => ({ ...echo, before: new Set([...echo.before, ...claimed]) }));
}

/** The echo of `turn`, sent while the thread shows `snapshot`. */
export function pendingTurn(snapshot: AssistantSnapshot | null, turn: { id: string; text: string; images: Photo[] }): PendingTurn {
  const messages = snapshot?.messages ?? [];
  return {
    ...turn,
    since: messages.reduce((newest, message) => Math.max(newest, message.at), 0),
    before: new Set(messages.filter((message) => message.role === "user").map((message) => message.id)),
    acked: false,
  };
}

/**
 * The thread as the phone shows it: Isaac's turns without the surface tag a client put on them (a
 * turn typed on the desktop carries `<surface>Mac Mini - Relay Desktop</surface>`; hosts from before
 * the host stripped it send it as is). The same snapshot when no turn carries one.
 */
export function shownSnapshot(snapshot: AssistantSnapshot): AssistantSnapshot {
  const tagged = (message: AssistantSnapshot["messages"][number]): boolean => message.role === "user" && untagged(message.text) !== message.text;
  if (!snapshot.messages.some(tagged)) return snapshot;
  return { ...snapshot, messages: snapshot.messages.map((message) => (tagged(message) ? { ...message, text: untagged(message.text) } : message)) };
}

/** Deep equality of two values decoded from JSON. */
function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((item, i) => sameJson(item, b[i]));
  if (Array.isArray(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && sameJson(Reflect.get(a, key), Reflect.get(b, key)));
}

/**
 * `next` with every message that has not changed since `previous` replaced by the object `previous`
 * held, and the array itself when nothing changed. The host sends the whole thread on every change
 * (every 150 ms while a reply streams), so without this every drawn row of a long thread redraws
 * and re-parses its markdown on each frame.
 */
export function sharedSnapshot(previous: AssistantSnapshot | null, next: AssistantSnapshot): AssistantSnapshot {
  if (previous === null) return next;
  const before = new Map(previous.messages.map((message) => [message.id, message]));
  let changed = previous.messages.length !== next.messages.length;
  const messages = next.messages.map((message, i) => {
    const old = before.get(message.id);
    const kept = old !== undefined && sameJson(old, message) ? old : message;
    if (kept !== previous.messages[i]) changed = true;
    return kept;
  });
  return { ...next, messages: changed ? messages : previous.messages };
}

/** The thread for `agent`, empty when the phone has heard nothing about it. */
export function threadOf(store: Pick<AssistantStore, "threads">, agent: string): AssistantThread {
  return store.threads[agent] ?? EMPTY_THREAD;
}

/** The registry title for `agent`, or the id itself before the host has listed its agents. */
export function agentTitle(agents: AssistantAgent[] | null, agent: string): string {
  return agents?.find((entry) => entry.id === agent)?.title ?? agent;
}

/** The portrait `agent` is drawn with (`lib/portrait` `portraitOf`) once the host has listed it, else from its id. */
export function agentPortrait(agents: AssistantAgent[] | null, agent: string): AssistantPortrait {
  return portraitOf(agents?.find((entry) => entry.id === agent) ?? { id: agent });
}

/** The words a status pill shows. A host from before statuses sends none, and the row shows no pill. */
export const STATUS_LABEL: Record<AssistantStatus, string> = {
  working: "Working",
  needs_you: "Needs you",
  idle: "Idle",
  not_started: "Not started",
};

/** The agent with the most recent last reply and that reply; null when none has said anything. */
export function latestReply(agents: AssistantAgent[] | null): { agent: AssistantAgent; text: string; at: number } | null {
  let latest: { agent: AssistantAgent; text: string; at: number } | null = null;
  for (const agent of agents ?? []) {
    if (agent.lastReply !== undefined && (latest === null || agent.lastReply.at > latest.at)) latest = { agent, ...agent.lastReply };
  }
  return latest;
}

/** The home tile's caption: the newest reply across agents as one plain line led by who said it, else how many agents there are. */
export function assistantsCaption(agents: AssistantAgent[] | null): string {
  const reply = latestReply(agents);
  const line = reply === null ? "" : previewText(reply.text);
  if (reply !== null && line !== "") return `${reply.agent.title}: ${line}`;
  const count = agents?.length ?? 0;
  return count === 0 ? "No assistants yet" : countOf(count, "assistant");
}

export const useAssistantStore = create<AssistantStore>((set, get) => {
  const update = (agent: string, change: (thread: AssistantThread) => Partial<AssistantThread>): void => {
    const thread = threadOf(get(), agent);
    set({ threads: { ...get().threads, [agent]: { ...thread, ...change(thread) } } });
  };
  return {
    agents: null,
    threads: {},
    guests: false,
    setAgents: (agents) => {
      set({ agents });
    },
    setGuests: (guests) => {
      set({ guests });
    },
    set: (agent, received) => {
      update(agent, (thread) => {
        const snapshot = sharedSnapshot(thread.snapshot, shownSnapshot(received));
        return { snapshot, pending: settlePending(snapshot, thread.pending) };
      });
    },
    addPending: (agent, turn) => {
      update(agent, (thread) => ({ pending: [...thread.pending, pendingTurn(thread.snapshot, turn)] }));
    },
    ackPending: (agent, id) => {
      update(agent, (thread) => ({ pending: thread.pending.map((echo) => (echo.id === id ? { ...echo, acked: true } : echo)) }));
    },
    dropPending: (agent, id) => {
      update(agent, (thread) => ({ pending: thread.pending.filter((echo) => echo.id !== id) }));
    },
    markSignedIn: (agent, messageId) => {
      update(agent, (thread) => ({ signedIn: { ...thread.signedIn, [messageId]: true } }));
    },
  };
});
