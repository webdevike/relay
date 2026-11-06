import { z } from 'zod'
import { ChatMessageSchema } from '@evaos/chat-core/message'

/**
 * `@computer` runs (SPEC.md): main keeps each chat pane's run rows and the chat shows them after
 * the session's messages. A pane is matched by its id, or by its session file when it reopened
 * under a new id.
 */
const PaneRowsSchema = z.object({
  paneId: z.string(),
  file: z.string().nullable(),
  rows: z.array(ChatMessageSchema),
})
export type ComputerPaneRows = z.infer<typeof PaneRowsSchema>

export const computerInvoke = {
  /** The rows of every `@computer` run this pane (or this session file) has had since launch. */
  'computer.rows': {
    input: z.object({ paneId: z.string(), file: z.string().nullable() }).strict(),
    output: z.object({ rows: z.array(ChatMessageSchema) }),
  },
} as const

export const computerEvents = {
  /** A pane's `@computer` rows changed: the full list, oldest first. */
  'computer.rows': PaneRowsSchema,
} as const
