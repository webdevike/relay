import { z } from 'zod'

/**
 * Where an agent's thread stands, from what Relay reports about its session (native
 * assistants_view::Status): `not-started` while Relay lists no session for it.
 */
export const AssistantStatusSchema = z.enum(['working', 'needs-you', 'idle', 'not-started'])
export type AssistantStatus = z.infer<typeof AssistantStatusSchema>

/**
 * How an agent's portrait is drawn: a DiceBear `style` from `seed`, the registry's explicit part
 * `options` (e.g. micah's `glasses: ["round"]`) and its colors (`paper` fills the disc behind it,
 * `accent` tints its animations). A registry seed alone draws notionists.
 */
export const AssistantPortraitSchema = z.object({
  style: z.enum(['notionists', 'micah']),
  seed: z.string().min(1),
  options: z.record(z.string(), z.union([z.array(z.string()), z.number(), z.boolean()])).optional(),
  colors: z
    .object({
      paper: z
        .string()
        .regex(/^#[0-9a-fA-F]{6}$/)
        .optional(),
      accent: z
        .string()
        .regex(/^#[0-9a-fA-F]{6}$/)
        .optional(),
    })
    .optional(),
})
export type AssistantPortrait = z.infer<typeof AssistantPortraitSchema>

export const AssistantSchema = z.object({
  /** The registry id (`.omp/assistant/agents.json`), e.g. `astra`. */
  id: z.string(),
  title: z.string(),
  /** What the agent covers; empty when the registry gives none. */
  scope: z.string(),
  /** Its portrait: the registry's designed one, else notionists from its seed, else from the id. */
  avatar: AssistantPortraitSchema,
  /** The omp model the registry starts it on (`provider/id`, maybe `:thinking`), when it names one. */
  model: z.string().optional(),
  status: AssistantStatusSchema,
  /** The tool Relay hears its thread running now (`working` only, e.g. `web_search`), else null. */
  tool: z.string().nullable(),
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
  /**
   * Adds an assistant through Relay (`assistant.create`): the host writes its registry entry and a
   * first-run prime, then opens its thread with "Hi <title>"; the assistant gets to know Isaac by
   * chatting and names itself. Without a title it is "New assistant" (numbered when taken). Answers its id.
   */
  'assistants.create': {
    input: z.object({ title: z.string().trim().min(1).max(40).optional() }).strict(),
    output: z.object({ id: z.string().min(1) }),
  },
} as const

export const assistantsEvents = {
  'assistants.changed': AssistantsSchema,
} as const
