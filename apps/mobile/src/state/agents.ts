import { create } from "zustand";
import type { AgentMessage, AgentSession } from "@relay/protocol";

export interface ConversationState {
  rev: number;
  messages: AgentMessage[];
}

export interface AgentsData {
  rev: number;
  sessions: Record<string, AgentSession>;
  order: string[];
  conversations: Record<string, ConversationState>;
}

export const emptyAgentsData: AgentsData = { rev: 0, sessions: {}, order: [], conversations: {} };

function orderByRecency(sessions: Record<string, AgentSession>): string[] {
  return Object.values(sessions)
    .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
    .map((session) => session.id);
}

/** Replaces the whole session set with a fresh snapshot. Always accepted (snapshots have no gap). */
export function applySnapshot(
  data: AgentsData,
  rev: number,
  sessions: AgentSession[],
): AgentsData {
  const byId: Record<string, AgentSession> = {};
  for (const session of sessions) byId[session.id] = session;
  return { ...data, rev, sessions: byId, order: orderByRecency(byId) };
}

/**
 * A fresh connection: the host's session set replaces ours, and every conversation goes with the
 * old socket (subscriptions do not survive a reconnect).
 */
export function applyWelcome(data: AgentsData, rev: number, sessions: AgentSession[]): AgentsData {
  return { ...applySnapshot(data, rev, sessions), conversations: {} };
}

/**
 * Applies an incremental upsert/remove. Returns the unchanged `data` and `ok: false` when `rev`
 * is not exactly one past `data.rev` — the caller re-requests the snapshot on a gap.
 */
export function applyDelta(
  data: AgentsData,
  rev: number,
  upsert: AgentSession[] | undefined,
  remove: string[] | undefined,
): { data: AgentsData; ok: boolean } {
  if (rev !== data.rev + 1) return { data, ok: false };
  const removed = new Set(remove ?? []);
  const sessions = { ...data.sessions };
  for (const session of upsert ?? []) sessions[session.id] = session;
  const filtered = removed.size === 0 ? sessions : Object.fromEntries(
    Object.entries(sessions).filter(([id]) => !removed.has(id)),
  );
  return { data: { ...data, rev, sessions: filtered, order: orderByRecency(filtered) }, ok: true };
}

export function setConversation(
  data: AgentsData,
  sessionId: string,
  rev: number,
  messages: AgentMessage[],
): AgentsData {
  return {
    ...data,
    conversations: { ...data.conversations, [sessionId]: { rev, messages } },
  };
}

/**
 * Appends messages to an existing conversation. Returns `ok: false` and leaves `data` unchanged
 * when `rev` is not exactly one past the conversation's known `rev`, or when the conversation has
 * not been loaded yet (nothing to append to).
 */
export function appendMessages(
  data: AgentsData,
  sessionId: string,
  rev: number,
  append: AgentMessage[],
): { data: AgentsData; ok: boolean } {
  const existing = data.conversations[sessionId];
  if (!existing || rev !== existing.rev + 1) return { data, ok: false };
  return {
    data: {
      ...data,
      conversations: {
        ...data.conversations,
        [sessionId]: { rev, messages: [...existing.messages, ...append] },
      },
    },
    ok: true,
  };
}

export interface AgentsStore extends AgentsData {
  applyWelcome: (rev: number, sessions: AgentSession[]) => void;
  applySnapshot: (rev: number, sessions: AgentSession[]) => void;
  applyDelta: (rev: number, upsert?: AgentSession[], remove?: string[]) => boolean;
  setConversation: (sessionId: string, rev: number, messages: AgentMessage[]) => void;
  appendMessages: (sessionId: string, rev: number, append: AgentMessage[]) => boolean;
}

export const useAgentsStore = create<AgentsStore>((set, get) => ({
  ...emptyAgentsData,
  applyWelcome: (rev, sessions) => {
    set(applyWelcome(get(), rev, sessions));
  },
  applySnapshot: (rev, sessions) => {
    set(applySnapshot(get(), rev, sessions));
  },
  applyDelta: (rev, upsert, remove) => {
    const result = applyDelta(get(), rev, upsert, remove);
    set(result.data);
    return result.ok;
  },
  setConversation: (sessionId, rev, messages) => {
    set(setConversation(get(), sessionId, rev, messages));
  },
  appendMessages: (sessionId, rev, append) => {
    const result = appendMessages(get(), sessionId, rev, append);
    set(result.data);
    return result.ok;
  },
}));
