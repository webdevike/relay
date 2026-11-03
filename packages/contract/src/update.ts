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
/** What one "Check for updates" found: `ready` means a newer build is staged and offered. */
export const UPDATE_CHECK_STATUSES = ['unavailable', 'current', 'ready', 'failed', 'busy'] as const
export type UpdateCheckStatus = (typeof UPDATE_CHECK_STATUSES)[number]

/**
 * One line of the deploy history the update source keeps (`history.json`, appended by
 * relay-desktop-deploy.ts): a desktop build with the commit subjects it shipped, or a Relay Host
 * install.
 */
export const ChangelogEntrySchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('desktop'),
    build: z.string().max(64),
    at: z.string().max(40),
    changes: z.array(z.string().max(300)).max(200),
  }),
  z.object({
    kind: z.literal('host'),
    version: z.string().max(64),
    at: z.string().max(40),
  }),
])
export type ChangelogEntry = z.infer<typeof ChangelogEntrySchema>

export const updateInvoke = {
  'update.state': { input: z.object({}).strict(), output: UpdateStateSchema },
  /** Restart into the pending update through the normal quit path (unsaved edits still ask). */
  'update.restart': { input: z.object({}).strict(), output: z.object({}) },
  /** Look for a newer build now (what the deploy's update-now kick does) and say what was found. */
  'update.check': {
    input: z.object({}).strict(),
    output: z.object({ status: z.enum(UPDATE_CHECK_STATUSES) }),
  },
  /** Newest first; empty when this app has no update source (Relay Dev) or it cannot be read. */
  'update.changelog': {
    input: z.object({}).strict(),
    output: z.object({ entries: z.array(ChangelogEntrySchema).max(500) }),
  },
} as const

export const updateEvents = {
  'update.changed': UpdateStateSchema,
} as const
