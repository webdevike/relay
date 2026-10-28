import { z } from 'zod'
import {
  MAX_REACTION_EXCERPT,
  ReactionEmojiSchema,
  ReactionKeySchema,
  ReactionThreadSchema,
  ThreadReactionsSchema,
} from '@evaos/chat-core/reactions'

/** A thread's reactions as the renderer shows them, and whether Relay can take a change now. */
export const ReactionsViewSchema = z.object({
  /** The thread (`assistant:<id>` or `session:<id>`); null for a chat without a session yet. */
  thread: ReactionThreadSchema.nullable(),
  /** Relay is connected, so a reaction can be sent. */
  up: z.boolean(),
  /** As the host last sent them; empty before its first snapshot. */
  reactions: ThreadReactionsSchema,
})
export type ReactionsView = z.infer<typeof ReactionsViewSchema>

export const reactionsInvoke = {
  /**
   * Follows the reactions of the chat in `file` (an assistant page names its `agent`): resolves its
   * thread, asks Relay for them now and after every reconnect, until `reactions.unwatch`.
   */
  'reactions.watch': {
    input: z.object({ file: z.string().max(4096), agent: z.string().max(128).nullable() }).strict(),
    output: ReactionsViewSchema,
  },
  'reactions.unwatch': {
    input: z.object({ thread: ReactionThreadSchema }).strict(),
    output: z.object({}),
  },
  /** Reacts `emoji` to bubble `message` of `thread`, or clears it (null). No ack: the next snapshot says. */
  'reactions.react': {
    input: z
      .object({
        thread: ReactionThreadSchema,
        message: ReactionKeySchema,
        emoji: ReactionEmojiSchema.nullable(),
        excerpt: z.string().max(MAX_REACTION_EXCERPT),
      })
      .strict(),
    output: z.object({ sent: z.boolean() }),
  },
} as const

export const reactionsEvents = {
  /** A watched thread's reactions as the host's latest snapshot has them. */
  'reactions.changed': ReactionsViewSchema.extend({ thread: ReactionThreadSchema }),
  /** Relay came up or went down: a chat whose thread was resolved without it resolves it again. */
  'reactions.status': z.object({ up: z.boolean() }),
} as const
