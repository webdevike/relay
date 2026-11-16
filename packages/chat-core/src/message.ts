import { z } from 'zod'
import { AgentRun as AgentRunShape, type AgentRun } from '@relay/protocol/agent-runs'
import { CanvasChatEntrySchema } from './canvas-live'
import { GuestEntrySchema } from './guest-entry'

export const ToolIoSchema = z.object({
  call: z.string(),
  input: z.string(),
  result: z.string().nullable(),
  isError: z.boolean(),
  status: z.enum(['running', 'done', 'failed']),
})

/** An `agents_ask` / `agents_result` call (`@relay/protocol` `AgentCall`), kept so its result can be read. */
export const AgentCallSchema = z.object({
  tool: z.enum(['agents_ask', 'agents_result']),
  agent: z.string().optional(),
  run: z.string().optional(),
  request: z.unknown().optional(),
})

/** A specialist run (`@relay/protocol` `AgentRun`), checked by the protocol's own schema. */
export const AgentRunSchema = z.custom<AgentRun>((v) => AgentRunShape.safeParse(v).success)

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
  /**
   * `canvas`: a live canvas row (a `relay-canvas` custom message); `canvas` holds its entry.
   * `guest`: another assistant in this chat (a `relay-guest` custom message); `guest` holds it.
   */
  role: z.enum(['user', 'assistant', 'tool', 'thinking', 'notice', 'canvas', 'guest']),
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
  guest: GuestEntrySchema.optional(),
  /** A tool row that is an agents call: the call as asked. */
  agentCall: AgentCallSchema.optional(),
  /** A tool row that is an agents call: the run it shows (running while the call is out). */
  agent: AgentRunSchema.optional(),
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
  price: z.object({ input: z.number(), output: z.number(), cached: z.number() }).optional(),
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
