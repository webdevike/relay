import { create } from "zustand";
import type { AgentApproval, AgentAsk, AgentImage, AgentMessage, AgentOptions, AgentSession } from "@relay/protocol";
import { sentCommand, settleOnMessages, settleOnSession, type SentCommand } from "@/lib/sentCommand";
import { settleEchoes, userEcho, type UserEcho } from "@/lib/userEcho";

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
  /**
   * The pending `ask` each session is blocked on, if any: omp's multiple-choice prompt, rendered
   * as a card the user can answer from the phone. Cleared when the ask resolves (answered here, in
   * the terminal, or on another device); the host replays the current one on `agent.subscribe`.
   */
  asks: Record<string, AgentAsk>;
  /**
   * The tool approval each session is blocked on, if any. A phone answers it with `agent.approve`
   * (Face ID first when `requiresBiometric`) or `agent.deny`; cleared when it settles anywhere.
   */
  approvals: Record<string, AgentApproval>;
  /**
   * The slash command each session was last sent from this phone, while it has not answered it
   * yet (see lib/sentCommand.ts). Settled by the session's own updates and transcript rows.
   */
  sent: Record<string, SentCommand>;
  /**
   * The words each session was sent from this phone that its transcript does not carry yet (see
   * lib/userEcho.ts), drawn as the user's bubbles meanwhile. `LAUNCH_ECHO` holds a launch's first
   * prompt until the session it started registers.
   */
  echoes: Record<string, readonly UserEcho[]>;
}

/** Key of a launch's echo while the session it starts has no id yet. */
export const LAUNCH_ECHO = "pending-launch";

export const emptyAgentsData: AgentsData = { rev: 0, sessions: {}, order: [], conversations: {}, options: {}, images: {}, asks: {}, approvals: {}, sent: {}, echoes: {} };

/** The sent commands once `sessions` arrived: settled ones go, and so do those of sessions that are gone. */
function settleSent(sent: Record<string, SentCommand>, sessions: Record<string, AgentSession>): Record<string, SentCommand> {
  const ids = Object.keys(sent);
  if (ids.length === 0) return sent;
  const next: Record<string, SentCommand> = {};
  for (const id of ids) {
    const pending = sent[id];
    const session = sessions[id];
    if (pending === undefined || session === undefined) continue;
    const settled = settleOnSession(pending, session);
    if (settled !== null) next[id] = settled;
  }
  return next;
}

/** `echoes` with the session's list replaced; an empty list removes the entry. */
function withEchoes(
  echoes: Record<string, readonly UserEcho[]>,
  sessionId: string,
  list: readonly UserEcho[],
): Record<string, readonly UserEcho[]> {
  if (list === echoes[sessionId]) return echoes;
  if (list.length > 0) return { ...echoes, [sessionId]: list };
  if (echoes[sessionId] === undefined) return echoes;
  return Object.fromEntries(Object.entries(echoes).filter(([id]) => id !== sessionId));
}

/** The echoes once `sessions` arrived: those of sessions that are gone go; a launch's waits for its session. */
function keepEchoes(
  echoes: Record<string, readonly UserEcho[]>,
  sessions: Record<string, AgentSession>,
): Record<string, readonly UserEcho[]> {
  const live = (id: string): boolean => id === LAUNCH_ECHO || sessions[id] !== undefined;
  if (Object.keys(echoes).every(live)) return echoes;
  return Object.fromEntries(Object.entries(echoes).filter(([id]) => live(id)));
}

/** The echoes once the session's transcript reads `messages`: the turns it carries stop showing. */
function settledEchoes(
  echoes: Record<string, readonly UserEcho[]>,
  sessionId: string,
  messages: readonly AgentMessage[],
): Record<string, readonly UserEcho[]> {
  const list = echoes[sessionId];
  return list === undefined ? echoes : withEchoes(echoes, sessionId, settleEchoes(list, messages));
}

/** Sessions blocked on the user (a question or an approval prompt) sort ahead of everything else. */
export function needsAttention(session: AgentSession): boolean {
  return session.status === "waiting" || session.status === "needs_permission";
}

/**
 * The inbox's top-level sessions: manual sessions first (attention, then recency), then every job
 * run newest first, so the scrubber shows them as two sections and a job never displaces a
 * hand-started session from slot one. Subagents (`parentId` set) are left out; they are reached
 * from their parent's chips. So is the personal assistant (`kind` "assistant"): Eva has her own
 * screen, and so are sessions an assistant started for its own work (`owner`, e.g. Astra's
 * auto-work): they sit under that assistant's thread (`ownedBy`). Hosts predating jobs send no
 * `kind`; those sessions are all manual.
 */
function orderByAttention(sessions: Record<string, AgentSession>): string[] {
  return Object.values(sessions)
    .filter((session) => session.parentId === undefined && session.kind !== "assistant" && session.owner === undefined)
    .sort((a, b) => {
      const section = Number(a.kind === "job") - Number(b.kind === "job");
      if (section !== 0) return section;
      const attention = a.kind === "job" ? 0 : Number(needsAttention(b)) - Number(needsAttention(a));
      return attention !== 0 ? attention : b.lastActivityAt - a.lastActivityAt;
    })
    .map((session) => session.id);
}

/** A session's subagents, sorted by id so their chips keep their places as statuses change. */
export function subagentsOf(sessions: Record<string, AgentSession>, parentId: string): AgentSession[] {
  return Object.values(sessions)
    .filter((session) => session.parentId === parentId)
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** The sessions assistant `agent` started for its own work, newest activity first: its thread lists them. */
export function ownedBy(sessions: Record<string, AgentSession>, agent: string): AgentSession[] {
  return Object.values(sessions)
    .filter((session) => session.owner === agent && session.parentId === undefined)
    .sort((a, b) => b.lastActivityAt - a.lastActivityAt);
}

/** Replaces the whole session set with a fresh snapshot. Always accepted (snapshots have no gap). */
export function applySnapshot(
  data: AgentsData,
  rev: number,
  sessions: AgentSession[],
): AgentsData {
  const byId: Record<string, AgentSession> = {};
  for (const session of sessions) byId[session.id] = session;
  return { ...data, rev, sessions: byId, order: orderByAttention(byId), sent: settleSent(data.sent, byId), echoes: keepEchoes(data.echoes, byId) };
}

/**
 * A fresh connection: the host's session set replaces ours, and every conversation goes with the
 * old socket (subscriptions do not survive a reconnect).
 */
export function applyWelcome(data: AgentsData, rev: number, sessions: AgentSession[]): AgentsData {
  return { ...applySnapshot(data, rev, sessions), conversations: {}, options: {}, images: {}, asks: {}, approvals: {} };
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
  return {
    data: { ...data, rev, sessions: filtered, order: orderByAttention(filtered), sent: settleSent(data.sent, filtered), echoes: keepEchoes(data.echoes, filtered) },
    ok: true,
  };
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
    echoes: settledEchoes(data.echoes, sessionId, messages),
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
  const pending = data.sent[sessionId];
  const settled = pending === undefined ? undefined : settleOnMessages(pending, append);
  const sent = settled === pending ? data.sent : withSent(data.sent, sessionId, settled ?? undefined);
  const messages = [...existing.messages, ...append];
  return {
    data: {
      ...data,
      conversations: {
        ...data.conversations,
        [sessionId]: { rev, messages },
      },
      sent,
      echoes: settledEchoes(data.echoes, sessionId, messages),
    },
    ok: true,
  };
}

/** `sent` with the session's command replaced, or removed when `command` is undefined. */
function withSent(sent: Record<string, SentCommand>, sessionId: string, command: SentCommand | undefined): Record<string, SentCommand> {
  if (command !== undefined) return { ...sent, [sessionId]: command };
  return Object.fromEntries(Object.entries(sent).filter(([id]) => id !== sessionId));
}

/**
 * Notes a reply the phone is sending: a slash command shows as running; any other text clears one
 * and shows as the user's bubble until the transcript carries it. A refused send's bubble goes
 * with the next send.
 */
export function noteSent(data: AgentsData, sessionId: string, text: string, now: number): AgentsData {
  const command = sentCommand(text, data.sessions[sessionId], now);
  const current = data.echoes[sessionId] ?? [];
  const waiting = current.some((echo) => echo.error !== undefined) ? current.filter((echo) => echo.error === undefined) : current;
  const echo = command === null ? userEcho(text, data.conversations[sessionId]?.messages, waiting, now) : null;
  const echoes = withEchoes(data.echoes, sessionId, echo === null ? waiting : [...waiting, echo]);
  const sent = command === null && data.sent[sessionId] === undefined ? data.sent : withSent(data.sent, sessionId, command ?? undefined);
  if (sent === data.sent && echoes === data.echoes) return data;
  return { ...data, sent, echoes };
}

/** Drops the session's sent command (the host refused it, or it timed out), but only the one sent at `at`. */
export function dropSent(data: AgentsData, sessionId: string, at: number): AgentsData {
  if (data.sent[sessionId]?.at !== at) return data;
  return { ...data, sent: withSent(data.sent, sessionId, undefined) };
}

/** Marks the echoes sent at `at` (any time, when omitted) as refused with `error`; their bubbles stay. */
export function failEcho(data: AgentsData, sessionId: string, error: string, at?: number): AgentsData {
  const list = data.echoes[sessionId];
  const refused = (echo: UserEcho): boolean => echo.error === undefined && (at === undefined || echo.at === at);
  if (!list?.some(refused)) return data;
  const failed = list.map((echo) => (refused(echo) ? { ...echo, error } : echo));
  return { ...data, echoes: withEchoes(data.echoes, sessionId, failed) };
}

/** A launch is going out with `prompt` as its first turn: its bubble shows now, replacing any earlier launch's. */
export function noteLaunch(data: AgentsData, prompt: string, now: number): AgentsData {
  const echo = userEcho(prompt, undefined, [], now);
  return { ...data, echoes: withEchoes(data.echoes, LAUNCH_ECHO, echo === null ? [] : [echo]) };
}

/**
 * The launched session registered as `sessionId`: the first prompt's bubble moves to it and stays
 * until its transcript carries the turn (a fresh session holds no user rows, so the echo's
 * counts already fit it).
 */
export function adoptLaunch(data: AgentsData, sessionId: string): AgentsData {
  const launch = data.echoes[LAUNCH_ECHO];
  if (launch === undefined) return data;
  const moved = withEchoes(withEchoes(data.echoes, LAUNCH_ECHO, []), sessionId, [...(data.echoes[sessionId] ?? []), ...launch]);
  const messages = data.conversations[sessionId]?.messages;
  return { ...data, echoes: messages === undefined ? moved : settledEchoes(moved, sessionId, messages) };
}

/** The launch's bubble is dismissed (its failure was seen, or another launch replaced it). */
export function clearLaunch(data: AgentsData): AgentsData {
  const echoes = withEchoes(data.echoes, LAUNCH_ECHO, []);
  return echoes === data.echoes ? data : { ...data, echoes };
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

/** Stores the pending ask a session just became blocked on, replacing any earlier one. */
export function setAsk(data: AgentsData, sessionId: string, ask: AgentAsk): AgentsData {
  return { ...data, asks: { ...data.asks, [sessionId]: ask } };
}

/**
 * Clears a session's pending ask, but only when `id` matches the one stored: a `resolved` for an
 * ask already replaced by a newer one must not wipe the newer card.
 */
export function clearAsk(data: AgentsData, sessionId: string, id: string): AgentsData {
  if (data.asks[sessionId]?.id !== id) return data;
  const asks = { ...data.asks };
  delete asks[sessionId];
  return { ...data, asks };
}

/** Stores the tool approval a session just became blocked on, replacing any earlier one. */
export function setApproval(data: AgentsData, sessionId: string, approval: AgentApproval): AgentsData {
  return { ...data, approvals: { ...data.approvals, [sessionId]: approval } };
}

/** Clears a session's pending approval, but only when `id` matches the one stored (as `clearAsk`). */
export function clearApproval(data: AgentsData, sessionId: string, id: string): AgentsData {
  if (data.approvals[sessionId]?.id !== id) return data;
  const approvals = { ...data.approvals };
  delete approvals[sessionId];
  return { ...data, approvals };
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
  setAsk: (sessionId: string, ask: AgentAsk) => void;
  clearAsk: (sessionId: string, id: string) => void;
  setApproval: (sessionId: string, approval: AgentApproval) => void;
  clearApproval: (sessionId: string, id: string) => void;
  noteSent: (sessionId: string, text: string, now: number) => void;
  dropSent: (sessionId: string, at: number) => void;
  failEcho: (sessionId: string, error: string, at?: number) => void;
  noteLaunch: (prompt: string, now: number) => void;
  adoptLaunch: (sessionId: string) => void;
  clearLaunch: () => void;
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
  setAsk: (sessionId, ask) => {
    set(setAsk(get(), sessionId, ask));
  },
  clearAsk: (sessionId, id) => {
    set(clearAsk(get(), sessionId, id));
  },
  setApproval: (sessionId, approval) => {
    set(setApproval(get(), sessionId, approval));
  },
  clearApproval: (sessionId, id) => {
    set(clearApproval(get(), sessionId, id));
  },
  noteSent: (sessionId, text, now) => {
    set(noteSent(get(), sessionId, text, now));
  },
  dropSent: (sessionId, at) => {
    set(dropSent(get(), sessionId, at));
  },
  failEcho: (sessionId, error, at) => {
    set(failEcho(get(), sessionId, error, at));
  },
  noteLaunch: (prompt, now) => {
    set(noteLaunch(get(), prompt, now));
  },
  adoptLaunch: (sessionId) => {
    set(adoptLaunch(get(), sessionId));
  },
  clearLaunch: () => {
    set(clearLaunch(get()));
  },
}));
