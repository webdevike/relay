import { z } from 'zod'
import { ActivityItem } from '@evaos/chat-core/activity'
import { ContextOpenSchema, ContextToneSchema, ItemKeySchema, RepoSchema } from './context'

// The Agents page: one Linear-style board of everything Eva's agents work on. Main joins the work
// item ledgers, Astra's auto-work state, the host's activity list (helpers, sessions, harnesses),
// PR facts and Linear states into cards, each in the column its facts put it; the renderer only
// draws, filters and opens them.

/** Board columns, left to right. */
export const AGENT_COLUMNS = ['queued', 'working', 'needs', 'review', 'qa', 'done'] as const
export const AgentColumnSchema = z.enum(AGENT_COLUMNS)
export type AgentColumn = z.infer<typeof AgentColumnSchema>

/** What clicking a link opens: a context-popover target, or a live activity item (chat, transcript, pane). */
export const AgentOpenSchema = z.union([
  ContextOpenSchema,
  z.object({ kind: z.literal('activity'), item: ActivityItem }),
])
export type AgentOpen = z.infer<typeof AgentOpenSchema>

export const AgentLinkSchema = z.object({
  kind: z.enum(['linear', 'pr', 'session', 'ledger', 'worktree']),
  label: z.string().max(300),
  /** A second line: the session's last words, the PR's repo. */
  sub: z.string().max(400).nullable(),
  open: AgentOpenSchema,
})
export type AgentLink = z.infer<typeof AgentLinkSchema>

export const AgentPillSchema = z.object({ label: z.string().max(60), tone: ContextToneSchema })
export type AgentPill = z.infer<typeof AgentPillSchema>

export const AgentPrSchema = z.object({
  repo: RepoSchema,
  number: z.number().int().positive(),
  url: z.string().url().max(2048),
  /** Null until gh answered (or never, for a stale card). */
  state: z.enum(['open', 'draft', 'merged', 'closed']).nullable(),
  decision: z.string().max(40).nullable(),
  checks: z.enum(['pass', 'fail', 'pending', 'none']).nullable(),
})
export type AgentPr = z.infer<typeof AgentPrSchema>

export const AgentCardSchema = z.object({
  id: z.string().min(1).max(4300),
  /** A ticket or work item (ledger, auto-work), or a run of its own (helper, session, harness pane, canvas room). */
  kind: z.enum(['item', 'helper', 'session', 'harness', 'canvas']),
  /** Ledger or ticket key (`ENG-6832`, `relay-rooms`); null for a run with none. */
  key: ItemKeySchema.nullable(),
  title: z.string().max(400),
  column: AgentColumnSchema,
  pill: AgentPillSchema,
  /** Why it sits in its column, one line. */
  reason: z.string().max(400),
  workspace: z.string().max(120).nullable(),
  /** Who runs it: an assistant (`Astra`) or the chat that started a helper. */
  agent: z.string().max(200).nullable(),
  /** The agent session on it now (or last), by name. */
  session: z.string().max(300).nullable(),
  /** Its latest status line or tool intent. */
  intent: z.string().max(400).nullable(),
  stage: z.string().max(120).nullable(),
  move: z.string().max(120).nullable(),
  next: z.string().max(600).nullable(),
  /** Auto-work phase (`intake`, `pre-review`, `in-review`, `post-review`). */
  phase: z.string().max(40).nullable(),
  pr: AgentPrSchema.nullable(),
  linear: z
    .object({
      key: z.string().max(40),
      url: z.string().url().max(2048).nullable(),
      state: z.string().max(80),
      stateType: z.string().max(40),
    })
    .nullable(),
  /** Epoch ms of the newest thing that happened on it. */
  activityAt: z.number().finite().nullable(),
  /** Untouched for a week and nothing running: hidden unless asked for. */
  stale: z.boolean(),
  links: z.array(AgentLinkSchema).max(12),
})
export type AgentCard = z.infer<typeof AgentCardSchema>

export const AgentBoardSchema = z.object({
  cards: z.array(AgentCardSchema),
  /** Where the cards came from, so an empty column can say why. */
  sources: z.object({
    /** Ledgers read under work/items. */
    items: z.number().int().nonnegative(),
    /** Astra's auto-work state was readable. */
    autoWork: z.boolean(),
    /** The Relay host's activity list is current. */
    activity: z.boolean(),
    linear: z.enum(['ok', 'loading', 'off', 'error']),
  }),
  updatedAt: z.number().finite(),
})
export type AgentBoard = z.infer<typeof AgentBoardSchema>

// Specialist runs: every request an assistant (or any omp session) sent an atomic-agents
// specialist through the relay MCP server's agents_ask, as the service folds its own journal
// (`atomic-agents runs`, packages/atomic-agents/src/core/Requests.ts). Main runs that CLI; the
// Agents page lists the runs and each specialist's use.

/** Who asked: an assistant (its registry id), an omp chat (its session file), another named caller, or nobody said (runs before callers were recorded). */
export const SpecialistCallerSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('assistant'), id: z.string().max(200) }),
  z.object({
    kind: z.literal('chat'),
    file: z.string().max(4000),
    title: z.string().max(300).nullable(),
  }),
  z.object({ kind: z.literal('other'), label: z.string().max(300) }),
  z.object({ kind: z.literal('none') }),
])
export type SpecialistCaller = z.infer<typeof SpecialistCallerSchema>

export const SpecialistRunSchema = z.object({
  /** The run id (`agents_result {run}` reads its reply). */
  run: z.string().max(200),
  /** The specialist's id, e.g. `web-researcher`. */
  agent: z.string().max(200),
  caller: SpecialistCallerSchema,
  status: z.enum(['running', 'done', 'failed']),
  /** The request on one line (its first text field, else its JSON). */
  summary: z.string().max(400).nullable(),
  error: z.string().max(4000).nullable(),
  model: z.string().max(200).nullable(),
  /** When the request went out (epoch ms). */
  at: z.number().finite().nullable(),
  seconds: z.number().finite().nullable(),
  /** USD, when the specialist reports it. */
  cost: z.number().finite().nullable(),
})
export type SpecialistRun = z.infer<typeof SpecialistRunSchema>

export const SpecialistUsageSchema = z.object({
  agent: z.string().max(200),
  calls: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  /** USD over the runs that report a cost. */
  cost: z.number().finite(),
  /** Calls per caller, most first. */
  callers: z.array(
    z.object({ caller: SpecialistCallerSchema, calls: z.number().int().nonnegative() }),
  ),
})
export type SpecialistUsage = z.infer<typeof SpecialistUsageSchema>

export const SpecialistRunsSchema = z.object({
  /** The atomic-agents service is installed where this app reads it; false: nothing to list. */
  available: z.boolean(),
  /** Why the runs could not be read (the CLI failed), else null. */
  error: z.string().max(2000).nullable(),
  /** The window `agents` covers. */
  days: z.number().int().nonnegative(),
  /** Newest first. */
  runs: z.array(SpecialistRunSchema),
  /** Each specialist used in the window, most calls first. */
  agents: z.array(SpecialistUsageSchema),
  updatedAt: z.number().finite(),
})
export type SpecialistRuns = z.infer<typeof SpecialistRunsSchema>

/** How many runs `agents.specialists` lists, newest first: a list this long may not reach back to an older run. */
export const SPECIALIST_LIMIT = 60

export const agentsBoardInvoke = {
  /** The whole board now; slow facts (gh, Linear) fill in later and push `agents.changed`. */
  'agents.board': { input: z.object({}).strict(), output: AgentBoardSchema },
  /** Recent specialist runs and each specialist's use over the last week. */
  'agents.specialists': { input: z.object({}).strict(), output: SpecialistRunsSchema },
  /**
   * One run as `agents_result` answers it (`atomic-agents result <run>`): the CLI's JSON line, read
   * by @relay/protocol `agentRunOf` in the renderer; `ok` false when the CLI failed.
   */
  'agents.specialistRun': {
    input: z.object({ run: z.string().min(1).max(200) }).strict(),
    output: z.object({ ok: z.boolean(), text: z.string().max(2_000_000) }),
  },
} as const

export const agentsBoardEvents = {
  /** A ledger, auto-work state, session, activity item, PR or Linear state the board shows changed. */
  'agents.changed': z.object({}),
  /**
   * The atomic-agents journal changed (a run was asked, ran or ended): `agents.specialists` reads
   * something new. Main watches it once that was first asked for; chats refresh their live badges.
   */
  'agents.specialistsChanged': z.object({}),
} as const
