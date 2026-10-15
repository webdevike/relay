import { z } from 'zod'
import { ChatMessageSchema, SessionMetaSchema } from '@evaos/chat-core/message'

// Chat channels. Plan 01-05 adds the live-session keys and events.
export const PaneIdSchema = z.string().regex(/^[a-z0-9-]{1,32}$/)

export const chatInvoke = {
  'chat.listSessions': {
    input: z.object({}).strict(),
    output: z.object({
      sessions: z.array(z.object({ file: z.string(), title: z.string(), mtimeMs: z.number() })),
    }),
  },
  'chat.open': {
    input: z
      .object({
        paneId: PaneIdSchema,
        file: z.string().min(1).startsWith('/'),
      })
      .strict(),
    output: z.object({
      title: z.string(),
      messages: z.array(ChatMessageSchema),
      meta: SessionMetaSchema,
    }),
  },
} as const
export const chatEvents = {} as const
