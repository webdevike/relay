import { z } from 'zod'
import { ChatRoomSetupPatchSchema, ChatRoomSetupSchema, RoomChatSchema } from './rooms-chat'

/** Isaac's author id in a room; every other author is a RoomAgent id, `judge` or `system`. */
export const ROOM_ISAAC = 'isaac'
/** The convergence judge, the summary's author when no PM is in the room. */
export const ROOM_JUDGE = 'judge'
/** The room itself: notices about a dropped agent or a failure. */
export const ROOM_SYSTEM = 'system'

// ---------------------------------------------------------------------------------------------
// Council rooms (effort dial). A room created with `council` is cast from a notch of
// @relay/protocol rooms-council.ts (the single source of notches, models, routing and estimates);
// these schemas mirror its string unions for the IPC wire (zod 4 here, zod 3 there).
// Spec: Eva work/relay-rooms-council/SPEC.md.
// ---------------------------------------------------------------------------------------------

export const CouncilRoleSchema = z.enum([
  'integrator',
  'builder',
  'look',
  'director',
  'critic',
  'researcher',
  'judge',
])
export const CouncilProviderSchema = z.enum(['anthropic', 'openai'])
export const CouncilHarnessSchema = z.enum(['omp', 'claude-code', 'codex'])
export const CouncilThinkingSchema = z.enum(['medium', 'high', 'xhigh', 'max'])
export const CouncilModelKeySchema = z.enum([
  'fable-5.2',
  'opus-5.5',
  'sonnet-5.5',
  'astra-6',
  'sol-6.1',
])
export const CouncilTurnKindSchema = z.enum([
  'code',
  'params',
  'merge',
  'image',
  'critique',
  'score',
  'research',
  'plan',
  'talk',
])
/** Where a council room is: brief, contract (split) or plan (unsplit), then rounds of build > look > integrate > critique > judge, then converge and deliver. */
export const CouncilStageSchema = z.enum([
  'brief',
  'contract',
  'plan',
  'build',
  'look',
  'integrate',
  'critique',
  'judge',
  'converge',
  'deliver',
])
export type CouncilStage = z.infer<typeof CouncilStageSchema>
export const CouncilRoutingSchema = z.record(CouncilRoleSchema, CouncilProviderSchema)

/** A council seat: model x harness in a role, maybe on a part. */
export const RoomSeatSchema = z.object({
  role: CouncilRoleSchema,
  modelKey: CouncilModelKeySchema,
  harness: CouncilHarnessSchema,
  thinking: CouncilThinkingSchema,
  part: z.string().optional(),
  branch: z.enum(['A', 'B']).optional(),
  /** Moved to the other provider by a routing override. */
  override: z.boolean(),
  /** The seat's own worktree, `<workdir>/seats/<seat id>`. */
  worktree: z.string().optional(),
  /** A losing branch builder who now critiques (Max, after round 2). */
  demoted: z.boolean().optional(),
  /** Joined after Start through rooms.raise, at this round. */
  joinedRound: z.number().optional(),
})
export type RoomSeat = z.infer<typeof RoomSeatSchema>

export const RubricCriterionSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** A fine part (Head, Body, Hands, Legs + pants), `Integrator` or `Look`. */
  owner: z.string(),
})
export type RubricCriterion = z.infer<typeof RubricCriterionSchema>

/** One line of `memory/rooms/<room>.routing.jsonl`: one seat's turn. */
export const RoutingEntrySchema = z.object({
  round: z.number(),
  seat: z.string(),
  model: CouncilModelKeySchema,
  harness: CouncilHarnessSchema,
  role: CouncilRoleSchema,
  part: z.string().optional(),
  kind: CouncilTurnKindSchema,
  files: z.array(z.string()),
  tokens: z.object({ input: z.number(), output: z.number(), cached: z.number() }),
  /** List price of the turn (councilUsageCost), plus images. */
  usd: z.number(),
  ms: z.number(),
  /** Score deltas this turn is credited with, by criterion id (filled after the judge scores). */
  criteria: z.record(z.string(), z.number()).optional(),
})
export type RoutingEntry = z.infer<typeof RoutingEntrySchema>

export const RoomRenderSchema = z.object({
  /** Absolute path on the Mac running the room (shown on desktop via relay-media, on the phone via rooms.cmd image). */
  path: z.string(),
  caption: z.string(),
})
export type RoomRender = z.infer<typeof RoomRenderSchema>

export const RoomCardSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('contract'),
    version: z.number(),
    path: z.string(),
    text: z.string(),
  }),
  z.object({
    type: z.literal('parts'),
    round: z.number(),
    parts: z.array(
      z.object({
        part: z.string(),
        agentId: z.string(),
        branch: z.enum(['A', 'B']).optional(),
        status: z.enum(['ok', 'failed', 'bounced']),
        render: z.string().optional(),
        note: z.string(),
      }),
    ),
  }),
  z.object({
    type: z.literal('scorecard'),
    round: z.number(),
    criteria: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        owner: z.string(),
        score: z.number(),
        delta: z.number().optional(),
      }),
    ),
    total: z.number(),
    verdict: z.enum(['continue', 'converged', 'plateau', 'cap', 'branch', 'stopped']),
    note: z.string(),
    fixes: z.array(z.object({ part: z.string(), text: z.string() })),
    /** The round's routing log, shown collapsed under the scorecard. */
    log: z.array(RoutingEntrySchema),
  }),
  z.object({
    type: z.literal('pause'),
    spent: z.number(),
    cap: z.number(),
    /** What Continue raises the cap to. */
    nextCap: z.number(),
    answered: z.enum(['continue', 'wrap']).optional(),
  }),
  z.object({
    type: z.literal('ask'),
    askId: z.string(),
    agentId: z.string(),
    /** The outward action as the seat tried it (the command line). */
    action: z.string(),
    answered: z.enum(['allow', 'deny']).optional(),
  }),
  z.object({
    type: z.literal('deliverable'),
    /** The last scorecard's total; absent when the room wrapped before any scorecard. */
    total: z.number().optional(),
    spent: z.number(),
    minutes: z.number(),
    workdir: z.string(),
    record: z.string().optional(),
    routingFile: z.string().optional(),
    before: z.array(RoomRenderSchema),
    after: z.array(RoomRenderSchema),
    changes: z.array(z.string()),
    dissent: z.array(z.string()),
    who: z.array(
      z.object({
        agentId: z.string(),
        part: z.string().optional(),
        did: z.string(),
        turns: z.number(),
        usd: z.number(),
        moved: z.string(),
      }),
    ),
  }),
])
export type RoomCard = z.infer<typeof RoomCardSchema>

export const RoomCouncilSchema = z.object({
  /** Notch 1..6 (Solo..Max). */
  effort: z.number().int().min(1).max(6),
  routing: CouncilRoutingSchema,
  parts: z.array(z.string()),
  stage: CouncilStageSchema,
  /** Current round (0 before round 1) and the notch's round cap. */
  round: z.number(),
  maxRounds: z.number(),
  /** `<eva>/work/rooms/<room id>`: `main/` (integrator) plus `seats/<seat>/` worktrees. */
  workdir: z.string(),
  source: z.string(),
  refs: z.array(z.string()),
  renderCmd: z.string(),
  contract: z.object({ path: z.string(), version: z.number() }).optional(),
  rubric: z.array(RubricCriterionSchema),
  scores: z.array(
    z.object({ round: z.number(), total: z.number(), criteria: z.record(z.string(), z.number()) }),
  ),
  /** List-price spend so far, the notch estimate and the hard cap; per seat by agent id. */
  spend: z.object({
    usd: z.number(),
    estimate: z.number(),
    cap: z.number(),
    byAgent: z.record(z.string(), z.number()),
  }),
  minutesEstimate: z.number(),
  /** Waiting on Isaac's Continue / Wrap at 80 % of the cap. */
  paused: z.boolean().optional(),
  /** Isaac asked to pause: the room stops at the end of the round it is in. */
  pauseRequested: z.boolean().optional(),
  routingFile: z.string().optional(),
})
export type RoomCouncil = z.infer<typeof RoomCouncilSchema>

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
  /** `read-only` seats get read, grep, glob and web search in the Eva checkout; `none` has no tools; `full` (council seats) is the harness's whole toolset in the seat's worktree. */
  tools: z.enum(['none', 'read-only', 'full']),
  /** A Mantine theme color name, e.g. "orange". */
  color: z.string(),
  /** The process died or never started; the room goes on without them. */
  failed: z.boolean().optional(),
  /** Council seats only. */
  seat: RoomSeatSchema.optional(),
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
  /** A summary is the pinned decision that closes the room; a card carries a council block (contract, parts, scorecard, pause, ask, deliverable). */
  kind: z.enum(['message', 'summary', 'card']),
  mentions: z.array(z.string()),
  /** Images under the text (part renders, full renders, paintovers). */
  renders: z.array(RoomRenderSchema).optional(),
  /** The part a message is about (builder posts, part-tagged findings). */
  part: z.string().optional(),
  card: RoomCardSchema.optional(),
})
export type RoomMessage = z.infer<typeof RoomMessageSchema>

/**
 * What an agent is doing mid-turn: thinking (model reasoning or preparing a tool call), reading
 * (a tool runs; `detail` names it and its target), typing (reply text is streaming).
 */
export const RoomPresenceSchema = z.object({
  state: z.enum(['thinking', 'reading', 'typing']),
  detail: z.string().optional(),
  since: z.number(),
})
export type RoomPresence = z.infer<typeof RoomPresenceSchema>

/**
 * idle (chat rooms): nobody is speaking. A new room is idle until Isaac's first message; each of
 * his messages starts a burst of turns (open) that ends idle again.
 * open: agents talk. wrapping: the soft clock passed, everyone is told to close. resolved: the
 * summary is pinned and saved. failed: nobody could talk (omp missing, every agent dead).
 * paused: no seat runs; the room's state is on disk (`<workdir>/room.json`) and Resume continues
 * with the same seats. Council: Isaac paused it at a round boundary, or Relay quit while it ran
 * (that round runs again). Chat: Isaac paused it, the next turn would cross the budget, or Relay
 * quit mid-burst (the burst goes on from the turn it was in).
 */
export const RoomPhaseSchema = z.enum(['idle', 'open', 'wrapping', 'resolved', 'failed', 'paused'])
export type RoomPhase = z.infer<typeof RoomPhaseSchema>

/** council: the effort-dial build room (phone too). chat: a conversation of chosen members. */
export const RoomKindSchema = z.enum(['council', 'chat'])
export type RoomKind = z.infer<typeof RoomKindSchema>

export const RoomJudgeSchema = z.object({
  verdict: z.enum(['continue', 'converged']),
  note: z.string(),
  at: z.number(),
})
export type RoomJudge = z.infer<typeof RoomJudgeSchema>

export const RoomSchema = z.object({
  id: z.string(),
  /** Rooms saved before kinds existed are council rooms. */
  kind: RoomKindSchema.default('council'),
  title: z.string(),
  prompt: z.string(),
  agents: z.array(RoomAgentSchema),
  messages: z.array(RoomMessageSchema),
  /** What each agent is doing right now, by agent id; absent means idle. */
  presence: z.record(z.string(), RoomPresenceSchema),
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
  /** Present on council (effort dial) rooms. */
  council: RoomCouncilSchema.optional(),
  /** Present on chat rooms: the setup its members run on. */
  chat: RoomChatSchema.optional(),
})
export type Room = z.infer<typeof RoomSchema>

/** A room is live while its agents may still post. */
export const roomIsLive = (phase: RoomPhase): boolean => phase === 'open' || phase === 'wrapping'

/** When anything last happened in a room: its newest message, else when it was made. */
export const roomActivity = (room: Pick<Room, 'startedAt' | 'messages'>): number =>
  Math.max(room.startedAt, room.messages[room.messages.length - 1]?.ts ?? 0)

/** What a room's menu may do to it now: Pause while it runs, Resume once it stopped. */
export function roomRunAction(
  room: Pick<Room, 'phase' | 'council' | 'kind'>,
): 'pause' | 'resume' | null {
  if (room.kind === 'chat')
    return room.phase === 'open' ? 'pause' : room.phase === 'paused' ? 'resume' : null
  const council = room.council
  if (!council) return null
  if (roomIsLive(room.phase))
    return room.phase === 'open' && !council.paused && !council.pauseRequested ? 'pause' : null
  return room.phase === 'idle' ? null : 'resume'
}

const roomId = z.string().min(1).max(64)

export const RoomCouncilInputSchema = z
  .object({
    effort: z.number().int().min(1).max(6),
    /** Folder copied into the room workdir (never edited in place). Absolute or relative to the Eva root. */
    source: z.string().min(1).max(1000),
    refs: z.array(z.string().min(1).max(1000)).max(12).default([]),
    /** Full-figure render command run in the integrator's tree; `--part <name>` is appended for a part. */
    renderCmd: z.string().min(1).max(1000).optional(),
    rubric: z.array(RubricCriterionSchema).max(12).optional(),
    /** Only the overridden roles; the rest keep COUNCIL_DEFAULT_ROUTING. */
    routing: z.partialRecord(CouncilRoleSchema, CouncilProviderSchema).optional(),
  })
  .strict()
export type RoomCouncilInput = z.infer<typeof RoomCouncilInputSchema>

export const roomsInvoke = {
  /** A council room: cast from the notch, it starts at once (the phone's New room). */
  'rooms.create': {
    input: z
      .object({
        prompt: z.string().min(1).max(4000),
        council: RoomCouncilInputSchema,
      })
      .strict(),
    output: z.object({ roomId: z.string() }),
  },
  /** A chat room from its setup, idle until Isaac's first message; saved at once. */
  'rooms.open': {
    input: z.object({ setup: ChatRoomSetupSchema }).strict(),
    output: z.object({ roomId: z.string() }),
  },
  /** Changes a chat room's setup (members replace the whole list); answers its new revision. */
  'rooms.update': {
    input: z.object({ roomId, setup: ChatRoomSetupPatchSchema }).strict(),
    output: z.object({ roomId: z.string(), rev: z.number() }),
  },
  'rooms.rename': {
    input: z.object({ roomId, title: z.string().trim().min(1).max(120) }).strict(),
    output: z.object({ renamed: z.literal(true) }),
  },
  /** A chat room's copy: the same setup, no messages, idle. */
  'rooms.duplicate': {
    input: z.object({ roomId }).strict(),
    output: z.object({ roomId: z.string() }),
  },
  /** Stops the room if it runs, drops it from the list and deletes its folder under work/rooms. */
  'rooms.delete': {
    input: z.object({ roomId }).strict(),
    output: z.object({ deleted: z.literal(true) }),
  },
  /** Council: one notch up on a live room; new seats join at the next round with the full feed. */
  'rooms.raise': {
    input: z.object({ roomId }).strict(),
    output: z.object({ effort: z.number() }),
  },
  /** Council: the answer to the 80 % cap pause. */
  'rooms.budget': {
    input: z.object({ roomId, choice: z.enum(['continue', 'wrap']) }).strict(),
    output: z.object({ cap: z.number() }),
  },
  /** Council: Isaac's allow / deny on a seat's outward action (push, deploy, post, purchase, delete outside the room). */
  'rooms.answer': {
    input: z.object({ roomId, askId: z.string().min(1).max(64), allow: z.boolean() }).strict(),
    output: z.object({ answered: z.literal(true) }),
  },
  /**
   * Isaac posts; the text is appended at once. Council: it joins the next round's delta (a paused
   * room's next round once resumed). Chat: it starts a burst (mentioned members first; an @mentioned
   * assistant not in the room joins as a guest), or redirects the running one after its turn.
   */
  'rooms.post': {
    input: z.object({ roomId, text: z.string().min(1).max(4000) }).strict(),
    output: z.object({ posted: z.literal(true) }),
  },
  /** Council: stop at the end of the round the room is in. Chat: stop the turn now. Seats end, the state stays on disk. */
  'rooms.pause': {
    input: z.object({ roomId }).strict(),
    output: z.object({ pausing: z.literal(true) }),
  },
  /**
   * Council: run a paused, wrapped or failed room on from its next round with the same seats
   * (their harness sessions resume). Chat: go on with the burst from the turn it stopped at.
   * Resolves with the cap in force (council: raised when the spend was already at the pause
   * line; chat: the setup's budget, which Members raises).
   */
  'rooms.resume': {
    input: z.object({ roomId }).strict(),
    output: z.object({ cap: z.number() }),
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
  /** A room was deleted. */
  'rooms.removed': z.object({ roomId: z.string() }),
} as const
