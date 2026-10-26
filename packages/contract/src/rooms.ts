import { z } from 'zod'

/** Isaac's author id in a room; every other author is a RoomAgent id, `judge` or `system`. */
export const ROOM_ISAAC = 'isaac'
/** The convergence judge, the summary's author when no PM is in the room. */
export const ROOM_JUDGE = 'judge'
/** The room itself: notices about a dropped agent or a failure. */
export const ROOM_SYSTEM = 'system'

export const RoomAgentSchema = z.object({
  id: z.string(),
  /** The person's full name, e.g. "Mara Voss". */
  name: z.string(),
  /** Job title, e.g. "Principal Engineer". */
  title: z.string(),
  /** The persona behind the person: Skeptic, Builder, User advocate, PM, Ops. */
  role: z.string(),
  /** One paragraph on how this person argues; the heart of the system prompt. */
  brief: z.string(),
  /** The exact omp model id, `provider/model`. */
  model: z.string(),
  /** A Mantine theme color name, e.g. "orange". */
  color: z.string(),
  /** The process died or never started; the room goes on without them. */
  failed: z.boolean().optional(),
})
export type RoomAgent = z.infer<typeof RoomAgentSchema>

export const RoomReactionSchema = z.object({
  emoji: z.string(),
  /** Author ids, `isaac` included, in the order they reacted. */
  by: z.array(z.string()),
})
export type RoomReaction = z.infer<typeof RoomReactionSchema>

export const RoomMessageSchema = z.object({
  id: z.string(),
  /** `isaac`, an agent id, `judge` or `system`. */
  author: z.string(),
  text: z.string(),
  ts: z.number(),
  reactions: z.array(RoomReactionSchema),
  /** A summary is the pinned decision that closes the room. */
  kind: z.enum(['message', 'summary']),
})
export type RoomMessage = z.infer<typeof RoomMessageSchema>

/**
 * open: agents talk. wrapping: the soft clock passed, everyone is told to close. resolved: the
 * summary is pinned and saved. failed: nobody could talk (omp missing, every agent dead).
 */
export const RoomPhaseSchema = z.enum(['open', 'wrapping', 'resolved', 'failed'])
export type RoomPhase = z.infer<typeof RoomPhaseSchema>

export const RoomJudgeSchema = z.object({
  verdict: z.enum(['continue', 'converged']),
  note: z.string(),
  at: z.number(),
})
export type RoomJudge = z.infer<typeof RoomJudgeSchema>

export const RoomSchema = z.object({
  id: z.string(),
  title: z.string(),
  prompt: z.string(),
  agents: z.array(RoomAgentSchema),
  messages: z.array(RoomMessageSchema),
  /** Agent ids typing right now. */
  typing: z.array(z.string()),
  phase: RoomPhaseSchema,
  /** Rounds started so far. */
  rounds: z.number(),
  /** The judge's latest call. */
  judge: RoomJudgeSchema.optional(),
  /** Why the room failed. */
  error: z.string().optional(),
  startedAt: z.number(),
  resolvedAt: z.number().optional(),
  /** Where the record went once resolved. */
  file: z.string().optional(),
})
export type Room = z.infer<typeof RoomSchema>

/** A room is live while its agents may still post. */
export const roomIsLive = (phase: RoomPhase): boolean => phase === 'open' || phase === 'wrapping'

const roomId = z.string().min(1).max(64)

export const roomsInvoke = {
  'rooms.create': {
    input: z
      .object({ prompt: z.string().min(1).max(4000), agentIds: z.array(z.string()).min(1).max(8) })
      .strict(),
    output: z.object({ roomId: z.string() }),
  },
  /** Isaac posts; the text is appended at once and joins the next round's delta. */
  'rooms.post': {
    input: z.object({ roomId, text: z.string().min(1).max(4000) }).strict(),
    output: z.object({ posted: z.literal(true) }),
  },
  /** Toggles Isaac's reaction on a message. */
  'rooms.react': {
    input: z.object({ roomId, messageId: z.string().min(1), emoji: z.string().min(1) }).strict(),
    output: z.object({ reacted: z.literal(true) }),
  },
  /** Resolve now: summary from what exists, then save. */
  'rooms.stop': {
    input: z.object({ roomId }).strict(),
    output: z.object({ stopped: z.literal(true) }),
  },
  'rooms.list': { input: z.object({}).strict(), output: z.object({ rooms: z.array(RoomSchema) }) },
} as const

export const roomsEvents = {
  /** The whole room, debounced; rooms are small. */
  'rooms.changed': z.object({ room: RoomSchema }),
} as const
