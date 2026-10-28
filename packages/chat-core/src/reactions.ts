// iMessage-style reactions (tapbacks) on chat bubbles, mirrored from Relay's protocol
// (relay packages/protocol/src/index.ts, "Reactions"): this app does not depend on @relay/protocol,
// so the keys, the thread names and the toggle rule live here and must stay identical to it.
// One reaction per bubble; the same emoji again clears it, another replaces it. The host keeps
// them per thread and pushes a thread's `reactions.snapshot` to every device on each change.
import { z } from 'zod'
import type { ChatMessage } from './message'

/** Protocol `untagged`: a leading `<surface>...</surface>` tag is the agent's, never shown. */
const LEADING_SURFACE = /^\s*<surface>[^<]*<\/surface>[\r\n]*/

/** The bar's quick picks, in order: heart, thumbs up, thumbs down, haha, emphasis, question. */
export const QUICK_REACTIONS = ['❤️', '👍', '👎', '😂', '‼️', '❓'] as const

/** The "more" grid: any other single emoji is valid, these are the ones offered here. */
export const MORE_REACTIONS = [
  '🔥',
  '🎉',
  '🙏',
  '👀',
  '💯',
  '✅',
  '🤔',
  '😮',
  '😢',
  '😍',
  '🙌',
  '👏',
  '🚀',
  '💡',
  '⭐',
  '😅',
  '🤯',
  '😬',
  '🫡',
  '💪',
] as const

/** Longest message excerpt a reaction carries. */
export const MAX_REACTION_EXCERPT = 200

/** One emoji (a grapheme of pictographs, joiners, selectors, keycaps or flags), at most 32 UTF-16 units. */
export const ReactionEmojiSchema = z
  .string()
  .min(1)
  .max(32)
  .regex(
    /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|\p{Emoji_Component}|\u200d|\ufe0f|\u20e3)+$/u,
  )
  .refine(
    (value) => /\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20e3/u.test(value),
    'not an emoji',
  )

/** `assistant:<agent id>` for an assistant's thread (it spans its sessions), else `session:<omp session id>`. */
export const ReactionThreadSchema = z.string().regex(/^(?:assistant:[a-z][a-z0-9-]*|session:\S+)$/)

/** A bubble's key, the same on every client: its role and omp timestamp (ms). Row ids are not. */
export const ReactionKeySchema = z.string().regex(/^(?:user|assistant)@\d+$/)

export const ReactionSchema = z.object({
  emoji: ReactionEmojiSchema,
  /** The start of the bubble's text. */
  excerpt: z.string().max(MAX_REACTION_EXCERPT),
  /** When Isaac reacted (epoch ms). */
  at: z.number(),
})
export type Reaction = z.infer<typeof ReactionSchema>

/** One thread's reactions by reaction key. */
export const ThreadReactionsSchema = z.record(ReactionKeySchema, ReactionSchema)
export type ThreadReactions = z.infer<typeof ThreadReactionsSchema>

/** The reaction thread of assistant `agent`. */
export function assistantReactionThread(agent: string): string {
  return `assistant:${agent}`
}

/** The reaction thread of a session: its assistant's thread when it runs one, else its own. */
export function sessionReactionThread(session: {
  readonly id: string
  readonly kind?: string | undefined
  readonly assistant?: string | null | undefined
}): string {
  return session.kind === 'assistant' && session.assistant
    ? assistantReactionThread(session.assistant)
    : `session:${session.id}`
}

/** The reaction key of a `user` or `assistant` bubble sent at `at` (epoch ms). */
export function reactionKey(role: 'user' | 'assistant', at: number): string {
  return `${role}@${Math.trunc(at)}`
}

/** A row's reaction key: user and assistant rows omp has stamped, else null (not reactable). */
export function reactionKeyOf(m: Pick<ChatMessage, 'role' | 'at'>): string | null {
  if ((m.role !== 'user' && m.role !== 'assistant') || m.at === undefined) return null
  return reactionKey(m.role, m.at)
}

/** What tapping `emoji` does to a bubble reacted `current` (null: none): the same clears, another replaces. */
export function toggleReaction(current: string | null, emoji: string): string | null {
  return current === emoji ? null : emoji
}

/** The excerpt sent with a reaction: the bubble's untagged text on one line, cut to MAX_REACTION_EXCERPT. */
export function reactionExcerpt(text: string): string {
  const tag = LEADING_SURFACE.exec(text)
  const line = (tag === null ? text : text.slice(tag[0].length)).replace(/\s+/g, ' ').trim()
  return line.length > MAX_REACTION_EXCERPT ? line.slice(0, MAX_REACTION_EXCERPT) : line
}
