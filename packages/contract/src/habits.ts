import { z } from 'zod'
import { JobName } from './eva'

const orEmpty = z
  .string()
  .nullish()
  .transform((v) => v ?? '')
  .default('')
const str = z.string().default('')

export const GateStatusSchema = z.object({
  locked: z.boolean().default(false),
  lockedAt: z.string().nullable().default(null),
  reason: z.string().nullable().default(null),
  active: z
    .object({
      kind: orEmpty,
      id: orEmpty,
      startedAt: str,
      endsAt: str,
    })
    .nullable()
    .default(null),
  plan: z
    .object({
      date: str,
      breaks: z
        .array(z.object({ at: str, done: z.boolean().default(false) }))
        .default([]),
      source: str,
    })
    .nullable()
    .default(null),
  history: z
    .array(
      z.object({
        kind: orEmpty,
        id: orEmpty,
        name: orEmpty,
        startedAt: z.string().nullable().default(null),
        doneAt: str,
        photo: z.string().nullable().default(null),
        override: z.string().nullable().default(null),
      }),
    )
    .default([]),
  habits: z
    .array(
      z.object({
        id: orEmpty,
        name: orEmpty,
        minutes: z.number().int().default(0),
        photo: z.boolean().default(false),
      }),
    )
    .default([]),
  tasks: z
    .array(
      z.object({
        id: orEmpty,
        name: orEmpty,
        minutes: z.number().int().nullable().default(null),
        done: z.boolean().default(false),
      }),
    )
    .default([]),
  schedule: z
    .object({
      breaks_per_day: z.number().optional(),
      window: z.unknown().optional(),
      min_gap_minutes: z.number().optional(),
    })
    .passthrough()
    .optional(),
  canFinish: z.boolean().default(false),
  remainingSeconds: z.number().default(0),
  blocked: z.boolean().default(false),
})

export type GateStatus = z.output<typeof GateStatusSchema>

const Id = JobName
const Minutes = z.number().int().min(1).max(600)

export const HabitRunSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('start'), id: Id }).strict(),
  z
    .object({ action: z.literal('done'), id: Id, photoToken: z.string().max(64).nullable() })
    .strict(),
  z.object({ action: z.literal('override'), reason: z.string().min(1).max(500) }).strict(),
  z
    .object({
      action: z.literal('habit-add'),
      name: z.string().max(200),
      minutes: Minutes,
      photo: z.boolean(),
    })
    .strict(),
  z
    .object({
      action: z.literal('habit-edit'),
      id: Id,
      name: z.string().max(200),
      minutes: Minutes,
      photo: z.boolean(),
    })
    .strict(),
  z.object({ action: z.literal('habit-rm'), id: Id }).strict(),
  z
    .object({
      action: z.literal('task-add'),
      name: z.string().max(200),
      minutes: Minutes.nullable(),
    })
    .strict(),
  z.object({ action: z.literal('task-rm'), id: Id }).strict(),
])

export const habitsInvoke = {
  'habit.status': {
    input: z.object({}).strict(),
    output: GateStatusSchema,
  },
  'habit.run': {
    input: HabitRunSchema,
    output: GateStatusSchema,
  },
  'habit.choosePhoto': {
    input: z.object({}).strict(),
    output: z.object({
      token: z.string().max(64).nullable(),
      name: z.string().max(500).nullable(),
    }),
  },
  'habit.openPhoto': {
    input: z.object({ path: z.string().max(4096) }).strict(),
    output: z.object({ opened: z.literal(true) }),
  },
} as const
