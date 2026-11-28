// The ticket page's comments as threads, the writes Isaac made on this visit layered over them, who
// can be mentioned and which assistants make a message private. Pure: no React, no IPC.
import type { TicketActor, TicketComment, TicketDetail } from '@relay/protocol'
import { emojify } from '@relay/slack-emoji'
import type { WriteMode } from './ticket-data'

/** A root comment and its replies (Linear replies point at the root), oldest first. */
export interface Thread {
  root: TicketComment
  replies: TicketComment[]
}

/**
 * Comments as threads by root id: a reply whose parent is itself a reply joins that reply's root,
 * one whose parent is missing (deleted, not synced) stands as its own root. Roots and replies
 * oldest first; emoji-only replies are replies like any other.
 */
export function threadsOf(comments: readonly TicketComment[]): Thread[] {
  const byId = new Map(comments.map((c) => [c.id, c]))
  const rootOf = (c: TicketComment): TicketComment => {
    const seen = new Set<string>()
    let cur = c
    while (cur.parentId !== null && !seen.has(cur.id)) {
      seen.add(cur.id)
      const parent = byId.get(cur.parentId)
      if (!parent) break
      cur = parent
    }
    return cur
  }
  const threads = new Map<string, Thread>()
  const sorted = [...comments].sort((a, b) => a.at - b.at)
  for (const c of sorted) if (rootOf(c) === c) threads.set(c.id, { root: c, replies: [] })
  for (const c of sorted) {
    const root = rootOf(c)
    if (root !== c) threads.get(root.id)?.replies.push(c)
  }
  return [...threads.values()]
}

/** The thread holding comment `id` (a root or a reply), or null when it isn't on the page. */
export function focusTarget(
  threads: readonly Thread[],
  id: string | null,
): { rootId: string; commentId: string } | null {
  if (!id) return null
  for (const t of threads) {
    if (t.root.id === id || t.replies.some((r) => r.id === id)) {
      return { rootId: t.root.id, commentId: id }
    }
  }
  return null
}

const ONE_EMOJI =
  '(?:\\p{Extended_Pictographic}(?:\\uFE0F|\\p{Emoji_Modifier})*(?:\\u200D\\p{Extended_Pictographic}(?:\\uFE0F|\\p{Emoji_Modifier})*)*|\\p{Regional_Indicator}{2})'
const EMOJI_ONLY = new RegExp(`^${ONE_EMOJI}+$`, 'u')

/** Only emoji (and `:shortcode:`s), nothing else: a 👍 reply. */
export function isEmojiOnly(text: string): boolean {
  return EMOJI_ONLY.test(emojify(text).replace(/\s+/g, ''))
}

/** Writes Isaac made on this visit, shown until the host's ticket has them. */
export interface LocalEdits {
  posted: TicketComment[]
  deleted: string[]
  edited: Record<string, string>
  /** Root id: resolved (true) or reopened (false). */
  resolved: Record<string, boolean>
  /** `reactionKey`: on or off. */
  reacted: Record<string, boolean>
}

export const NO_EDITS: LocalEdits = {
  posted: [],
  deleted: [],
  edited: {},
  resolved: {},
  reacted: {},
}

export const reactionKey = (commentId: string, emoji: string): string => `${commentId}\n${emoji}`

type Reactions = TicketComment['reactions']

/** The reactions with Isaac's own set to `on` for `emoji`. */
export function setReaction(
  reactions: Reactions,
  emoji: string,
  on: boolean,
  me: TicketActor,
): Reactions {
  const others = (users: TicketActor[]) => users.filter((u) => u.id !== me.id)
  const has = reactions.some((r) => r.emoji === emoji)
  const base = has || !on ? reactions : [...reactions, { emoji, users: [] }]
  return base
    .map((r) =>
      r.emoji === emoji ? { ...r, users: on ? [...others(r.users), me] : others(r.users) } : r,
    )
    .filter((r) => r.users.length > 0)
}

function withEdits(c: TicketComment, local: LocalEdits, me: TicketActor | null, now: number) {
  const body = local.edited[c.id]
  const resolved = local.resolved[c.id]
  let out = body === undefined ? c : { ...c, body, editedAt: c.editedAt ?? now }
  if (resolved !== undefined) out = { ...out, resolvedAt: resolved ? (c.resolvedAt ?? now) : null }
  if (!me) return out
  for (const [key, on] of Object.entries(local.reacted)) {
    const [id, emoji] = key.split('\n') as [string, string]
    if (id === c.id) out = { ...out, reactions: setReaction(out.reactions, emoji, on, me) }
  }
  return out
}

/** The host's comments with this visit's writes applied: posted ones it hasn't sent yet, deletes, edits, resolves, reactions. */
export function withLocal(
  comments: readonly TicketComment[],
  local: LocalEdits,
  me: TicketActor | null,
  now: number,
): TicketComment[] {
  const ids = new Set(comments.map((c) => c.id))
  const gone = new Set(local.deleted)
  const all = [...comments, ...local.posted.filter((c) => !ids.has(c.id))]
  // A deleted root takes its replies with it.
  return all
    .filter((c) => !gone.has(c.id) && !(c.parentId !== null && gone.has(c.parentId)))
    .map((c) => withEdits(c, local, me, now))
}

export type CommentAction =
  'edit' | 'resolve' | 'unresolve' | 'copyLink' | 'copyMarkdown' | 'newIssue' | 'delete'

/** The "..." menu of a comment: copies always; writes through the gate only; edit and delete on Isaac's own. */
export function commentActions(
  c: TicketComment,
  opts: { meId: string | null; isRoot: boolean; writeMode: WriteMode },
): CommentAction[] {
  const out: CommentAction[] = []
  const gate = opts.writeMode === 'gate'
  const mine = gate && opts.meId !== null && c.author?.id === opts.meId
  if (mine) out.push('edit')
  if (gate && opts.isRoot) out.push(c.resolvedAt === null ? 'resolve' : 'unresolve')
  out.push('copyLink', 'copyMarkdown')
  if (gate) out.push('newIssue')
  if (mine) out.push('delete')
  return out
}

/** Someone a comment can @mention; `url` is their Linear profile (empty: unknown, the name stays text). */
export interface Person {
  /** The Linear user id, when known. */
  id?: string
  name: string
  handle: string
  url: string
  /** Set for the ticket's people (null: no picture), absent for assistants. */
  avatarUrl?: string | null
  /** A Relay assistant: a message to her stays private. */
  assistant?: true
}

const handleOf = (url: string | undefined, name: string): string =>
  /\/profiles\/([\w.-]+)/.exec(url ?? '')?.[1] ?? name

/** Everyone on the ticket (assignee, creator, commenters, reactors), once each. */
export function peopleOf(d: TicketDetail): Person[] {
  const actors = [
    d.assignee,
    d.creator,
    ...d.comments.flatMap((c) => [c.author, ...c.reactions.flatMap((r) => r.users)]),
  ]
  const seen = new Map<string, Person>()
  for (const a of actors) {
    if (!a || seen.has(a.id)) continue
    seen.set(a.id, {
      id: a.id,
      name: a.name,
      handle: handleOf(a.url, a.name),
      url: a.url ?? '',
      avatarUrl: a.avatarUrl,
    })
  }
  return [...seen.values()]
}

/** Relay's assistants: mentioning one makes the message a private ask in Relay (never posted). */
export const ASSISTANTS: readonly Person[] = ['Astra', 'Nova', 'Penny', 'Iris', 'Polaris'].map(
  (name) => ({ name, handle: name, url: '', assistant: true }),
)

const mentions = (text: string, name: string): boolean =>
  new RegExp(`(^|\\s)@${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`, 'i').test(text)

/** The assistants `text` mentions. */
export function assistantsIn(text: string): Person[] {
  return ASSISTANTS.filter((a) => mentions(text, a.name))
}

/**
 * Where a message goes: `public` (posted), `private` (an assistant is mentioned: Relay only), or
 * `mixed` (an assistant and a person: still private, and Isaac is told to write people separately).
 */
export function privacyOf(text: string, people: readonly Person[]): 'public' | 'private' | 'mixed' {
  if (assistantsIn(text).length === 0) return 'public'
  const person = people.some(
    (p) => !p.assistant && (mentions(text, p.name) || mentions(text, p.handle)),
  )
  return person ? 'mixed' : 'private'
}

/** The team's `Todo` state by exact name, or null when there is none or more than one (Isaac picks). */
export function todoState<S extends { id: string; name: string }>(states: readonly S[]): S | null {
  const todo = states.filter((s) => s.name === 'Todo')
  return todo.length === 1 ? todo[0]! : null
}

/** A new issue's title from a comment: its first line, plain, at most 120 characters. */
export function issueTitleOf(body: string): string {
  const line = body.split('\n').find((l) => l.trim()) ?? ''
  return line
    .replace(/^[#>*\-\s]+/, '')
    .trim()
    .slice(0, 120)
}

/** The ticket as the first message of its private assistant session (as reviews' ticketContext). */
export function detailContext(d: TicketDetail): string {
  const byId = new Map(d.comments.map((c) => [c.id, c]))
  const name = (a: TicketActor | null): string => a?.name ?? 'Someone'
  const comments = d.comments.map((c) => {
    const parent = c.parentId ? byId.get(c.parentId) : undefined
    const reply = parent ? ` replying to ${name(parent.author)}` : ''
    const at = new Date(c.at).toISOString().slice(0, 16).replace('T', ' ')
    return `- ${name(c.author)}${reply}, ${at}: ${c.body.trim()}`
  })
  return [
    `### Linear ticket ${d.key}: ${d.title}`,
    d.url,
    `${d.state.name} · assignee ${d.assignee?.name ?? 'none'} · project ${d.project?.name ?? 'none'} · team ${d.team.key}`,
    '',
    '#### Description',
    d.description.trim() || '(none)',
    '',
    '#### Comments (oldest first; replies name the comment they answer)',
    comments.length === 0 ? '(no comments)' : comments.join('\n'),
  ].join('\n')
}
