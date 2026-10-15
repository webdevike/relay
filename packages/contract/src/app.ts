import { z } from 'zod'

export const AppInfoSchema = z.object({
  evaRoot: z.string(),
  configDir: z.string(),
  ompBin: z.string(),
  sessionsDir: z.string(),
  live: z.boolean(),
  e2e: z.boolean(),
  launchCount: z.number().int(),
  version: z.string(),
})
export type AppInfo = z.infer<typeof AppInfoSchema>

export const appInvoke = {
  'app.info': { input: z.object({}).strict(), output: AppInfoSchema },
} as const
