import { z } from 'zod'

// Passthrough (loose) schemas for the omp rpc-ui v1 frames the reducer consumes.
// Unknown frame types are forward compatible: they become { type: 'unknown', raw }, never errors.
// Protocol stays v1: there is deliberately no protocol negotiation command here.

const block = z.looseObject({ type: z.string() })
const message = z.looseObject({
  role: z.string(),
  content: z.union([z.string(), z.array(block)]).optional(),
  stopReason: z.string().optional(),
  usage: z.unknown().optional(),
})
const withMessage = { message, messageId: z.string().optional() }

const obj = <T extends string, S extends z.ZodRawShape>(type: T, shape: S) =>
  z.looseObject({ type: z.literal(type), ...shape })

export const FrameSchema = z.discriminatedUnion('type', [
  obj('ready', {
    protocolVersion: z.number().optional(),
    supportedProtocolVersions: z.array(z.number()).optional(),
    maxFrameBytes: z.number().optional(),
    maxReassembledFrameBytes: z.number().optional(),
  }),
  obj('response', {
    id: z.string().optional(),
    command: z.string().optional(),
    success: z.boolean(),
    error: z.string().optional(),
    data: z.unknown().optional(),
  }),
  obj('agent_start', {}),
  obj('turn_start', {}),
  obj('turn_end', { message: message.optional(), toolResults: z.array(z.unknown()).optional() }),
  obj('agent_end', { messages: z.array(message).optional(), messageCount: z.number().optional() }),
  obj('message_start', withMessage),
  obj('message_update', { ...withMessage, assistantMessageEvent: z.unknown().optional() }),
  obj('message_end', withMessage),
  obj('tool_execution_start', { toolCallId: z.string(), toolName: z.string() }),
  obj('tool_execution_update', { toolCallId: z.string() }),
  obj('tool_execution_end', {
    toolCallId: z.string(),
    toolName: z.string().optional(),
    isError: z.boolean().optional(),
  }),
  obj('prompt_result', {
    id: z.string().optional(),
    status: z.enum(['completed', 'aborted', 'error']),
    agentInvoked: z.boolean().optional(),
    sessionSettled: z.boolean().optional(),
  }),
  obj('session_settled', {}),
  obj('queue_update', { steering: z.array(z.string()), followUp: z.array(z.string()) }),
  obj('extension_ui_request', { id: z.string(), method: z.string() }),
  obj('notice', { level: z.string().optional(), message: z.string() }),
  obj('rpc_frame_error', { message: z.string().optional() }),
  obj('_stderr', { line: z.string() }),
  obj('_eof', {}),
])

export type KnownFrame = z.infer<typeof FrameSchema>
export type UnknownFrame = { type: 'unknown'; raw: unknown }

export function parseFrame(obj: unknown): KnownFrame | UnknownFrame {
  const r = FrameSchema.safeParse(obj)
  return r.success ? r.data : { type: 'unknown', raw: obj }
}

export const cmd = {
  // Rust sends streamingBehavior 'steer' on every prompt, so a prompt sent mid-turn is a steer.
  prompt: (id: string, message: string) => ({
    type: 'prompt' as const,
    id,
    message,
    streamingBehavior: 'steer' as const,
  }),
  abort: (id: string) => ({ type: 'abort' as const, id }),
  getState: (id: string) => ({ type: 'get_state' as const, id }),
  setAskDialog: (id: string) => ({ type: 'set_ask_dialog' as const, enabled: true, id }),
  cancelUi: (requestId: string) => ({
    type: 'extension_ui_response' as const,
    id: requestId,
    cancelled: true as const,
  }),
}
