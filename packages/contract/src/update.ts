import { z } from 'zod'

/**
 * A new stable build waiting for a restart (agent action `update.offer`). The stable app
 * restarts into it when Isaac clicks Restart, or on its own after 2 minutes idle with no chat
 * running; the restart exits with code 75 so the supervisor relaunches it.
 */
export const UpdateStateSchema = z.object({
  pending: z.boolean(),
  build: z.string().max(64).nullable(),
  summary: z.string().max(200).nullable(),
})
export type UpdateState = z.infer<typeof UpdateStateSchema>

/** The exit code a restart into a pending update quits with; the supervisor relaunches on it. */
export const UPDATE_RESTART_EXIT_CODE = 75

export const updateInvoke = {
  'update.state': { input: z.object({}).strict(), output: UpdateStateSchema },
  /** Restart into the pending update through the normal quit path (unsaved edits still ask). */
  'update.restart': { input: z.object({}).strict(), output: z.object({}) },
} as const

export const updateEvents = {
  'update.changed': UpdateStateSchema,
} as const
