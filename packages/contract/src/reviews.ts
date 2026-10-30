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

/** What an ask to Astra did: `sent`, or `dry-run` in test instances (the command is shown). */
export const AstraSendSchema = z.object({
  status: z.enum(['sent', 'dry-run']),
  command: z.string(),
})

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
  /** Sends Isaac's private @Astra question about a PR to Astra's thread, never to GitHub. */
  'reviews.astra': {
    input: PrRef.extend({
      url: z.string().url(),
      title: z.string(),
      text: z.string().max(8_000),
    }).strict(),
    output: AstraSendSchema,
  },
  /** Marks a PR handled (hidden from the queue until it changes) or brings it back. */
  'reviews.done': {
    input: z.object({ url: z.string().url(), updatedAt: z.number(), done: z.boolean() }).strict(),
    output: z.record(z.string(), z.number()),
  },
} as const
