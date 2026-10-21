/**
 * The host's assistant threads (Astra, Nova, … from its registry) as it last sent them, one per
 * agent id. Not persisted: the host owns the registry (`assistant.agents`, asked on every welcome)
 * and each transcript, which it replays on `assistant.get` (asked while that agent's thread is on
 * screen) and after every turn. `pending` is the phone's optimistic echo of a sent turn, shown
 * until a snapshot carries it.
 */
import { create } from "zustand";
import type { AssistantAgent, AssistantSnapshot } from "@relay/protocol";
import type { Photo } from "@/lib/photo";

export interface PendingTurn {
  text: string;
  /** The photos sent with the turn, kept so the echo bubble can show them until the host lists refs. */
  images: Photo[];
  /** The snapshot rev held when the turn was sent; any later rev means the host has taken it. */
  sinceRev: number;
}

export interface AssistantThread {
  snapshot: AssistantSnapshot | null;
  pending: PendingTurn | null;
  /** Messages whose sign-in the host took, shown submitted before its snapshot says so. */
  signedIn: Record<string, true>;
}

export const EMPTY_THREAD: AssistantThread = { snapshot: null, pending: null, signedIn: {} };

export interface AssistantStore {
  /** The host's registry in its order; null until the first `assistant.agents` answer. */
  agents: AssistantAgent[] | null;
  /** Threads by agent id; an agent the phone has heard nothing about yet has no entry. */
  threads: Record<string, AssistantThread>;
  setAgents: (agents: AssistantAgent[]) => void;
  set: (agent: string, snapshot: AssistantSnapshot) => void;
  /** Echo a turn sent to `agent`; null clears it. */
  setPending: (agent: string, turn: { text: string; images: Photo[] } | null) => void;
  /** The host acked the credentials for this message of `agent`'s thread. */
  markSignedIn: (agent: string, messageId: string) => void;
}

/**
 * A snapshot that lists the echoed words as a user message, or that moved past the rev held at
 * send time (the host's transcript changed after the turn went up), retires the echo. An
 * image-only turn has no words to match, so it waits for the rev to move.
 */
export function settlePending(snapshot: AssistantSnapshot, pending: PendingTurn | null): PendingTurn | null {
  if (pending === null) return null;
  if (snapshot.rev > pending.sinceRev) return null;
  if (pending.text === "") return pending;
  return snapshot.messages.some((message) => message.role === "user" && message.text === pending.text) ? null : pending;
}

/** The thread for `agent`, empty when the phone has heard nothing about it. */
export function threadOf(store: Pick<AssistantStore, "threads">, agent: string): AssistantThread {
  return store.threads[agent] ?? EMPTY_THREAD;
}

/** The registry title for `agent`, or the id itself before the host has listed its agents. */
export function agentTitle(agents: AssistantAgent[] | null, agent: string): string {
  return agents?.find((entry) => entry.id === agent)?.title ?? agent;
}

export const useAssistantStore = create<AssistantStore>((set, get) => {
  const update = (agent: string, change: (thread: AssistantThread) => Partial<AssistantThread>): void => {
    const thread = threadOf(get(), agent);
    set({ threads: { ...get().threads, [agent]: { ...thread, ...change(thread) } } });
  };
  return {
    agents: null,
    threads: {},
    setAgents: (agents) => {
      set({ agents });
    },
    set: (agent, snapshot) => {
      update(agent, (thread) => ({ snapshot, pending: settlePending(snapshot, thread.pending) }));
    },
    setPending: (agent, turn) => {
      update(agent, (thread) => ({ pending: turn === null ? null : { ...turn, sinceRev: thread.snapshot?.rev ?? -1 } }));
    },
    markSignedIn: (agent, messageId) => {
      update(agent, (thread) => ({ signedIn: { ...thread.signedIn, [messageId]: true } }));
    },
  };
});
