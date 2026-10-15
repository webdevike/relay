import { z } from 'zod'

export const evaInvoke = {
  'eva.sidebar': {
    input: z.object({}).strict(),
    output: z.object({
      openTodos: z.number().int().min(0),
      scheduledJobs: z.number().int().min(0),
      recent: z
        .array(z.object({ date: z.string(), tag: z.string().nullable(), title: z.string() }))
        .max(8),
    }),
  },
} as const
