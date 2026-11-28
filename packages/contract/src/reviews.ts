import { z } from 'zod'

/** One pull request in the Reviews queue. */
export const ReviewRowSchema = z.object({
  repo: z.string(),
  number: z.number(),
  title: z.string(),
  url: z.string(),
  author: z.string(),
  draft: z.boolean(),
  /** Epoch ms. */
  updatedAt: z.number(),
})
export type ReviewRow = z.infer<typeof ReviewRowSchema>

/** Isaac's review queue: requested of him, ones he has reviewed and are still open, and a count of finished ones. */
export const ReviewQueueSchema = z.object({
  needs: z.array(ReviewRowSchema),
  reviewing: z.array(ReviewRowSchema),
  completed: z.array(ReviewRowSchema),
  completedTotal: z.number(),
  /** Open PRs Isaac wrote (the queue's Created view). */
  created: z.array(ReviewRowSchema),
  /** PR urls Isaac marked Done here, each with the PR's updatedAt at that moment. */
  done: z.record(z.string(), z.number()),
  fetchedAt: z.number(),
})
export type ReviewQueue = z.infer<typeof ReviewQueueSchema>

const Person = z.object({ login: z.string(), avatarUrl: z.string().nullable() })

export const ReviewCheckSchema = z.object({
  name: z.string(),
  /** pass, fail, pending, skipped. */
  state: z.string(),
  url: z.string().nullable(),
})

/**
 * Merge, review and check facts for PR actions (relay protocol ReviewPrActions); absent from older
 * hosts, local reads and when GitHub could not say.
 */
export const ReviewPrActionsSchema = z.object({
  /** gh's login that read these facts; PR actions send it back as `login`. */
  viewerLogin: z.string().nullable(),
  /** ADMIN, MAINTAIN, WRITE, TRIAGE, READ; null when GitHub does not say. */
  viewerPermission: z.string().nullable(),
  /** MERGEABLE, CONFLICTING, UNKNOWN. */
  mergeable: z.string(),
  /** BLOCKED, BEHIND, DIRTY, UNSTABLE, DRAFT, CLEAN, HAS_HOOKS, UNKNOWN. */
  mergeStateStatus: z.string(),
  methods: z.object({ merge: z.boolean(), squash: z.boolean(), rebase: z.boolean() }),
  mergeQueue: z.object({
    required: z.boolean(),
    inQueue: z.boolean(),
    entryState: z.string().nullable(),
  }),
  /** The latest review per reviewer. */
  reviews: z.array(z.object({ login: z.string(), state: z.string(), at: z.number() })),
  /** Checks with their Actions identity; `attempt` is set for failed Actions runs only. */
  checks: z.array(
    z.object({
      name: z.string(),
      state: z.string(),
      url: z.string().nullable(),
      workflow: z.string().nullable(),
      runId: z.number().nullable(),
      runNumber: z.number().nullable(),
      attempt: z.number().nullable(),
      headSha: z.string(),
    }),
  ),
})
export type ReviewPrActions = z.infer<typeof ReviewPrActionsSchema>

/**
 * One review (line) comment (relay protocol ReviewComment). `line` is its line in the current diff
 * (null when outdated), `originalLine` the line it was written on; `side` LEFT is the old file. A
 * reply has `inReplyTo` (its thread root's id).
 */
export const ReviewCommentSchema = z.object({
  id: z.number(),
  inReplyTo: z.number().nullable(),
  path: z.string(),
  line: z.number().nullable(),
  originalLine: z.number().nullable(),
  side: z.enum(['LEFT', 'RIGHT']),
  outdated: z.boolean(),
  author: z.string(),
  body: z.string(),
  at: z.number(),
  /** Who reacted with each emoji (unicode); absent from older hosts. */
  reactions: z.array(z.object({ emoji: z.string(), users: z.array(z.string()) })).optional(),
})
export type ReviewComment = z.infer<typeof ReviewCommentSchema>

export const ReviewPrSchema = z.object({
  repo: z.string(),
  number: z.number(),
  title: z.string(),
  url: z.string(),
  state: z.string(),
  draft: z.boolean(),
  author: Person,
  createdAt: z.number(),
  updatedAt: z.number(),
  body: z.string(),
  /** Who reacted to the body with each emoji (unicode); absent from older hosts and local reads. */
  bodyReactions: z.array(z.object({ emoji: z.string(), users: z.array(z.string()) })).optional(),
  base: z.string(),
  head: z.string(),
  /** The head commit the PR was read at (the Guide is asked for this head); absent from older hosts. */
  headSha: z.string().optional(),
  /** The base commit the diff was read against (`base...head`); absent from older hosts. */
  baseSha: z.string().optional(),
  additions: z.number(),
  deletions: z.number(),
  reviewers: z.array(z.object({ login: z.string(), state: z.string() })),
  assignees: z.array(z.string()),
  labels: z.array(z.object({ name: z.string(), color: z.string() })),
  milestone: z.string().nullable(),
  projects: z.array(z.string()),
  participants: z.array(z.string()),
  commits: z.array(
    z.object({
      oid: z.string(),
      headline: z.string(),
      author: z.string(),
      at: z.number(),
    }),
  ),
  /** Conversation: issue comments and reviews with a body, oldest first. */
  timeline: z.array(
    z.object({
      kind: z.enum(['comment', 'review']),
      author: z.string(),
      body: z.string(),
      state: z.string().nullable(),
      at: z.number(),
      /** A comment's REST id (reactions go to it); absent on reviews and from older hosts. */
      id: z.number().optional(),
      /** Who reacted to a comment with each emoji (unicode); absent from older hosts. */
      reactions: z.array(z.object({ emoji: z.string(), users: z.array(z.string()) })).optional(),
    }),
  ),
  checks: z.array(ReviewCheckSchema),
  files: z.array(
    z.object({
      path: z.string(),
      additions: z.number(),
      deletions: z.number(),
      /** ADDED, MODIFIED, DELETED, RENAMED, ... as GitHub reports it. */
      change: z.string(),
    }),
  ),
  /** The unified diff (every file) at exactly `baseSha...headSha`. */
  diff: z.string(),
  /** PR action facts from the host (remote reads); absent otherwise. */
  actions: ReviewPrActionsSchema.optional(),
  /** Review (line) comments, oldest first (relay protocol ReviewComment); absent from older hosts and local reads. */
  reviewComments: z.array(ReviewCommentSchema).optional(),
  /**
   * Main read this PR while connected to a host whose write gate takes PR writes (reviews.actions):
   * Isaac's comments go only through that gate, and without `actions` they are refused (re-read),
   * never posted the legacy way. Absent: no such host (old host, disconnected, flags off), so the
   * legacy confirmed `reviews.comment` is the path, as before.
   */
  writeGate: z.literal(true).optional(),
})
export type ReviewPr = z.infer<typeof ReviewPrSchema>

const PrRef = z.object({ repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/), number: z.number().int() })

/** protocol PrMutation; main checks it against the protocol schema before it goes out. */
export const PrMutationInputSchema = z.looseObject({
  kind: z.enum([
    'merge',
    'rerun',
    'requestReview',
    'react',
    'comment',
    'reviewComment',
    'reviewReply',
  ]),
})

/** The host gate's answer to a PR action, or why there is no host to ask. */
export const PrActionAnswerSchema = z.union([
  z.object({
    source: z.literal('host'),
    ok: z.boolean(),
    /** One line when the write failed (with `outcome`) or the host could not check GitHub. */
    error: z.string().optional(),
    approval: z.looseObject({}).optional(),
    outcome: z.looseObject({}).optional(),
    /** The gate said no; nothing was written (protocol TicketsRefusalCode). */
    refused: z.object({ code: z.string(), message: z.string() }).optional(),
  }),
  z.object({ unavailable: z.string() }),
])
export type PrActionAnswer = z.infer<typeof PrActionAnswerSchema>

const GuideSide = z.enum(['old', 'new'])

/** One hunk a v2 section shows (`id` is `path#oldStart,newStart`), with notes on its lines. */
export const ReviewGuideHunkSchema = z.object({
  id: z.string(),
  path: z.string(),
  side: GuideSide,
  /** Lines of `side` inside the hunk the reviewer should read. */
  start: z.number().int(),
  end: z.number().int(),
  callouts: z.array(z.object({ line: z.number().int(), side: GuideSide, note: z.string() })),
})
export type ReviewGuideHunk = z.infer<typeof ReviewGuideHunkSchema>

/**
 * The Guide: the PR as sections a reviewer reads top to bottom. Mirrors `@relay/protocol`'s
 * `ReviewGuide` (contract has no protocol dependency; a parity test keeps them equal). v1 has
 * `title/why/files` per section; a v2 Guide (`version: 2`) adds an overview, risk, per-section
 * explanation, checks, risks and selected hunks, the files it does not show, follow-ups and a
 * checklist, and still fills `why/files`. Every v2 field is optional so a v1 record parses.
 */
export const ReviewGuideSchema = z.object({
  /** The head commit the Guide was written for (it is cached per head). */
  headSha: z.string(),
  /** `model`: written from the title, body and diff; `folders`: the fallback grouping. */
  source: z.enum(['model', 'folders']),
  /** Why the model's walkthrough is missing, when source is `folders`. */
  error: z.string().nullable(),
  sections: z.array(
    z.object({
      title: z.string(),
      /** One to three plain sentences: what this part changes and why (v2: the explanation). */
      why: z.string(),
      /** PR file paths, in reading order (v2: the paths it shows first; each file in one section). */
      files: z.array(z.string()),
      explanation: z.string().optional(),
      check: z.array(z.string()).optional(),
      risks: z.array(z.string()).optional(),
      hunks: z.array(ReviewGuideHunkSchema).optional(),
    }),
  ),
  version: z.literal(2).optional(),
  overview: z.string().optional(),
  risk: z.enum(['low', 'medium', 'high']).optional(),
  riskWhy: z.string().optional(),
  notCovered: z.array(z.object({ path: z.string(), why: z.string() })).optional(),
  followUps: z.array(z.string()).optional(),
  checklist: z.array(z.string()).optional(),
  /** The model read only part of the PR (the prompt was cut for size). */
  partial: z.boolean().optional(),
})
export type ReviewGuide = z.infer<typeof ReviewGuideSchema>

/** What a Slack send hand-off to Astra did: `sent`, or `dry-run` in test instances (the command is shown). */
export const AstraSendSchema = z.object({
  status: z.enum(['sent', 'dry-run']),
  command: z.string(),
})
export type AstraSend = z.infer<typeof AstraSendSchema>

/** A pull request a search found for a ticket key: enough to link it, not to show it. */
export const ReviewPrHitSchema = z.object({
  repo: z.string(),
  number: z.number().int(),
  title: z.string(),
  url: z.string(),
  state: z.enum(['OPEN', 'MERGED', 'CLOSED']),
  draft: z.boolean(),
  /** The head branch, so a link by branch name is told apart from one by title. */
  head: z.string(),
})
export type ReviewPrHit = z.infer<typeof ReviewPrHitSchema>

/** A Linear workflow state of the ticket's team, for the status picker. */
export const LinearStateSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  color: z.string(),
  position: z.number(),
})
export type LinearState = z.infer<typeof LinearStateSchema>

/** One turn of an item's Astra session as Reviews shows it inline. */
export const AstraTurnSchema = z.object({
  id: z.string(),
  role: z.enum(['user', 'assistant', 'tool']),
  /** Markdown; for Isaac's first ask, only his question (the seed is not shown). */
  text: z.string(),
  streaming: z.boolean(),
  /**
   * When it was said (epoch ms): omp's message time, else when the desktop first saw it; a tool
   * row takes its turn's time. Absent turns go after the item's comments, in order.
   */
  at: z.number().optional(),
})
export type AstraTurn = z.infer<typeof AstraTurnSchema>

/** An item's Astra session: one per item, kept across restarts. */
export const AstraItemSchema = z.object({
  url: z.string(),
  title: z.string(),
  /** The omp session file; null until omp reports it. */
  file: z.string().nullable(),
  turns: z.array(AstraTurnSchema),
  working: z.boolean(),
  /** A question omp is blocked on (Astra's `ask`), answered from the session. */
  waiting: z.string().nullable(),
  error: z.string().nullable(),
  /** The assistant's registry id when it is not Astra (absent means Astra). */
  agent: z.string().optional(),
})
export type AstraItem = z.infer<typeof AstraItemSchema>

/** A registry assistant id (`astra`, `nova`): each has its own session per item; absent means Astra. */
export const ItemAssistantSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]*$/)
  .max(64)

/**
 * The url an item's Astra session is kept under: a Linear ticket by its key alone
 * (`https://linear.app/issue/ENG-1`), whatever workspace and title slug its link carries, so the
 * queue's row and a ticket opened by key share one session; anything else as it is.
 */
export function astraItemUrl(url: string): string {
  const m = /^https:\/\/linear\.app\/(?:[^/?#]+\/)?issue\/([A-Z][A-Z0-9]*-\d+)(?:[/?#]|$)/.exec(url)
  return m ? `https://linear.app/issue/${m[1]}` : url
}

export const reviewsEvents = {
  /** An item's Astra session changed (streamed text, a turn ending). */
  'reviews.astraUpdate': AstraItemSchema,
} as const

const LinearKey = z.string().regex(/^[A-Z][A-Z0-9]*-\d+$/)

/** One Linear ticket in the Reviews queue. */
export const LinearRowSchema = z.object({
  key: z.string(),
  title: z.string(),
  url: z.string(),
  /** Why it is here: `mentioned you`, `assigned you`, `commented`, `replied`. */
  reason: z.string(),
  /** Who did it. */
  actor: z.string(),
  /** Epoch ms of the newest notification about it; Done holds until this moves. */
  updatedAt: z.number(),
  unread: z.boolean(),
})
export type LinearRow = z.infer<typeof LinearRowSchema>

const LinearPerson = z.object({
  name: z.string(),
  handle: z.string(),
  /** Profile page; Linear treats a link to it in a comment as an @mention. */
  url: z.string(),
})

export const LinearCommentSchema = z.object({
  id: z.string(),
  /** Top-level comment this replies to; null for a thread's first comment. */
  parentId: z.string().nullable(),
  author: LinearPerson,
  /** Markdown; Linear's uploaded images point at local copies main downloaded. */
  body: z.string(),
  at: z.number(),
  url: z.string(),
  /** It @mentions Isaac. */
  mentionsMe: z.boolean(),
})
export type LinearComment = z.infer<typeof LinearCommentSchema>

export const LinearTicketSchema = z.object({
  /** Linear's issue id (a uuid): comments are posted against it. */
  id: z.string(),
  key: z.string(),
  title: z.string(),
  url: z.string(),
  description: z.string(),
  creator: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  state: z.object({ name: z.string(), type: z.string(), color: z.string() }),
  assignee: z.string().nullable(),
  priority: z.string(),
  labels: z.array(z.object({ name: z.string(), color: z.string() })),
  project: z.string().nullable(),
  team: z.string(),
  parent: z.object({ key: z.string(), title: z.string(), url: z.string() }).nullable(),
  children: z.array(
    z.object({ key: z.string(), title: z.string(), url: z.string(), state: z.string() }),
  ),
  /** Linked GitHub PRs and other attachments. */
  links: z.array(z.object({ title: z.string(), url: z.string(), kind: z.string() })),
  comments: z.array(LinearCommentSchema),
  /** People on the ticket, for @mentions in a reply. */
  people: z.array(LinearPerson),
  me: LinearPerson,
})
export type LinearTicket = z.infer<typeof LinearTicketSchema>

const SlackId = z.string().regex(/^[CDG][A-Z0-9]+$/)
const SlackTs = z.string().regex(/^\d+\.\d+$/)

/** A Slack thread (`threadTs` set) or a DM outside a thread (`threadTs` null). */
const SlackRef = z.object({ channel: SlackId, threadTs: SlackTs.nullable() })

/** One Slack conversation waiting on Isaac. */
export const SlackRowSchema = z.object({
  /** `mention`: someone @mentioned him; `dm`: a DM or group DM; `reply`: a thread he is in. */
  kind: z.enum(['mention', 'dm', 'reply']),
  channel: z.string(),
  channelName: z.string(),
  threadTs: z.string().nullable(),
  /** The newest message from someone else; Done holds until a newer one. */
  ts: z.string(),
  author: z.string(),
  text: z.string(),
  url: z.string(),
  /** Epoch ms of `ts`. */
  updatedAt: z.number(),
})
export type SlackRow = z.infer<typeof SlackRowSchema>

export const SlackQueueSchema = z.object({ rows: z.array(SlackRowSchema), fetchedAt: z.number() })
export type SlackQueue = z.infer<typeof SlackQueueSchema>

export const SlackMessageSchema = z.object({
  ts: z.string(),
  author: z.string(),
  /** It is Isaac's own message. */
  mine: z.boolean(),
  /** Markdown, mentions as @Name. */
  text: z.string(),
  mentionsMe: z.boolean(),
  reactions: z.array(z.object({ emoji: z.string(), count: z.number() })),
  files: z.array(
    z.object({
      name: z.string(),
      /** Slack's file id (`F...`); empty when the read did not give one. */
      id: z.string(),
      /** An image's served copy (`/reviews/media/<file>`); null for other files or when Slack's app was not reachable. */
      image: z.string().nullable(),
    }),
  ),
  at: z.number(),
})
export type SlackMessage = z.infer<typeof SlackMessageSchema>

export const SlackThreadSchema = z.object({
  channel: z.string(),
  channelName: z.string(),
  threadTs: z.string().nullable(),
  messages: z.array(SlackMessageSchema),
  fetchedAt: z.number(),
})
export type SlackThread = z.infer<typeof SlackThreadSchema>

/**
 * Whether Approve shows on a PR: only an eCard auto-work draft whose ledger is at "9 PR (draft)"
 * with the move on Isaac. `ready` can be tapped, `sent` was handed to Astra and waits for the
 * ledger to move, `running` means the self-review loop already started.
 */
export const ReviewApproveSchema = z.object({
  key: z.string(),
  state: z.enum(['ready', 'sent', 'running']),
})
export type ReviewApprove = z.infer<typeof ReviewApproveSchema>

/** The live draft flag, check rollup and review decision a queue row shows as pills. */
export const ReviewRowStatusSchema = z.object({
  draft: z.boolean(),
  ci: z.enum(['pass', 'fail', 'pending', 'none']),
  decision: z.enum(['APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED']).nullable(),
})
export type ReviewRowStatus = z.infer<typeof ReviewRowStatusSchema>

/**
 * Where an eCard auto-work PR stands in Astra's flow, read from its work-item ledger (stage, move),
 * Astra's auto-work.json (phase, self-review loop) and Isaac's approve hand-off. `loop.rounds` counts
 * the self-reviews started; `approve` is the Approve button's state (null when it does not show).
 */
export const ReviewWorkSchema = z.object({
  key: z.string(),
  stage: z.string(),
  move: z.string(),
  phase: z.string().nullable(),
  loop: z
    .object({ running: z.boolean(), rounds: z.number(), outcome: z.string().nullable() })
    .nullable(),
  approve: z.enum(['ready', 'sent', 'running']).nullable(),
})
export type ReviewWork = z.infer<typeof ReviewWorkSchema>
export const reviewsInvoke = {
  'reviews.queue': {
    input: z.object({ refresh: z.boolean() }).strict(),
    output: ReviewQueueSchema,
  },
  'reviews.pr': {
    input: PrRef.strict(),
    output: ReviewPrSchema,
  },
  /** The Guide for the PR's current head: written by a model, or grouped by folder when that fails. */
  'reviews.guide': {
    /** `headSha`/`baseSha`: the commits the renderer shows; a Guide read at others is refused. */
    input: PrRef.extend({
      headSha: z.string().optional(),
      baseSha: z.string().optional(),
    }).strict(),
    output: ReviewGuideSchema,
  },
  /** Posts a comment on GitHub. The renderer only calls this after Isaac confirms the exact text. */
  'reviews.comment': {
    input: PrRef.extend({ body: z.string().min(1).max(65_000) }).strict(),
    output: z.object({ url: z.string() }),
  },
  /** Submits a review (approve, request changes, comment) after Isaac confirms it in the renderer. */
  'reviews.review': {
    input: PrRef.extend({
      event: z.enum(['approve', 'request-changes', 'comment']),
      body: z.string().max(65_000),
    }).strict(),
    output: z.object({ ok: z.literal(true) }),
  },
  /**
   * A confirmed PR action's approval from the host's write gate (protocol TicketApproval), or the
   * gate's refusal. Only sent to a host with `reviews.actions`; otherwise `unavailable`. `login`: the
   * GitHub account the page showed (`actions.viewerLogin`); the host refuses when it acts as another.
   */
  'reviews.prPrepare': {
    input: z
      .object({ login: z.string().min(1).max(100), mutation: PrMutationInputSchema })
      .strict(),
    output: PrActionAnswerSchema,
  },
  /** The PR write (protocol TicketOutcome, `result.merge` for a merge), or the refusal; retries reuse `opId`. */
  'reviews.prCommit': {
    input: z
      .object({
        login: z.string().min(1).max(100),
        approvalId: z.string().min(1).max(200).optional(),
        opId: z.string().uuid(),
        mutation: PrMutationInputSchema,
      })
      .strict(),
    output: PrActionAnswerSchema,
  },
  /**
   * Asks an assistant (`agent`, Astra when absent) about an item in that item's own session with
   * her: the first ask starts it (her prime, her thread memory and the item as `context`), later
   * asks continue it. The session only reads (no tools that write, no Linear or GitHub
   * credentials). Nothing reaches GitHub, Linear or Slack. Answers stream as `reviews.astraUpdate`.
   */
  'reviews.astraAsk': {
    input: z
      .object({
        url: z.string().url(),
        /** `repo#170`, `ENG-6406`: the session is titled `<Name> · <label>`. */
        label: z.string().min(1).max(200),
        /** The item as Markdown (title, description, comments, diff); read on the first ask only. */
        context: z.string().max(400_000),
        text: z.string().min(1).max(8_000),
        agent: ItemAssistantSchema.optional(),
      })
      .strict(),
    output: AstraItemSchema,
  },
  /** The item's session with `agent` (Astra when absent) as it stands; null when there is none yet. */
  'reviews.astraThread': {
    input: z.object({ url: z.string().url(), agent: ItemAssistantSchema.optional() }).strict(),
    output: AstraItemSchema.nullable(),
  },
  /** Lets the item's omp process go (when idle), so the chat view can take the session over. */
  'reviews.astraRelease': {
    input: z.object({ url: z.string().url(), agent: ItemAssistantSchema.optional() }).strict(),
    output: z.object({ released: z.boolean() }),
  },
  /** Stops the assistant's running turn on the item (the partial answer stays). */
  'reviews.astraStop': {
    input: z.object({ url: z.string().url(), agent: ItemAssistantSchema.optional() }).strict(),
    output: z.object({ stopped: z.boolean() }),
  },
  /** Marks a PR or ticket handled (hidden from the queue until it changes) or brings it back. */
  'reviews.done': {
    input: z.object({ url: z.string().url(), updatedAt: z.number(), done: z.boolean() }).strict(),
    output: z.record(z.string(), z.number()),
  },
  /**
   * Slack threads and DMs waiting on Isaac. `refresh: false` answers the last saved read at once
   * (null before the first); `refresh: true` reads Slack again (tens of seconds).
   */
  'reviews.slackQueue': {
    input: z.object({ refresh: z.boolean() }).strict(),
    output: SlackQueueSchema.nullable(),
  },
  /** One thread (or a DM's recent messages); same cache rule as the queue. */
  'reviews.slackThread': {
    input: SlackRef.extend({ refresh: z.boolean() }).strict(),
    output: SlackThreadSchema.nullable(),
  },
  /**
   * Hands Isaac's confirmed reply to Astra, who posts it from the Slack desktop app. The app never
   * posts to Slack itself.
   */
  'reviews.slackSend': {
    input: SlackRef.extend({ text: z.string().min(1).max(8_000) }).strict(),
    output: AstraSendSchema,
  },
  /** Linear tickets that want Isaac: mentions, assignments, comments, newest first. */
  'reviews.linearQueue': {
    input: z.object({ refresh: z.boolean() }).strict(),
    output: z.array(LinearRowSchema),
  },
  'reviews.linearTicket': {
    input: z.object({ key: LinearKey }).strict(),
    output: LinearTicketSchema,
  },
  /** Posts a comment (or a reply under `parentId`) on Linear, after Isaac confirms the exact text. */
  'reviews.linearComment': {
    input: z
      .object({
        issueId: z.string().min(1),
        parentId: z.string().min(1).nullable(),
        body: z.string().min(1).max(65_000),
      })
      .strict(),
    output: z.object({ url: z.string() }),
  },
  /** Whether Approve shows on this PR (an auto-work draft waiting on Isaac), else null. */
  'reviews.approvable': {
    input: PrRef.strict(),
    output: ReviewApproveSchema.nullable(),
  },
  /** A PR row's CI rollup (fail beats pending beats pass; none when it runs no checks) and GitHub's review decision. */
  'reviews.rowStatus': {
    input: PrRef.strict(),
    output: ReviewRowStatusSchema,
  },
  /** The auto-work ledger and self-review loop behind a PR (from the Mini's ledgers), else null. */
  'reviews.work': {
    input: PrRef.strict(),
    output: ReviewWorkSchema.nullable(),
  },
  /**
   * Hands Isaac's confirmed approval to Astra, who runs ready.ts for the ticket. The app never
   * runs it itself.
   */
  'reviews.approve': {
    input: PrRef.strict(),
    output: AstraSendSchema,
  },
  /** PRs in the org that name a ticket key (title or body); the renderer keeps title and branch matches. */
  'reviews.prSearch': {
    input: z.object({ key: LinearKey }).strict(),
    output: z.array(ReviewPrHitSchema),
  },
  /** The ticket team's workflow states, in board order. */
  'reviews.linearStates': {
    input: z.object({ issueId: z.string().min(1) }).strict(),
    output: z.array(LinearStateSchema),
  },
  /** Moves a ticket to another workflow state, after Isaac picks it. Test instances never write. */
  'reviews.linearSetState': {
    input: z.object({ issueId: z.string().min(1), stateId: z.string().min(1) }).strict(),
    output: z.object({ name: z.string(), type: z.string(), color: z.string() }),
  },
  /**
   * Hands a ticket to Astra from the Agents board: she starts its work or passes it to its live
   * auto-work session. The app never starts a session itself.
   */
  'reviews.sendTicket': {
    input: z
      .object({
        key: LinearKey,
        title: z.string().max(400),
        url: z.string().url(),
        note: z.string().max(2_000),
      })
      .strict(),
    output: AstraSendSchema,
  },
} as const
