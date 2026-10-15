import { z } from 'zod'
import {
  BgJobSchema,
  ChatMessageSchema,
  DialogSchema,
  ModelInfoSchema,
  SessionMetaSchema,
  SubagentSchema,
} from '@evaos/chat-core/message'
import { CHAT_STATUSES } from '@evaos/chat-core/status'

// Chat channels: transcript (01-03) and the live session (01-05).
export const PaneIdSchema = z.string().regex(/^[a-z0-9-]{1,32}$/)

export const SessionIdSchema = z.string().regex(/^[A-Za-z0-9._-]{1,128}$/)
export const ChatStatusSchema = z.enum(CHAT_STATUSES)
export const ApprovalSchema = z.enum(['yolo', 'write', 'always-ask'])
export const ProfileSchema = z.enum(['personal', 'work'])
export const HarnessSchema = z.enum(['omp', 'claude'])
const AbsPathSchema = z.string().min(1).startsWith('/')

/** base64 of at most 20 MB is about 26.7M characters. */
export const PromptImageSchema = z
  .object({
    mimeType: z.enum(['image/png', 'image/jpeg', 'image/gif', 'image/webp']),
    data: z.string().max(28_000_000),
  })
  .strict()

export const ChatRowSchema = z.object({
  id: z.string(),
  file: z.string(),
  title: z.string(),
  mtimeMs: z.number(),
  archived: z.boolean(),
  pinned: z.boolean(),
  running: z.boolean(),
  status: ChatStatusSchema.nullable(),
})
export const ChatPrefsSchema = z.object({
  chat_categories: z.array(z.string()),
  chat_group_order: z.array(z.string()),
  chat_assignments: z.record(SessionIdSchema, z.string().max(120)),
  collapsed_groups: z.array(z.string()),
})
export const ChatListSchema = z.object({
  rows: z.array(ChatRowSchema),
  prefs: ChatPrefsSchema,
  error: z.string().nullable(),
})

export const DialogResponseSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('select'), value: z.string().max(2000) }),
  z.object({ kind: z.literal('confirm'), confirmed: z.boolean() }),
  z.object({ kind: z.literal('text'), value: z.string().max(200_000) }),
  z.object({
    kind: z.literal('ask'),
    answers: z.array(
      z.union([
        z.object({ id: z.string().max(128), picked: z.array(z.string().max(2000)) }),
        z.object({ id: z.string().max(128), typed: z.string().max(200_000) }),
      ]),
    ),
  }),
  z.object({ kind: z.literal('cancel') }),
])

export const LaunchPatchSchema = z
  .object({
    model: z.object({ provider: z.string().max(120), modelId: z.string().max(200) }),
    thinking: z.string().max(32),
    approval: ApprovalSchema,
    profile: ProfileSchema.nullable(),
    fast: z.boolean(),
  })
  .partial()
  .strict()

export const LaunchStateSchema = z.object({
  approval: ApprovalSchema,
  profile: ProfileSchema.nullable(),
  model: z.tuple([z.string(), z.string()]).nullable(),
  thinking: z.string().nullable(),
  fast: z.boolean(),
  unsent: z.boolean(),
  harness: HarnessSchema,
  imagesAllowed: z.boolean(),
})

export const ExtrasSchema = z.object({
  paneId: PaneIdSchema,
  running: z.boolean(),
  subagents: z.array(SubagentSchema),
  jobs: z.array(BgJobSchema),
})

export type ChatList = z.infer<typeof ChatListSchema>
export type ChatRow = z.infer<typeof ChatRowSchema>
export type ChatPrefs = z.infer<typeof ChatPrefsSchema>
export type DialogResponse = z.infer<typeof DialogResponseSchema>
export type LaunchState = z.infer<typeof LaunchStateSchema>
export type LaunchPatch = z.infer<typeof LaunchPatchSchema>
export type Extras = z.infer<typeof ExtrasSchema>

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
      owner: PaneIdSchema.nullable().optional(),
    }),
  },
  'chat.send': {
    input: z
      .object({
        paneId: PaneIdSchema,
        text: z.string().max(200_000),
        images: z.array(PromptImageSchema).max(8).optional(),
        force: z.boolean().optional(),
      })
      .strict()
      .refine((v) => v.text.trim() !== '' || (v.images?.length ?? 0) > 0, {
        message: 'text or images required',
      }),
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
      dialog: DialogSchema.nullable().optional(),
      sessionFile: z.string().nullable().optional(),
    }),
  },
  'chat.list': { input: z.object({}).strict(), output: ChatListSchema },
  'chat.setCollapsed': {
    input: z.object({ groups: z.array(z.string().max(120)).max(200) }).strict(),
    output: z.object({ saved: z.literal(true) }),
  },
  'chat.setCategories': {
    input: z
      .object({
        chat_categories: ChatPrefsSchema.shape.chat_categories,
        chat_group_order: ChatPrefsSchema.shape.chat_group_order,
        chat_assignments: ChatPrefsSchema.shape.chat_assignments,
      })
      .strict(),
    output: z.object({ saved: z.literal(true) }),
  },
  'chat.archive': {
    input: z.object({ id: SessionIdSchema, archived: z.boolean() }).strict(),
    output: z.object({ archived: z.array(SessionIdSchema) }),
  },
  'chat.pin': {
    input: z.object({ id: SessionIdSchema, pinned: z.boolean() }).strict(),
    output: z.object({ pins: z.array(SessionIdSchema) }),
  },
  'chat.rename': {
    input: z.object({ file: AbsPathSchema, name: z.string().trim().min(1).max(200) }).strict(),
    output: z.object({ title: z.string(), via: z.enum(['rpc', 'resume']) }),
  },
  'chat.delete': {
    input: z.object({ file: AbsPathSchema }).strict(),
    output: z.object({ deleted: z.literal(true) }),
  },
  'chat.openDraft': {
    input: z.object({ paneId: PaneIdSchema }).strict(),
    output: z.object({ meta: SessionMetaSchema, harness: HarnessSchema }),
  },
  'chat.answerUi': {
    input: z
      .object({ paneId: PaneIdSchema, id: z.string().max(128), response: DialogResponseSchema })
      .strict(),
    output: z.object({ sent: z.boolean() }),
  },
  'chat.models': {
    input: z.object({}).strict(),
    output: z.object({ models: z.array(ModelInfoSchema) }),
  },
  'chat.launchState': {
    input: z.object({ paneId: PaneIdSchema }).strict(),
    output: LaunchStateSchema,
  },
  'chat.setLaunch': {
    input: z.object({ paneId: PaneIdSchema, patch: LaunchPatchSchema }).strict(),
    output: LaunchStateSchema,
  },
  'chat.readImage': {
    input: z.object({ token: z.string().regex(/^blob:sha256:[a-f0-9]{64}$/) }).strict(),
    output: z.object({
      dataUrl: z.string(),
      width: z.number().nullable(),
      height: z.number().nullable(),
    }),
  },
  'chat.harnessStatus': {
    input: z.object({}).strict(),
    output: z.object({ omp: z.boolean(), claude: z.boolean() }),
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
    contextWindow: z.number().nullable(),
    thinking: z.string().nullable(),
    dialog: DialogSchema.nullable(),
    sessionFile: z.string().nullable(),
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

export const chatEvents = {
  'chat.batch': BatchSchema,
  'chat.listChanged': ChatListSchema,
  'chat.extras': ExtrasSchema,
} as const
