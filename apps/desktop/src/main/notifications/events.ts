import { isNothingToReport } from '@evaos/chat-core/quiet'
import type { ActivityItem } from '@evaos/chat-core/activity'
import { sessionId } from '@evaos/chat-core/session-id'
import type { Assistants, CanvasRoom, ChatRow, UpdateState } from '@evaos/contract'
import type { ChatAlert } from '../chat/chat-alerts'
import type { NotifyEvent } from './policy'

/** A waiting item older than this when first heard is not news (the app just started, the host just reconnected). */
export const FRESH_MS = 2 * 60_000
const BODY_CHARS = 160

const clip = (text: string): string => {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > BODY_CHARS ? `${one.slice(0, BODY_CHARS - 1)}…` : one
}

/** The thread key `notifications.visible` uses for an assistant's page. */
export const assistantThread = (id: string): string => `assistant:${id}`
/** The thread key for a chat's session file. */
export const chatThread = (file: string): string => `chat:${file}`

// Assistant replies -----------------------------------------------------------------------------

/** What `repliesSince` remembers per assistant: the reply it last saw, as one comparable string. */
export type SeenReplies = ReadonlyMap<string, string>
/** Remembered for a thread with no session file yet (not started, or not mirrored from the host yet). */
const NO_FILE = 'no-file'
/** Remembered for a thread whose file holds no reply yet. */
const NO_REPLY = ''

const replySignature = (a: Assistants['agents'][number]): string | null =>
  a.reply === null ? null : `${String(a.reply.at)}|${a.reply.text}`

/** A reply written longer ago than this when heard is not news (a mirror catching up, a Mac waking). */
export const REPLY_FRESH_MS = 10 * 60_000

/**
 * The assistants whose newest reply is new since `seen`. The first list is only remembered (a
 * launch or a reconnect is not news), so is an assistant that appears later with a reply already
 * written, and a reply omp wrote more than ten minutes before it was heard (a thin client's
 * mirror of the host's files catching up: the phone told it then). A thread that is still working
 * holds its change back until it settles, so a turn with several text messages is one
 * notification with the last of them. "(nothing to report)" background turns never count: they
 * are no reply (and `lastReply` already skips them; the check here covers a host that words it
 * differently).
 */
export function repliesSince(
  seen: SeenReplies | null,
  list: Assistants,
  now: number,
): { events: NotifyEvent[]; next: SeenReplies } {
  const next = new Map<string, string>()
  const events: NotifyEvent[] = []
  for (const a of list.agents) {
    const sig = replySignature(a)
    if (sig === null) {
      next.set(a.id, a.file === null ? NO_FILE : NO_REPLY)
      continue
    }
    const before = seen?.get(a.id)
    // The file showing up with a reply already in it (Relay connected after launch, a thin client's
    // mirror arriving) is a baseline like the first list; a reply after an empty file is news.
    if (before === undefined || before === NO_FILE || before === sig) {
      next.set(a.id, sig)
      continue
    }
    if (a.status === 'working') {
      next.set(a.id, before)
      continue
    }
    next.set(a.id, sig)
    if (a.reply === null || isNothingToReport(a.reply.text)) continue
    if (a.reply.at !== null && now - a.reply.at > REPLY_FRESH_MS) continue
    events.push({
      key: `reply:${a.id}:${sig}`,
      kind: 'reply',
      assistant: a.id,
      thread: assistantThread(a.id),
      title: a.title,
      body: clip(a.reply.text),
      silent: false,
      click: { link: `relay://assistant/${a.id}` },
    })
  }
  return { events, next }
}

// Waiting on Isaac ------------------------------------------------------------------------------

/**
 * The Working list's items that started waiting on Isaac (an approval, a question, a permission
 * prompt) since `seen`, which holds the ids that were waiting. Items already stale when first
 * heard are remembered, not announced.
 */
export function waitingSince(
  seen: ReadonlySet<string>,
  items: readonly ActivityItem[],
  now: number,
): { events: NotifyEvent[]; next: Set<string> } {
  const next = new Set<string>()
  const events: NotifyEvent[] = []
  for (const item of items) {
    if (item.status !== 'waiting') continue
    next.add(item.id)
    if (seen.has(item.id) || now - item.updatedAt > FRESH_MS) continue
    events.push(waitingEvent(item))
  }
  return { events, next }
}

const assistantOf = (owner: string): string | null =>
  owner.startsWith('assistant:') ? owner.slice('assistant:'.length) : null

function waitingEvent(item: ActivityItem): NotifyEvent {
  const assistant = assistantOf(item.owner)
  const open = item.open
  const thread = open.to === 'chat' ? open.thread : item.owner
  let click: NotifyEvent['click'] = { link: 'relay://open/chat' }
  if (open.to === 'canvas') click = { link: `relay://open/canvas?canvas=${open.slug}` }
  else if (assistant !== null) click = { link: `relay://assistant/${assistant}` }
  return {
    key: `waiting:${thread}`,
    kind: 'waiting',
    assistant,
    thread: assistant !== null ? assistantThread(assistant) : thread,
    title: `${item.title || 'Something'} is waiting on you`,
    body: clip(item.intent) || 'Open Relay to answer.',
    silent: false,
    click,
  }
}

/**
 * A chat of this app (or one Relay hears) changed status. `assistantOfFile` names the assistant
 * whose thread a session file is, so the chat's alerts share its key with the Working list's item
 * (one notification, not two) and its mute and focus rules. A finished assistant thread is the
 * assistant's reply, told by `repliesSince`, so only chats that are not a thread say Finished.
 */
export function chatAlertEvent(
  alert: ChatAlert,
  row: Pick<ChatRow, 'owner'> | undefined,
  assistantOfFile: (file: string) => string | null,
): NotifyEvent | null {
  const assistant = assistantOfFile(alert.file) ?? row?.owner?.agent ?? null
  if (alert.kind === 'finished' && assistantOfFile(alert.file) !== null) return null
  const waiting = alert.kind !== 'finished'
  return {
    key: waiting
      ? `waiting:${assistant !== null ? assistantThread(assistant) : `session:${sessionId(alert.file)}`}`
      : `finished:${alert.file}`,
    kind: waiting ? 'waiting' : 'finished',
    assistant,
    thread: assistant !== null ? assistantThread(assistant) : chatThread(alert.file),
    title: alert.title,
    body: alert.body,
    silent: !waiting,
    click: { chat: alert.file },
  }
}

// Canvas ----------------------------------------------------------------------------------------

/**
 * Live rooms that appeared since `seen` (the room ids heard so far): the Join card. The first
 * list is only remembered, and a room already ended is no invitation. `null` rooms (Relay down)
 * keep what was seen.
 */
export function roomsSince(
  seen: ReadonlySet<string> | null,
  rooms: readonly CanvasRoom[] | null,
): { events: NotifyEvent[]; next: Set<string> | null } {
  if (rooms === null) return { events: [], next: seen === null ? null : new Set(seen) }
  const next = new Set(rooms.map((r) => r.id))
  if (seen === null) return { events: [], next }
  const events: NotifyEvent[] = []
  for (const r of rooms) {
    if (seen.has(r.id) || !r.live) continue
    const board = r.board || r.slug
    const assistant = r.chat.assistant ?? null
    events.push({
      key: `canvas:${r.id}`,
      kind: 'canvas',
      assistant,
      thread: assistant !== null ? assistantThread(assistant) : null,
      title: `Join ${r.agent.name} on ${board}`,
      body: r.chat.title ? clip(r.chat.title) : 'A live canvas is open for you.',
      silent: false,
      click: { link: `relay://open/canvas?canvas=${r.slug}` },
    })
  }
  return { events, next }
}

// Update ----------------------------------------------------------------------------------------

/** "Update ready", once per build: null for a state with nothing pending or already announced. */
export function updateEvent(state: UpdateState, announced: string | null): NotifyEvent | null {
  if (!state.pending || state.build === null || state.build === announced) return null
  return {
    key: `update:${state.build}`,
    kind: 'update',
    assistant: null,
    thread: null,
    title: 'Relay update ready',
    body: state.summary ?? `Build ${state.build} is ready. Restart Relay to use it.`,
    silent: true,
    click: { link: 'relay://open/settings/about' },
  }
}
