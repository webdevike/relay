import { z } from 'zod'
import { CanvasChatEntrySchema } from './canvas-live'

export const ToolIoSchema = z.object({
  call: z.string(),
  input: z.string(),
  result: z.string().nullable(),
  isError: z.boolean(),
  status: z.enum(['running', 'done', 'failed']),
})

/**
 * `src` is a `data:image/...;base64,...` URL or a `blob:sha256:<64 hex>` token (or, for widget
 * images shown in the viewer, a `relay-media://` URL).
 */
export const ChatImageSchema = z.object({
  label: z.string(),
  src: z.string().optional(),
  mimeType: z.string().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
})
export type ChatImage = z.infer<typeof ChatImageSchema>

export const ChatMessageSchema = z.object({
  id: z.string(),
  /** `canvas`: a live canvas row (a `relay-canvas` custom message); `canvas` holds its entry. */
  role: z.enum(['user', 'assistant', 'tool', 'thinking', 'notice', 'canvas']),
  text: z.string(),
  detail: z.string(),
  streaming: z.boolean(),
  images: z.array(ChatImageSchema),
  tool: ToolIoSchema.optional(),
  unconfirmed: z.boolean().optional(),
  /**
   * omp's timestamp of a `user` or `assistant` row's message (epoch ms), its reaction key with the
   * role. Absent on a prompt omp has not echoed yet and on Relay's streaming row.
   */
  at: z.number().optional(),
  canvas: CanvasChatEntrySchema.optional(),
})
export type ChatMessage = z.infer<typeof ChatMessageSchema>
export type ToolIo = z.infer<typeof ToolIoSchema>

export const SessionMetaSchema = z.object({
  model: z.tuple([z.string(), z.string()]).nullable(),
  thinking: z.string().nullable(),
  contextTokens: z.number().nullable(),
  contextWindow: z.number().nullable().optional(),
})
export type SessionMeta = z.infer<typeof SessionMetaSchema>

export const DialogOptionSchema = z.object({
  label: z.string(),
  description: z.string().optional(),
})
export const AskQuestionSchema = z.object({
  id: z.string(),
  question: z.string(),
  header: z.string().optional(),
  options: z.array(DialogOptionSchema),
  recommended: z.number().optional(),
  multi: z.boolean(),
})
export const DialogSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('select'),
    id: z.string(),
    title: z.string(),
    options: z.array(DialogOptionSchema),
  }),
  z.object({
    kind: z.literal('confirm'),
    id: z.string(),
    title: z.string(),
    message: z.string(),
  }),
  z.object({
    kind: z.literal('input'),
    id: z.string(),
    title: z.string(),
    placeholder: z.string().optional(),
  }),
  z.object({
    kind: z.literal('editor'),
    id: z.string(),
    title: z.string(),
    placeholder: z.string().optional(),
    prefill: z.string().optional(),
  }),
  z.object({ kind: z.literal('ask'), id: z.string(), questions: z.array(AskQuestionSchema) }),
])
export type DialogOption = z.infer<typeof DialogOptionSchema>
export type AskQuestion = z.infer<typeof AskQuestionSchema>
export type Dialog = z.infer<typeof DialogSchema>

/** omp's goal for the session while active or paused (native chat.rs GoalInfo). */
export const GoalSchema = z.object({
  objective: z.string(),
  paused: z.boolean(),
  tokensUsed: z.number(),
})
export type Goal = z.infer<typeof GoalSchema>

export const SubagentSchema = z.object({
  name: z.string(),
  file: z.string(),
  done: z.boolean(),
  failed: z.boolean(),
  mtimeMs: z.number(),
  lastLine: z.string(),
  /** The tool it is running now (its newest call still without a result), else null. */
  tool: z.string().nullable(),
})
export type Subagent = z.infer<typeof SubagentSchema>

export const BgJobSchema = z.object({
  id: z.string(),
  label: z.string(),
  kind: z.string(),
  startedAt: z.number(),
})
export type BgJob = z.infer<typeof BgJobSchema>

export const ModelInfoSchema = z.object({
  provider: z.string(),
  id: z.string(),
  name: z.string(),
  contextWindow: z.number().nullable(),
  images: z.boolean(),
  levels: z.array(z.string()),
})
export type ModelInfo = z.infer<typeof ModelInfoSchema>

export function makeMessage(
  id: string,
  role: ChatMessage['role'],
  text: string,
  extra: Partial<ChatMessage> = {},
): ChatMessage {
  return { id, role, text, detail: '', streaming: false, images: [], ...extra }
}
