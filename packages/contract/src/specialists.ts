import { z } from 'zod'
import { TrialLetterSchema } from './trials'

// The Agents page: the atomic-agents specialists (packages/atomic-agents). Main reads the installed
// service through its CLI (`atomic-agents list --json`, `runs`, `result <run>`): the agents as the
// service loads them, every run with who asked and what it cost, and each agent's own files, which
// Isaac edits in the installed copy the service hot-reloads; a save is committed back to the repo.

/** Who asked: an assistant (its registry id), an omp chat (its session file), another named caller, or nobody said (runs before callers were recorded). */
export const SpecialistCallerSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('assistant'), id: z.string().max(200) }),
  z.object({
    kind: z.literal('chat'),
    file: z.string().max(4000),
    title: z.string().max(300).nullable(),
  }),
  z.object({ kind: z.literal('other'), label: z.string().max(300) }),
  z.object({ kind: z.literal('none') }),
])
export type SpecialistCaller = z.infer<typeof SpecialistCallerSchema>

export const SpecialistRunSchema = z.object({
  /** The run id (`agents_result {run}` reads its reply): a request id, or a job run id for a run nobody asked for. */
  run: z.string().max(200),
  /** The specialist's id, e.g. `web-researcher`. */
  agent: z.string().max(200),
  caller: SpecialistCallerSchema,
  status: z.enum(['running', 'done', 'failed']),
  /** The request on one line (its first text field, else its JSON). */
  summary: z.string().max(400).nullable(),
  /** The job that ran (`draw`, `triage`), when it started. */
  job: z.string().max(200).nullable(),
  error: z.string().max(4000).nullable(),
  model: z.string().max(200).nullable(),
  /** When the request went out, else when the run started (epoch ms). */
  at: z.number().finite().nullable(),
  seconds: z.number().finite().nullable(),
  /** USD, when the specialist reports it. */
  cost: z.number().finite().nullable(),
  /** A trial arm's letter (trial mode): its badge reads `Diagram B`, and its model stays null until Isaac picks. */
  trial: TrialLetterSchema.optional(),
  /** The trial it is an arm of (the host's trial card id), with `trial`. */
  trialId: z.string().max(200).optional(),
  /** The short name of the model the specialist switched to on its own, for a day after the switch (`Diagram · Sonnet 5.5`). */
  newModel: z.string().max(200).optional(),
})
export type SpecialistRun = z.infer<typeof SpecialistRunSchema>

export const SpecialistUsageSchema = z.object({
  agent: z.string().max(200),
  calls: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  /** USD over the runs that report a cost. */
  cost: z.number().finite(),
  /** Calls per caller, most first. */
  callers: z.array(
    z.object({ caller: SpecialistCallerSchema, calls: z.number().int().nonnegative() }),
  ),
})
export type SpecialistUsage = z.infer<typeof SpecialistUsageSchema>

export const SpecialistRunsSchema = z.object({
  /** The atomic-agents service is installed where this app reads it; false: nothing to list. */
  available: z.boolean(),
  /** Why the runs could not be read (the CLI failed), else null. */
  error: z.string().max(2000).nullable(),
  /** The window `agents` covers. */
  days: z.number().int().nonnegative(),
  /** Newest first. */
  runs: z.array(SpecialistRunSchema),
  /** Each specialist asked in the window, most calls first. */
  agents: z.array(SpecialistUsageSchema),
  updatedAt: z.number().finite(),
})
export type SpecialistRuns = z.infer<typeof SpecialistRunsSchema>

/** How many runs `agents.specialists` lists, newest first: a list this long may not reach back to an older run. */
export const SPECIALIST_LIMIT = 60
/** How many runs one agent's Runs view lists, newest first. */
export const AGENT_RUNS_LIMIT = 40

/**
 * How the consumers treat an agent's output (config.json `mode`): `live` acts on it, `shadow` runs
 * and records it while nothing acts on it, `off` stops it.
 */
export const SpecialistModeSchema = z.enum(['live', 'shadow', 'off'])
export type SpecialistMode = z.infer<typeof SpecialistModeSchema>

/** One agent as the service loads it (`atomic-agents list --json`). */
export const SpecialistAgentSchema = z.object({
  id: z.string().max(200),
  /** One sentence: what it turns its request into. */
  purpose: z.string().max(2000),
  /** `folder`: `<id>/AGENT.md` with knowledge/ and bench/; `file`: `<id>.json|yaml` beside its domain's other files; `code`: passed in by the host, no files. */
  format: z.enum(['folder', 'file', 'code']),
  enabled: z.boolean(),
  /** Unset (null) runs like `live`. */
  mode: SpecialistModeSchema.nullable(),
  model: z.string().max(200),
  /** The model a failed run is retried on once (config.json), else null. */
  fallbackModel: z.string().max(200).nullable(),
  /** The models its bake-off compares. */
  candidates: z.array(z.string().max(200)).max(50),
  thinking: z.string().max(40).nullable(),
  /** `ask`: its request/reply pair; `run`: its job on request; null without either. */
  how: z.enum(['ask', 'run']).nullable(),
  /**
   * Trial mode (packages/atomic-agents Trial.ts): `on` runs each caller request on every arm at
   * once (blind A / B / C cards Isaac picks from); `arms` are the models, the agent's own first.
   */
  trial: z.object({
    on: z.boolean(),
    arms: z.array(z.string().max(200)).max(10),
  }),
  /** Every job run (asked for or not) in the last 7 days, how many failed, running now, the newest start (epoch ms). */
  runs: z.object({
    week: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    running: z.number().int().nonnegative(),
    lastAt: z.number().finite().nullable(),
  }),
  /** Its file's last edit does not load (the service keeps the version before it), else null. */
  error: z.string().max(4000).nullable(),
})
export type SpecialistAgent = z.infer<typeof SpecialistAgentSchema>

export const SpecialistAgentsSchema = z.object({
  /** The atomic-agents service is installed where this app reads it; false: nothing to list. */
  available: z.boolean(),
  /** Why the agents could not be read (the CLI failed), else null. */
  error: z.string().max(2000).nullable(),
  /** In the service's load order. */
  agents: z.array(SpecialistAgentSchema),
  updatedAt: z.number().finite(),
})
export type SpecialistAgents = z.infer<typeof SpecialistAgentsSchema>

/** An agent's files as the Files tree and editor show them: a folder main opened as a Files root. */
export const SpecialistFolderSchema = z.object({
  /** The folder in the installed copy (absolute; a Files root from now on). */
  root: z.string().min(1).max(4000),
  name: z.string().max(300),
  /** The file to open first: `AGENT.md`, or the `<id>.json` spec. */
  entry: z.string().min(1).max(1000),
  /** The root-relative files the tree shows (and the folders above them); null: the whole folder. */
  only: z.array(z.string().max(1000)).max(500).nullable(),
  /** Saves are committed to this repo (the one the service was installed from), else null: saves stay in the installed copy. */
  repo: z.string().max(4000).nullable(),
})
export type SpecialistFolder = z.infer<typeof SpecialistFolderSchema>

/** What became of one save in an agent's folder: the service loads it within a second, and main commits it back. */
export const SpecialistSavedSchema = z.object({
  agent: z.string().max(200),
  /** Root-relative, as saved. */
  path: z.string().max(1000),
  /**
   * `committed`: on the repo's main as `sha`; `unchanged`: the repo already has this text;
   * `invalid`: the agent does not load with it (the service keeps the version before); `kept`:
   * saved and live, but not committed (`detail` says why); `failed`: git failed.
   */
  state: z.enum(['committed', 'unchanged', 'invalid', 'kept', 'failed']),
  sha: z.string().max(64).nullable(),
  /** One plain line for the editor. */
  detail: z.string().max(2000),
  at: z.number().finite(),
})
export type SpecialistSaved = z.infer<typeof SpecialistSavedSchema>

const AgentIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]*$/)
  .max(200)

export const specialistsInvoke = {
  /** Every agent the service loads, enabled or not, with its model, mode and run counts. */
  'agents.roster': { input: z.object({}).strict(), output: SpecialistAgentsSchema },
  /** Recent specialist runs and each specialist's use over the last week (who asked). */
  'agents.specialists': { input: z.object({}).strict(), output: SpecialistRunsSchema },
  /** One agent's newest runs, asked for or not (cron, events, bench). */
  'agents.agentRuns': {
    input: z.object({ agent: AgentIdSchema }).strict(),
    output: SpecialistRunsSchema,
  },
  /**
   * One run as `agents_result` answers it (`atomic-agents result <run>`): the CLI's JSON line, read
   * by @relay/protocol `agentRunOf` in the renderer; `ok` false when the CLI failed.
   */
  'agents.specialistRun': {
    input: z.object({ run: z.string().min(1).max(200) }).strict(),
    output: z.object({ ok: z.boolean(), text: z.string().max(2_000_000) }),
  },
  /** Opens an agent's files as a Files root (main resolves the folder; the renderer names only the id). */
  'agents.agentFolder': {
    input: z.object({ agent: AgentIdSchema }).strict(),
    output: SpecialistFolderSchema,
  },
} as const

export const specialistsEvents = {
  /**
   * The atomic-agents journal changed (a run was asked, ran or ended): the runs and the roster's
   * counts read something new. Main watches it once either was first asked for.
   */
  'agents.specialistsChanged': z.object({}),
  /** A save in an agent's folder was checked and committed (or why not). */
  'agents.agentSaved': SpecialistSavedSchema,
} as const
