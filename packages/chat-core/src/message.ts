import { z } from 'zod'

export const ToolIoSchema = z.object({
  call: z.string(),
  input: z.string(),
  result: z.string().nullable(),
  isError: z.boolean(),
  status: z.enum(['running', 'done', 'failed']),
})

export const ChatMessageSchema = z.object({
  id: z.string(),
  role: z.enum(['user', 'assistant', 'tool', 'thinking', 'notice']),
  text: z.string(),
  detail: z.string(),
  streaming: z.boolean(),
  images: z.array(z.object({ label: z.string() })),
  tool: ToolIoSchema.optional(),
  unconfirmed: z.boolean().optional(),
})
export type ChatMessage = z.infer<typeof ChatMessageSchema>
export type ToolIo = z.infer<typeof ToolIoSchema>

export const SessionMetaSchema = z.object({
  model: z.tuple([z.string(), z.string()]).nullable(),
  thinking: z.string().nullable(),
  contextTokens: z.number().nullable(),
})
export type SessionMeta = z.infer<typeof SessionMetaSchema>

export function makeMessage(
  id: string,
  role: ChatMessage['role'],
  text: string,
  extra: Partial<ChatMessage> = {},
): ChatMessage {
  return { id, role, text, detail: '', streaming: false, images: [], ...extra }
}
