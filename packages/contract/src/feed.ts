import { z } from 'zod'

/** One card of Isaac's discovery feed (written by work/discovery-feed/fetch.ts into feed.json). */
export const FeedItemSchema = z.object({
  id: z.string().max(200),
  source: z.string().max(80),
  title: z.string().max(400),
  why: z.string().max(600),
  image: z.string().max(4000000).optional(),
  video: z.string().max(2000).optional(),
  url: z.string().max(2000),
  ts: z.number(),
  score: z.number().optional(),
  meta: z.string().max(200).optional(),
  tag: z.string().max(40).optional(),
  process: z.boolean().optional(),
})
export type FeedItemDto = z.output<typeof FeedItemSchema>

export const FeedActionSchema = z.enum(['like', 'skip', 'save'])
export type FeedAction = z.output<typeof FeedActionSchema>

export const feedInvoke = {
  'feed.list': {
    input: z.object({}).strict(),
    output: z.object({
      generatedAt: z.string().nullable(),
      sources: z.record(
        z.string(),
        z.object({
          ok: z.boolean(),
          count: z.number().optional(),
          error: z.string().max(400).optional(),
          disabled: z.boolean().optional(),
        }),
      ),
      items: z.array(FeedItemSchema).max(500),
      /** id -> action Isaac took, newest signal wins. */
      acted: z.record(z.string(), FeedActionSchema),
    }),
  },
  'feed.signal': {
    input: z
      .object({
        id: z.string().max(200),
        action: FeedActionSchema,
        title: z.string().max(400),
        source: z.string().max(80),
      })
      .strict(),
    output: z.object({ recorded: z.literal(true) }),
  },
  'feed.refresh': {
    input: z.object({}).strict(),
    output: z.object({ started: z.literal(true) }),
  },
} as const
