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
  /** `eva`: Isaac's home base, every page. `starter`: a new user's Relay (Assistants, Chat, Canvas, Settings). */
  profile: z.enum(['eva', 'starter']).default('eva'),
  /** False until the first-run setup wizard has finished. */
  setupComplete: z.boolean().default(true),
  /** The home base folder (same as evaRoot). */
  homeRoot: z.string().default(''),
})
export type AppInfo = z.infer<typeof AppInfoSchema>

/** What Settings > About shows: this build, and the Relay Host it is connected to. */
export const AppAboutSchema = z.object({
  build: z.string().max(64).nullable(),
  instance: z.enum(['stable', 'dev']),
  /** The connected host's name and version (`welcome.state.mac`); null while not connected. */
  hostName: z.string().max(200).nullable(),
  hostVersion: z.string().max(64).nullable(),
})
export type AppAbout = z.infer<typeof AppAboutSchema>

const Empty = z.object({})

export const appInvoke = {
  'app.info': { input: z.object({}).strict(), output: AppInfoSchema },
  'app.about': { input: z.object({}).strict(), output: AppAboutSchema },
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
  /** The PIN from a remote Relay Host's log, or null when Isaac cancels pairing. */
  'relay.pin.reply': {
    input: z
      .object({
        id: z.string().max(64),
        pin: z
          .string()
          .regex(/^\d{6}$/)
          .nullable(),
      })
      .strict(),
    output: Empty,
  },
} as const

export const appEvents = {
  'app.hotkey': z.object({ chord: z.string().max(40), fromGuest: z.boolean() }),
  'app.unsavedEdits.request': z.object({ id: z.string() }),
  'app.saveDirty.request': z.object({ id: z.string() }),
  /** A remote Relay Host wants its PIN (`retry` after a wrong one); answered by `relay.pin.reply`. */
  'relay.pin.request': z.object({ id: z.string(), retry: z.boolean() }),
  /**
   * The window was shown or restored (`shown`), or hidden or minimized. The shell keeps background
   * throttling off, so its page never reads as hidden; this says when none of it can be seen.
   */
  'app.windowShown': z.object({ shown: z.boolean() }),
} as const
