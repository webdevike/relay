import { z } from 'zod'
import { ActivityItem } from '@evaos/chat-core/activity'

/** Everything agents are running, as the host's latest snapshot has it. */
export const ActivityViewSchema = z.object({
  /** Relay is connected, so the list is current. */
  up: z.boolean(),
  items: z.array(ActivityItem),
})
export type ActivityView = z.infer<typeof ActivityViewSchema>

export const activityInvoke = {
  /** Follows the host's activity list: answers with it now, then pushes `activity.changed` after each change. */
  'activity.watch': {
    input: z.object({}).strict(),
    output: ActivityViewSchema,
  },
} as const

export const activityEvents = {
  'activity.changed': ActivityViewSchema,
} as const
