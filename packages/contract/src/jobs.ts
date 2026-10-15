import { z } from 'zod'
import { JobName } from './eva'

export const JobSettingsSchema = z
  .object({
    every: z.string().max(32),
    enabled: z.boolean(),
    maxRun: z.string().max(32),
    keep: z.string().max(32),
  })
  .strict()

export const JobSummarySchema = z.object({
  name: JobName,
  description: z.string().max(500).nullable(),
  every: z.string().max(32).nullable(),
  enabled: z.boolean(),
  scheduled: z.boolean(),
  maxRun: z.string().max(32).nullable(),
  keep: z.string().max(32).nullable(),
  lastRunAt: z.number().int().nullable(),
  runState: z.enum(['running', 'ok', 'failed', 'never', 'other']),
  runStateRaw: z.string().max(64).nullable(),
  runNote: z.string().max(500).nullable(),
  sessionFile: z.string().max(4096).nullable(),
  nextDueAt: z.number().int().nullable(),
  hasScript: z.boolean(),
})

export type JobSummaryDto = z.output<typeof JobSummarySchema>
export type JobSettingsDto = z.output<typeof JobSettingsSchema>

const Body = z.string().max(200000)

export const jobsInvoke = {
  'jobs.list': {
    input: z.object({}).strict(),
    output: z.object({ now: z.number().int(), jobs: z.array(JobSummarySchema).max(500) }),
  },
  'jobs.get': {
    input: z.object({ name: JobName }).strict(),
    output: z.object({
      name: JobName,
      text: Body,
      settings: JobSettingsSchema,
      steps: Body,
      extraKeys: z.array(z.string().max(200)).max(50),
    }),
  },
  'jobs.save': {
    input: z
      .object({
        name: JobName,
        mode: z.enum(['create', 'update']),
        basis: Body.nullable(),
        settings: JobSettingsSchema,
        steps: Body,
      })
      .strict(),
    output: z.object({ text: Body, changed: z.boolean() }),
  },
  'jobs.setEnabled': {
    input: z.object({ name: JobName, enabled: z.boolean() }).strict(),
    output: z.object({ enabled: z.boolean() }),
  },
  'jobs.delete': {
    input: z.object({ name: JobName }).strict(),
    output: z.object({ deleted: z.literal(true) }),
  },
  'jobs.run': {
    input: z.object({ name: JobName }).strict(),
    output: z.object({ started: z.literal(true) }),
  },
} as const
