import { z } from 'zod'
import { ActivityItem } from '@evaos/chat-core/activity'
import { ContextOpenSchema, ContextToneSchema, ItemKeySchema, RepoSchema } from './context'

// The Board page: one Linear-style board of everything Eva's agents work on. Main joins the work
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

const PrRefSchema = z.object({ repo: RepoSchema, number: z.number().int().positive() })
const PersonSchema = z.object({
  name: z.string().max(200),
  avatarUrl: z.string().max(2048).nullable(),
})

/** A synced Linear issue's facts on a card (the host's board; null without host sync). */
export const CardTicketSchema = z.object({
  /** Linear issue uuid (setState needs it). */
  id: z.string().max(100),
  state: z.object({
    id: z.string().max(100),
    name: z.string().max(80),
    type: z.string().max(40),
    color: z.string().max(40),
  }),
  team: z.object({ id: z.string().max(100), key: z.string().max(20) }),
  /** 0 none, 1 urgent .. 4 low. */
  priority: z.number().int().min(0).max(4),
  project: z.object({ id: z.string().max(100), name: z.string().max(200) }).nullable(),
  milestone: z
    .object({
      id: z.string().max(100),
      name: z.string().max(200),
      targetDate: z.string().max(10).nullable(),
    })
    .nullable(),
  labels: z.array(z.object({ name: z.string().max(80), color: z.string().max(40) })).max(10),
  parent: z.object({ key: z.string().max(40), title: z.string().max(400) }).nullable(),
  sub: z
    .object({ done: z.number().int().nonnegative(), total: z.number().int().nonnegative() })
    .nullable(),
  assignee: PersonSchema.nullable(),
  createdAt: z.number().finite(),
  updatedAt: z.number().finite(),
  prs: z
    .array(
      PrRefSchema.extend({
        url: z.string().max(2048),
        title: z.string().max(400),
        state: z.enum(['open', 'draft', 'merged', 'closed']),
        checks: z.enum(['pass', 'fail', 'pending', 'none']),
        decision: z.string().max(40).nullable(),
      }),
    )
    .max(20),
  /** The newest comment waiting on Isaac's reply (`count` of them on the item). */
  waiting: z
    .object({
      provider: z.enum(['linear', 'github']),
      itemId: z.string().max(200),
      rootId: z.string().max(200),
      commentId: z.string().max(200),
      author: PersonSchema,
      at: z.number().finite(),
      excerpt: z.string().max(500),
      count: z.number().int().positive(),
      anchor: z.object({
        kind: z.enum(['comment', 'inline', 'pr-conversation', 'pr-review-line']),
        pr: PrRefSchema.nullable(),
        path: z.string().max(1000).nullable(),
        line: z.number().int().nullable(),
        side: z.enum(['LEFT', 'RIGHT']).nullable(),
      }),
    })
    .nullable(),
  /** The one thing Isaac should do on it, and the evidence it rests on. */
  needsYou: z
    .object({
      kind: z.enum(['waiting', 'agent', 'merge', 'review', 'autoMergeOff']),
      text: z.string().max(200),
      action: z.object({
        kind: z.enum(['reply', 'openPr', 'merge', 'review', 'open']),
        label: z.string().max(200),
        pr: PrRefSchema.nullable(),
      }),
      evidence: z.string().max(200),
    })
    .nullable(),
})
export type CardTicket = z.infer<typeof CardTicketSchema>

/** What opening a card shows. */
export const CardOpenTargetSchema = z.discriminatedUnion('kind', [
  /** A Linear key: the `ticket:<KEY>` page (M2; the side panel until then). */
  z.object({ kind: z.literal('ticket'), key: z.string().max(40) }),
  /** A ledger-only work item: `ticket:item/<id>` (M2; the side panel until then). */
  z.object({ kind: z.literal('item'), id: z.string().max(200) }),
  /** A helper, session, harness or canvas run: its own target. */
  z.object({ kind: z.literal('link'), open: AgentOpenSchema }),
])
export type CardOpenTarget = z.infer<typeof CardOpenTargetSchema>

export const AgentCardSchema = z.object({
  id: z.string().min(1).max(4300),
  /**
   * A ticket or work item with agent work (ledger, auto-work), a synced Linear issue with none
   * (`ticket`), or a run of its own (helper, session, harness pane, canvas room).
   */
  kind: z.enum(['item', 'ticket', 'helper', 'session', 'harness', 'canvas']),
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
  /** Untouched for a week and nothing running: the renderer leaves it out. */
  stale: z.boolean(),
  links: z.array(AgentLinkSchema).max(12),
  /** The synced Linear issue's facts; null without host sync or a Linear key. */
  ticket: CardTicketSchema.nullable(),
  openTarget: CardOpenTargetSchema,
  /** Why the card can't be dragged, or null when it can (agent-driven, no Linear issue, writes off, fallback). */
  dragBlock: z.string().max(200).nullable(),
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
    /** Synced tickets: the host's, or why the board fell back to local Linear states. */
    tickets: z.object({
      source: z.enum(['host', 'fallback']),
      reason: z.enum(['noHost', 'oldHost', 'off', 'disconnected']).nullable(),
      /** One line for the toolbar. */
      message: z.string().max(400).nullable(),
      lastSyncAt: z.number().finite().nullable(),
      /** The host advertises `tickets.writes`. */
      writes: z.boolean(),
      /** `Isaac Weber (eCard), GitHub webdevike`. */
      syncAs: z.string().max(300).nullable(),
      /** The Linear account the host acts as; Board moves send it back (`tickets.commit` viewerId). */
      viewerId: z.string().max(200).nullable(),
    }),
  }),
  updatedAt: z.number().finite(),
})
export type AgentBoard = z.infer<typeof AgentBoardSchema>

export const agentsBoardInvoke = {
  /** The whole board now; slow facts (gh, Linear) fill in later and push `agents.changed`. */
  'agents.board': { input: z.object({}).strict(), output: AgentBoardSchema },
} as const

export const agentsBoardEvents = {
  /** A ledger, auto-work state, session, activity item, PR or Linear state the board shows changed. */
  'agents.changed': z.object({}),
} as const
