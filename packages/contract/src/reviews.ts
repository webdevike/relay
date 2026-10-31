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
  base: z.string(),
  head: z.string(),
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
  /** `gh pr diff` output (unified, every file). */
  diff: z.string(),
})
export type ReviewPr = z.infer<typeof ReviewPrSchema>

const PrRef = z.object({ repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/), number: z.number().int() })

/** The Guide: the PR's changed files grouped into sections a reviewer reads top to bottom. */
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
      /** One to three plain sentences: what this part changes and why. */
      why: z.string(),
      /** PR file paths, in reading order. */
      files: z.array(z.string()),
    }),
  ),
})
export type ReviewGuide = z.infer<typeof ReviewGuideSchema>

/** One turn of an item's Astra session as Reviews shows it inline. */
export const AstraTurnSchema = z.object({
  id: z.string(),
  role: z.enum(['user', 'assistant', 'tool']),
  /** Markdown; for Isaac's first ask, only his question (the seed is not shown). */
  text: z.string(),
  streaming: z.boolean(),
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
})
export type AstraItem = z.infer<typeof AstraItemSchema>

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
    input: PrRef.strict(),
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
   * Asks Astra about an item in that item's own Astra session: the first ask starts it (her prime,
   * her thread memory and the item as `context`), later asks continue it. Nothing reaches GitHub,
   * Linear or Slack. Answers stream as `reviews.astraUpdate`.
   */
  'reviews.astraAsk': {
    input: z
      .object({
        url: z.string().url(),
        /** `repo#170`, `ENG-6406`: the session is titled `Astra · <label>`. */
        label: z.string().min(1).max(200),
        /** The item as Markdown (title, description, comments, diff); read on the first ask only. */
        context: z.string().max(400_000),
        text: z.string().min(1).max(8_000),
      })
      .strict(),
    output: AstraItemSchema,
  },
  /** The item's Astra session as it stands; null when there is none yet. */
  'reviews.astraThread': {
    input: z.object({ url: z.string().url() }).strict(),
    output: AstraItemSchema.nullable(),
  },
  /** Lets the item's omp process go (when idle), so the chat view can take the session over. */
  'reviews.astraRelease': {
    input: z.object({ url: z.string().url() }).strict(),
    output: z.object({ released: z.boolean() }),
  },
  /** Marks a PR or ticket handled (hidden from the queue until it changes) or brings it back. */
  'reviews.done': {
    input: z.object({ url: z.string().url(), updatedAt: z.number(), done: z.boolean() }).strict(),
    output: z.record(z.string(), z.number()),
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
} as const
