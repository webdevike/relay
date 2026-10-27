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
  noMotion: z.boolean().default(false),
  /** `stable`: the copy Isaac uses (supervised, updated by deploys); `dev`: Relay Dev. */
  instance: z.enum(['stable', 'dev']),
  /** EVAOS_BUILD: the build id (short sha) of a deployed stable build; null when unset. */
  build: z.string().max(64).nullable(),
})
export type AppInfo = z.infer<typeof AppInfoSchema>

const Empty = z.object({})

export const appInvoke = {
  'app.info': { input: z.object({}).strict(), output: AppInfoSchema },
  'app.setBackground': {
    input: z.object({ color: z.string().regex(/^#[0-9a-fA-F]{6}$/) }).strict(),
    output: Empty,
  },
  'app.quit': { input: z.object({}).strict(), output: Empty },
  'app.unsavedEdits.reply': {
    input: z
      .object({
        id: z.string().max(64),
        entries: z
          .array(z.object({ id: z.string().max(200), label: z.string().max(200) }))
          .max(100),
      })
      .strict(),
    output: Empty,
  },
  'app.saveDirty.reply': {
    input: z
      .object({
        id: z.string().max(64),
        failures: z
          .array(
            z.object({
              id: z.string().max(200),
              label: z.string().max(200),
              message: z.string().max(500),
            }),
          )
          .max(100),
      })
      .strict(),
    output: Empty,
  },
} as const

export const appEvents = {
  'app.hotkey': z.object({ chord: z.string().max(40), fromGuest: z.boolean() }),
  'app.unsavedEdits.request': z.object({ id: z.string() }),
  'app.saveDirty.request': z.object({ id: z.string() }),
} as const
