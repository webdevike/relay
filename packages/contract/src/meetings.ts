import { z } from 'zod'
import { Day, Stem } from './eva'

export const ProposalSchema = z.object({
  id: z.string().max(300),
  kind: z.string().max(32),
  text: z.string().max(5000),
  workspace: z.string().max(200).nullable(),
  item: z.string().max(200).nullable(),
  p: z.number().nullable(),
  source: z.string().max(500).nullable(),
  status: z.enum(['proposed', 'accepted', 'dismissed']),
})

export const MeetingSummarySchema = z.object({
  stem: Stem,
  title: z.string().max(500),
  start: z.string().nullable(),
  skipped: z.boolean(),
  skippedReason: z.string().max(500).nullable(),
  pending: z.number().int().min(0),
  hasNotes: z.boolean(),
})

export type Proposal = z.output<typeof ProposalSchema>
export type MeetingSummary = z.output<typeof MeetingSummarySchema>

const Short = z.string().max(5000)

export const meetingsInvoke = {
  'meetings.list': {
    input: z.object({}).strict(),
    output: z.object({
      now: z.number().int(),
      meetings: z.array(MeetingSummarySchema).max(2000),
      digest: z.object({
        recentCount: z.number().int().min(0),
        waiting: z
          .array(z.object({ stem: Stem, title: z.string().max(500), proposal: ProposalSchema }))
          .max(2000),
        out: z
          .array(
            z.object({ text: Short, date: Day.nullable(), stem: Stem, title: z.string().max(500) }),
          )
          .max(2000),
        decisions: z
          .array(z.object({ text: Short, stem: Stem, title: z.string().max(500) }))
          .max(2000),
      }),
    }),
  },
  'meetings.get': {
    input: z.object({ stem: Stem }).strict(),
    output: z.object({
      meeting: MeetingSummarySchema.extend({
        proposals: z.array(ProposalSchema).max(500),
        memorized: z
          .array(z.object({ kind: z.string().max(32), text: Short, p: z.number().nullable() }))
          .max(500),
      }).nullable(),
      notes: z.enum(['ok', 'missing', 'none']),
      protocol: z
        .object({
          attendees: z.array(z.string().max(300)).max(500),
          attendeesSource: z.string().max(300).nullable(),
          summary: z.array(Short).max(2000),
          decisions: z.array(Short).max(2000),
          questions: z.array(Short).max(2000),
          transcript: z
            .array(
              z.object({
                time: z.string().max(32),
                speaker: z.string().max(200).nullable(),
                text: z.string().max(20000),
              }),
            )
            .max(20000),
        })
        .nullable(),
    }),
  },
  'meetings.accept': {
    input: z.object({ stem: Stem, proposalId: z.string().max(300) }).strict(),
    output: z.object({ todoId: z.string().regex(/^T\d+$/), tag: z.string().max(100) }),
  },
  'meetings.dismiss': {
    input: z.object({ stem: Stem, proposalId: z.string().max(300) }).strict(),
    output: z.object({ status: z.literal('dismissed') }),
  },
  'meetings.openNotes': {
    input: z.object({ stem: Stem }).strict(),
    output: z.object({ opened: z.literal(true) }),
  },
} as const
