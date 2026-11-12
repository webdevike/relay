import { z } from 'zod'
import { Day, Stem } from './eva'
import { AstraTurnSchema } from './reviews'

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

/** One of Relay's recordings (relay packages/protocol/src/meetings.ts `MeetingRecording`). */
export const RecordingSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{7,63}$/),
  app: z.string().max(100),
  title: z.string().max(500).nullable(),
  startedAt: z.number(),
  endedAt: z.number().nullable(),
  device: z.string().max(200),
  stage: z.enum([
    'recording',
    'uploading',
    'transcribing',
    'diarizing',
    'naming',
    'summarizing',
    'done',
    'failed',
  ]),
  health: z.enum(['ok', 'silent-app', 'no-mic']),
  healthDetail: z.string().max(500),
  error: z.string().max(2000).nullable(),
  shadow: z.boolean(),
  stem: z.string().max(300).nullable(),
  seconds: z.number().nonnegative(),
  /** The assistant whose chat the meeting is in (a registry id), or null when the host has none. */
  assistant: z.string().max(64).nullable().default(null),
})
export type Recording = z.output<typeof RecordingSchema>

export const LiveLineSchema = z.object({
  id: z.string().max(64),
  track: z.enum(['app', 'mic']),
  speaker: z.string().max(200),
  startMs: z.number(),
  endMs: z.number(),
  text: z.string().max(20000),
  final: z.boolean(),
  echo: z.boolean().optional(),
})
export type LiveLine = z.output<typeof LiveLineSchema>

/** Astra's session about a recording, as its page shows it under the transcript. */
export const MeetingAstraSchema = z.object({
  turns: z.array(AstraTurnSchema),
  working: z.boolean(),
  waiting: z.string().nullable(),
  error: z.string().nullable(),
})
export type MeetingAstra = z.output<typeof MeetingAstraSchema>

export const MeetingNotesSchema = z.object({
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

/** A recording's page: what was said so far, Astra's session, the notes once written. */
export const RecordingViewSchema = z.object({
  recording: RecordingSchema,
  lines: z.array(LiveLineSchema).max(5000),
  astra: MeetingAstraSchema.nullable(),
  notes: MeetingNotesSchema.nullable(),
})
export type RecordingView = z.output<typeof RecordingViewSchema>

const RecordingId = z.object({ id: RecordingSchema.shape.id }).strict()

export const meetingsInvoke = {
  'meetings.list': {
    input: z.object({}).strict(),
    output: z.object({
      now: z.number().int(),
      meetings: z.array(MeetingSummarySchema).max(2000),
      /** Relay's recordings from the Relay Host, newest first (empty when it runs no Meetings). */
      recordings: z.array(RecordingSchema).max(500),
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
      protocol: MeetingNotesSchema.nullable(),
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
  /** A recording's page (the host's snapshot). */
  'meetings.open': { input: RecordingId, output: RecordingViewSchema },
  /** A question to Astra about the recording; answers her session as it stands. */
  'meetings.ask': {
    input: z
      .object({ id: RecordingSchema.shape.id, question: z.string().min(1).max(4000) })
      .strict(),
    output: MeetingAstraSchema,
  },
  /** Ends a recording by hand (the Mac recording it stops). */
  'meetings.stop': { input: RecordingId, output: z.object({ stopped: z.literal(true) }) },
  /** Deletes a recording, its audio and its notes. */
  'meetings.discard': { input: RecordingId, output: z.object({ discarded: z.literal(true) }) },
} as const

export const MeetingsChangeSchema = z.discriminatedUnion('kind', [
  /** A recording started, ended or moved stage. */
  z.object({ kind: z.literal('recording'), recording: RecordingSchema }),
  /** Transcript lines a recording added or replaced. */
  z.object({ kind: z.literal('live'), id: z.string(), upsert: z.array(LiveLineSchema) }),
  z.object({ kind: z.literal('astra'), id: z.string(), astra: MeetingAstraSchema }),
  /** The list changed (a recording came or went, a record changed): read it again. */
  z.object({ kind: z.literal('list') }),
])
export type MeetingsChange = z.output<typeof MeetingsChangeSchema>

export const meetingsEvents = {
  'meetings.changed': MeetingsChangeSchema,
} as const
