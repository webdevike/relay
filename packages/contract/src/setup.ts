import { z } from 'zod'

/** What `detect.sh` prints for one tool. Every field defaults so a sparse script still parses. */
const ToolSchema = z.object({
  installed: z.boolean().default(false),
  version: z.string().nullish(),
  path: z.string().nullish(),
})

export const SetupDetectSchema = z.object({
  /** Apple's command line tools (git). A fresh Mac lacks them, and omp's first git call pops Apple's installer. */
  clt: ToolSchema.prefault({}),
  brew: ToolSchema.prefault({}),
  bun: ToolSchema.prefault({}),
  omp: ToolSchema.extend({
    loggedIn: z.boolean().default(false),
    providers: z.array(z.string()).default([]),
  }).prefault({}),
  herdr: ToolSchema.prefault({}),
  tailscale: ToolSchema.extend({
    running: z.boolean().default(false),
    loggedIn: z.boolean().default(false),
    tailnetIp: z.string().nullish(),
  }).prefault({}),
  relayHost: ToolSchema.extend({
    running: z.boolean().default(false),
    port: z.number().int().nullish(),
  }).prefault({}),
})
export type SetupDetect = z.infer<typeof SetupDetectSchema>

/** Tools `install.sh` knows, in install order. */
export const SETUP_TOOLS = [
  'clt',
  'brew',
  'bun',
  'omp',
  'herdr',
  'tailscale',
  'relay-host',
] as const
export const SetupToolSchema = z.enum(SETUP_TOOLS)
export type SetupTool = z.infer<typeof SetupToolSchema>

export const SetupProviderSchema = z.enum(['anthropic', 'openai'])
export type SetupProvider = z.infer<typeof SetupProviderSchema>

export const SETUP_STEPS = [
  'welcome',
  'check',
  'install',
  'ai',
  'home',
  'assistants',
  'host',
  'phone',
  'done',
] as const
export const SetupStepSchema = z.enum(SETUP_STEPS)
export type SetupStep = z.infer<typeof SetupStepSchema>

export const SetupAssistantSchema = z.object({
  id: z.string().min(1).max(40),
  name: z.string().min(1).max(60),
  purpose: z.string().max(400),
  model: z.string().max(100).optional(),
})
export type SetupAssistant = z.infer<typeof SetupAssistantSchema>

/** The `answers.json` `scaffold-home.sh` reads. */
export const SetupAnswersSchema = z.object({
  userName: z.string().min(1).max(80),
  assistants: z.array(SetupAssistantSchema).min(1).max(8),
  firstWorkspace: z
    .object({ name: z.string().max(80), description: z.string().max(300) })
    .optional(),
})
export type SetupAnswers = z.infer<typeof SetupAnswersSchema>

/** Wizard progress, persisted at `<configDir>/setup-progress.json` so a quit resumes where it stopped. */
export const SetupStateSchema = z.object({
  done: z.array(SetupStepSchema).default([]),
  root: z.string().max(1000).optional(),
  hostName: z.string().max(100).optional(),
  userName: z.string().max(80).optional(),
  assistants: z.array(SetupAssistantSchema).max(8).optional(),
  firstWorkspace: z
    .object({ name: z.string().max(80), description: z.string().max(300) })
    .optional(),
})
export type SetupState = z.infer<typeof SetupStateSchema>

export const SetupRunSchema = z.discriminatedUnion('task', [
  z.object({ task: z.literal('install'), tool: SetupToolSchema }),
  z.object({ task: z.literal('ai-login'), provider: SetupProviderSchema }),
  z.object({
    task: z.literal('ai-key'),
    provider: SetupProviderSchema,
    key: z.string().min(1).max(500),
  }),
  z.object({
    task: z.literal('scaffold'),
    root: z.string().min(1).max(1000),
    answers: SetupAnswersSchema,
  }),
  z.object({
    task: z.literal('install-host'),
    root: z.string().min(1).max(1000),
    hostName: z.string().min(1).max(100),
  }),
])
export type SetupRun = z.infer<typeof SetupRunSchema>

const Empty = z.object({})

export const setupInvoke = {
  'setup.info': {
    input: Empty.strict(),
    output: z.object({
      computerName: z.string(),
      defaultRoot: z.string(),
      /** The resolved resources/setup folder; null when it is missing (dev checkout without it). */
      setupDir: z.string().nullable(),
      /** Names of the scripts that were not found in setupDir. */
      missing: z.array(z.string()),
      state: SetupStateSchema,
    }),
  },
  'setup.detect': {
    input: Empty.strict(),
    output: z.object({ detect: SetupDetectSchema }),
  },
  /** Runs one script to its end; its lines stream as `setup.progress` events tagged with `runId`. */
  'setup.run': {
    input: z.object({ runId: z.string().min(1).max(64), run: SetupRunSchema }).strict(),
    output: z.object({
      ok: z.boolean(),
      version: z.string().optional(),
      message: z.string().optional(),
    }),
  },
  'setup.cancel': { input: z.object({ runId: z.string().max(64) }).strict(), output: Empty },
  'setup.state.save': { input: z.object({ state: SetupStateSchema }).strict(), output: Empty },
  'setup.openTailscale': { input: Empty.strict(), output: Empty },
  /** Is the new home base ready: its assistants file and how many assistants it lists. */
  'setup.health': {
    input: z.object({ root: z.string().min(1).max(1000) }).strict(),
    output: z.object({ assistants: z.number().int(), hostPort: z.number().int().nullable() }),
  },
  /** Writes home.json, then relaunches the app into the new home base. */
  'setup.complete': {
    input: z
      .object({
        root: z.string().min(1).max(1000),
        profile: z.literal('starter'),
        hostName: z.string().max(100),
      })
      .strict(),
    output: Empty,
  },
} as const

export const setupEvents = {
  'setup.progress': z.object({
    runId: z.string(),
    /** 0-100 from a `PROGRESS` line; null for any other output line. */
    percent: z.number().min(0).max(100).nullable(),
    line: z.string(),
  }),
} as const
