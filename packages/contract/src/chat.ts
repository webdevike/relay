import { z } from 'zod'
import { ChatMessageSchema, SessionMetaSchema } from '@evaos/chat-core/message'

// Chat channels: transcript (01-03) and the live session (01-05).
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
  'chat.send': {
    input: z.object({ paneId: PaneIdSchema, text: z.string().min(1).max(200_000) }).strict(),
    output: z.object({ accepted: z.literal(true) }),
  },
  'chat.abort': {
    input: z.object({ paneId: PaneIdSchema }).strict(),
    output: z.object({ sent: z.boolean() }),
  },
  'chat.close': {
    input: z.object({ paneId: PaneIdSchema }).strict(),
    output: z.object({
      exit: z
        .object({
          code: z.number().nullable(),
          signal: z.string().nullable(),
          timedOut: z.boolean(),
        })
        .nullable(),
    }),
  },
  'chat.snapshot': {
    input: z.object({ paneId: PaneIdSchema }).strict(),
    // A resync replaces the pane wholesale, so the snapshot carries every field a meta op can.
    output: z.object({
      seq: z.number().int().nonnegative(),
      messages: z.array(ChatMessageSchema),
      meta: SessionMetaSchema,
      running: z.boolean(),
      connected: z.boolean(),
      error: z.string().nullable(),
    }),
  },
} as const

export const MetaPatchSchema = z
  .object({
    running: z.boolean(),
    connected: z.boolean(),
    error: z.string().nullable(),
    notice: z.string().nullable(),
    model: z.tuple([z.string(), z.string()]).nullable(),
    contextTokens: z.number().nullable(),
  })
  .partial()

export const OpSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('upsert'),
    message: ChatMessageSchema,
    at: z.number().int().optional(),
  }),
  z.object({ op: z.literal('remove'), id: z.string() }),
  z.object({ op: z.literal('meta'), patch: MetaPatchSchema }),
])
export const BatchSchema = z.object({
  paneId: PaneIdSchema,
  seq: z.number().int().positive(),
  ops: z.array(OpSchema),
})
export type Batch = z.infer<typeof BatchSchema>
export type Op = z.infer<typeof OpSchema>

export const chatEvents = { 'chat.batch': BatchSchema } as const
