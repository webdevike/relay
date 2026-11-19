import { z } from 'zod'
import { OmpProfileSchema } from './setup'

/**
 * Where an agent stands, as the Relay Host derives it (its thread's session plus the work it owns,
 * protocol `AssistantStatus`): `not-started` while Relay lists no session for it and nothing runs.
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

/**
 * The one-tap fix of a failed turn or a signed-out profile (protocol `SigninFix`): sign omp
 * provider `provider` (`anthropic`, `openai-codex`, ...) in again under omp profile `profile`
 * (absent: omp's default profile), on the Mac Relay Host runs on.
 */
export const SigninFixSchema = z.object({
  kind: z.literal('signin'),
  provider: z.string().min(1),
  profile: OmpProfileSchema.optional(),
})
export type SigninFix = z.infer<typeof SigninFixSchema>

/**
 * How an assistant's omp profile is signed in to its model's provider on the host (protocol
 * `ProfileAuth`): `ok`; `signed_out` (every credential it had is disabled, e.g. an expired OAuth
 * refresh); `missing` (it never had one); `shared` (a copy of another profile's sign-in, which the
 * first of the two to refresh signs out). `detail` says why in one sentence for any state but `ok`.
 */
export const ProfileAuthSchema = z.object({
  /** Absent: omp's default profile. */
  profile: OmpProfileSchema.optional(),
  provider: z.string().min(1),
  state: z.enum(['ok', 'signed_out', 'missing', 'shared']),
  detail: z.string().optional(),
  /** The account signed in (its email), when the credential names one. */
  account: z.string().optional(),
})
export type ProfileAuth = z.infer<typeof ProfileAuthSchema>

/**
 * The thread's newest failed turn with no reply since, as the host says it (protocol `TurnFailure`):
 * its sign-in is missing or expired (`auth`), a rate or usage limit (`rate_limit`), another model
 * error (`model`), or omp stopped mid-turn (`exit`). A turn that failed before it started is in no
 * session file, so this is the only place it shows.
 */
export const TurnFailureSchema = z.object({
  at: z.number(),
  kind: z.enum(['auth', 'rate_limit', 'model', 'exit']),
  /** e.g. "Nova couldn't reply". */
  title: z.string(),
  /** omp's reason and what to do, in plain words. */
  text: z.string(),
  /** One this build cannot read is dropped, keeping the failure. */
  fix: SigninFixSchema.optional().catch(undefined),
})
export type TurnFailure = z.infer<typeof TurnFailureSchema>

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
  /**
   * Work it owns that runs now besides its own turn (sessions it started, its thread's helpers),
   * as the host counts it; `status` is `working` while it is above 0.
   */
  background: z.number().int().nonnegative(),
  /** Its thread's own turn runs now (Relay's session is working), apart from any background work. */
  turn: z.boolean(),
  /** The tool Relay hears its thread running now (`working` only, e.g. `web_search`), else null. */
  tool: z.string().nullable(),
  /** Its thread's session file once omp wrote it, else null (the page is the start card). */
  file: z.string().nullable(),
  /** The newest assistant reply with text, on one line, and when omp wrote it (epoch ms). */
  reply: z.object({ text: z.string(), at: z.number().nullable() }).nullable(),
  /** The omp profile it runs under, as the host says; absent for omp's default profile. */
  profile: OmpProfileSchema.optional(),
  /** How its profile is signed in to its model's provider, when the host could read it. */
  auth: ProfileAuthSchema.optional(),
  /** Its newest failed turn with no reply since; the host clears it when a reply lands. */
  failure: TurnFailureSchema.optional(),
})
export type Assistant = z.infer<typeof AssistantSchema>

export const AssistantsSchema = z.object({
  /** Registry order. */
  agents: z.array(AssistantSchema),
  /** Relay is connected, so an agent can be started from here. */
  relayUp: z.boolean(),
  /**
   * A thin client's host Mac by name: the assistants' omp sign-ins live there, so a sign-in run on
   * this Mac would sign in the wrong omp. Absent when Relay Host runs on this Mac.
   */
  hostMac: z.string().optional(),
})
export type Assistants = z.infer<typeof AssistantsSchema>

export const assistantsInvoke = {
  'assistants.list': { input: z.object({}).strict(), output: AssistantsSchema },
  /** Sends "Hi <Title>" to the agent's thread through Relay; the host starts it if needed. */
  'assistants.start': {
    input: z.object({ agent: z.string().min(1).max(128) }).strict(),
    output: z.object({ started: z.literal(true) }),
  },
  /** Sends `text` into the agent's thread through Relay as Isaac (a chat that is not on screen). */
  'assistants.turn': {
    input: z
      .object({ agent: z.string().min(1).max(128), text: z.string().min(1).max(4000) })
      .strict(),
    output: z.object({ sent: z.literal(true) }),
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
  /**
   * Sets the agent's registry model through Relay (`assistant.configure`): `provider/id`, optionally
   * `:thinking`. It applies when the agent's session next starts; `assistants.changed` follows.
   */
  'assistants.configure': {
    input: z
      .object({ agent: z.string().min(1).max(128), model: z.string().trim().min(1).max(120) })
      .strict(),
    output: z.object({ set: z.literal(true) }),
  },
} as const

export const assistantsEvents = {
  'assistants.changed': AssistantsSchema,
} as const
