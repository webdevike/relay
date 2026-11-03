import { z } from 'zod'

/** One Linear issue as the chat row's ticket card shows it. */
export const LinearIssueSchema = z.object({
  /** `ENG-6227`. */
  identifier: z.string(),
  title: z.string(),
  url: z.string(),
  state: z.string(),
  /** Linear's workflow-state type (`backlog`, `unstarted`, `started`, `completed`, `canceled`, `triage`). */
  stateType: z.string(),
  /** `Urgent`, `High`, `Medium`, `Low`, or `No priority`. */
  priority: z.string(),
  assignee: z.string().nullable(),
  project: z.string().nullable(),
  /** Epoch ms. */
  updatedAt: z.number(),
})
export type LinearIssue = z.infer<typeof LinearIssueSchema>

export const linearInvoke = {
  /** The issue `key` names; null when Linear has no such issue. */
  'linear.issue': {
    input: z.object({ key: z.string().regex(/^[A-Z][A-Z0-9]*-\d+$/) }).strict(),
    output: LinearIssueSchema.nullable(),
  },
} as const
