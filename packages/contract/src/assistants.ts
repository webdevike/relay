import { z } from 'zod'

/**
 * Where an agent's thread stands, from what Relay reports about its session (native
 * assistants_view::Status): `not-started` while Relay lists no session for it.
 */
export const AssistantStatusSchema = z.enum(['working', 'needs-you', 'idle', 'not-started'])
export type AssistantStatus = z.infer<typeof AssistantStatusSchema>

export const AssistantSchema = z.object({
  /** The registry id (`.omp/assistant/agents.json`), e.g. `astra`. */
  id: z.string(),
  title: z.string(),
  /** What the agent covers; empty when the registry gives none. */
  scope: z.string(),
  /** Its portrait's seed (DiceBear notionists, as Rooms draws people); the id when none is set. */
  avatar: z.string(),
  status: AssistantStatusSchema,
  /** Its thread's session file once omp wrote it, else null (the page is the start card). */
  file: z.string().nullable(),
  /** The newest assistant reply with text, on one line, and when omp wrote it (epoch ms). */
  reply: z.object({ text: z.string(), at: z.number().nullable() }).nullable(),
})
export type Assistant = z.infer<typeof AssistantSchema>

export const AssistantsSchema = z.object({
  /** Registry order. */
  agents: z.array(AssistantSchema),
  /** Relay is connected, so an agent can be started from here. */
  relayUp: z.boolean(),
})
export type Assistants = z.infer<typeof AssistantsSchema>

export const assistantsInvoke = {
  'assistants.list': { input: z.object({}).strict(), output: AssistantsSchema },
  /** Sends "Hi <Title>" to the agent's thread through Relay; the host starts it if needed. */
  'assistants.start': {
    input: z.object({ agent: z.string().min(1).max(128) }).strict(),
    output: z.object({ started: z.literal(true) }),
  },
} as const

export const assistantsEvents = {
  'assistants.changed': AssistantsSchema,
} as const
