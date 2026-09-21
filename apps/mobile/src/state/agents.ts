import { create } from "zustand";
import type { AgentImage, AgentMessage, AgentOptions, AgentSession } from "@relay/protocol";

export interface ConversationState {
  rev: number;
  messages: AgentMessage[];
}

export interface AgentsData {
  rev: number;
  sessions: Record<string, AgentSession>;
  order: string[];
  conversations: Record<string, ConversationState>;
  /** Models and skills each session offers, as last answered by the host. */
  options: Record<string, AgentOptions>;
  /**
   * Image bytes fetched per session, keyed by `AgentImageRef.id`, as a data URI ready for
   * `<Image source={{ uri }}>`. `null` means the host answered that it no longer has the image;
   * a missing key means it has not been fetched.
   */
  images: Record<string, Record<string, string | null>>;
}

export const emptyAgentsData: AgentsData = { rev: 0, sessions: {}, order: [], conversations: {}, options: {}, images: {} };

/** Sessions blocked on the user (a question or an approval prompt) sort ahead of everything else. */
export function needsAttention(session: AgentSession): boolean {
  return session.status === "waiting" || session.status === "needs_permission";
}

/**
 * Manual sessions first (attention, then recency), then every job run newest first: the scrubber
 * shows them as two sections, and a job never displaces a hand-started session from slot one.
 * Hosts predating jobs send no `kind`; those sessions are all manual.
 */
function orderByAttention(sessions: Record<string, AgentSession>): string[] {
  return Object.values(sessions)
    .sort((a, b) => {
      const section = Number(a.kind === "job") - Number(b.kind === "job");
      if (section !== 0) return section;
      const attention = a.kind === "job" ? 0 : Number(needsAttention(b)) - Number(needsAttention(a));
      return attention !== 0 ? attention : b.lastActivityAt - a.lastActivityAt;
    })
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
  return { ...data, rev, sessions: byId, order: orderByAttention(byId) };
}

/**
 * A fresh connection: the host's session set replaces ours, and every conversation goes with the
 * old socket (subscriptions do not survive a reconnect).
 */
export function applyWelcome(data: AgentsData, rev: number, sessions: AgentSession[]): AgentsData {
  return { ...applySnapshot(data, rev, sessions), conversations: {}, options: {}, images: {} };
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
  return { data: { ...data, rev, sessions: filtered, order: orderByAttention(filtered) }, ok: true };
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

/**
 * Replaces a streaming message's text. A no-op when the conversation or `id` is unknown (the
 * phone subscribed mid-stream; the next `agent.conversation` carries the settled text).
 */
export function updateMessage(data: AgentsData, sessionId: string, id: string, text: string, streaming: boolean): AgentsData {
  const existing = data.conversations[sessionId];
  if (!existing) return data;
  const index = existing.messages.findIndex((message) => message.id === id);
  if (index === -1) return data;
  const messages = existing.messages.slice();
  const current = messages[index];
  if (current === undefined) return data;
  const rest = { ...current };
  delete rest.streaming;
  messages[index] = streaming ? { ...rest, text, streaming: true } : { ...rest, text };
  return { ...data, conversations: { ...data.conversations, [sessionId]: { rev: existing.rev, messages } } };
}

/** Records the host's answer for one image ref: the bytes as a data URI, or `null` when gone. */
export function setImage(data: AgentsData, sessionId: string, id: string, image: AgentImage | null): AgentsData {
  const uri = image === null ? null : `data:${image.mimeType};base64,${image.data}`;
  return { ...data, images: { ...data.images, [sessionId]: { ...data.images[sessionId], [id]: uri } } };
}

export interface AgentsStore extends AgentsData {
  applyWelcome: (rev: number, sessions: AgentSession[]) => void;
  applySnapshot: (rev: number, sessions: AgentSession[]) => void;
  applyDelta: (rev: number, upsert?: AgentSession[], remove?: string[]) => boolean;
  setConversation: (sessionId: string, rev: number, messages: AgentMessage[]) => void;
  appendMessages: (sessionId: string, rev: number, append: AgentMessage[]) => boolean;
  setOptions: (sessionId: string, options: AgentOptions) => void;
  updateMessage: (sessionId: string, id: string, text: string, streaming: boolean) => void;
  setImage: (sessionId: string, id: string, image: AgentImage | null) => void;
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
  updateMessage: (sessionId, id, text, streaming) => {
    set(updateMessage(get(), sessionId, id, text, streaming));
  },
  setOptions: (sessionId, options) => {
    set({ options: { ...get().options, [sessionId]: options } });
  },
  setImage: (sessionId, id, image) => {
    set(setImage(get(), sessionId, id, image));
  },
}));
