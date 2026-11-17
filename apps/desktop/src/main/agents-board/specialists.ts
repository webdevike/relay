// Specialist runs on the Agents page and in each chat's strip (`agents.specialists`,
// `agents.specialistRun`, `agents.specialistsChanged`): which assistant or chat asked which
// atomic-agents specialist, when, and what it cost. The record is the service's own journal, folded
// by its CLI (`atomic-agents runs` and `result <run>`, packages/atomic-agents/src/core/Requests.ts),
// the same CLI relay-mcp's agents_runs and agents_result call, so the app and the assistants read
// one record. Main names callers and says when the journal changed.
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { z } from 'zod'
import {
  SPECIALIST_LIMIT,
  type Assistant,
  type SpecialistCaller,
  type SpecialistRuns,
} from '@evaos/contract'
import type { ChatHandles } from '../chat'
import type { MainContext } from '../context'
import { sessionTitle } from '../context-popover/sessions'
import { buildCommand, childPathFor, runCapture } from '../eva/spawn'
import { emit, handle } from '../ipc/handle'
import { TrialRuns } from './trial-runs'

/** The week the per-specialist counts cover. */
export const SPECIALIST_DAYS = 7
const RUNS_TIMEOUT_MS = 20_000
/** How often the journal's size and time are read, and how long a burst of appends settles. */
const JOURNAL_POLL_MS = 1000
const CHANGED_DEBOUNCE_MS = 250

const RunJson = z.object({
  run: z.string().min(1),
  agent: z.string(),
  status: z.enum(['running', 'done', 'failed']),
  caller: z.string().optional(),
  summary: z.string().optional(),
  error: z.string().optional(),
  model: z.string().optional(),
  requestedAt: z.string().optional(),
  startedAt: z.string().optional(),
  seconds: z.number().optional(),
  cost: z.number().optional(),
})
const ReportJson = z.object({
  days: z.number().int().nonnegative(),
  runs: z.array(RunJson),
  agents: z.array(
    z.object({
      agent: z.string(),
      calls: z.number().int().nonnegative(),
      failed: z.number().int().nonnegative(),
      cost: z.number(),
      callers: z.array(
        z.object({ caller: z.string().optional(), calls: z.number().int().nonnegative() }),
      ),
    }),
  ),
})

const timeOf = (iso: string | undefined): number | null => {
  const at = iso === undefined ? NaN : Date.parse(iso)
  return Number.isNaN(at) ? null : at
}

/** The CLI prints its JSON as the last stdout line. */
const lastLine = (stdout: string): string => stdout.trim().split('\n').at(-1) ?? ''

/**
 * Who a recorded caller is: `agent:<id>` is that assistant, an omp session file is the assistant
 * whose thread it is, else that chat (with its title); any other name stays as written.
 */
export function callerOf(
  raw: string | undefined,
  assistants: readonly Pick<Assistant, 'id' | 'file'>[],
  title: (file: string) => string | null,
): SpecialistCaller {
  if (raw === undefined || raw.trim() === '') return { kind: 'none' }
  if (raw.startsWith('agent:')) return { kind: 'assistant', id: raw.slice('agent:'.length) }
  if (path.isAbsolute(raw) && raw.endsWith('.jsonl')) {
    const owner = assistants.find((a) => a.file === raw)
    return owner
      ? { kind: 'assistant', id: owner.id }
      : { kind: 'chat', file: raw, title: title(raw) }
  }
  return { kind: 'other', label: raw.slice(0, 300) }
}

/** `atomic-agents runs` output as the page shows it; throws when it is not that JSON. */
export function specialistRunsOf(
  stdout: string,
  caller: (raw: string | undefined) => SpecialistCaller,
  now: number,
): SpecialistRuns {
  const report = ReportJson.parse(JSON.parse(lastLine(stdout)))
  return {
    available: true,
    error: null,
    days: report.days,
    runs: report.runs.map((r) => ({
      run: r.run.slice(0, 200),
      agent: r.agent.slice(0, 200),
      caller: caller(r.caller),
      status: r.status,
      summary: r.summary?.slice(0, 400) ?? null,
      error: r.error?.slice(0, 4000) ?? null,
      model: r.model?.slice(0, 200) ?? null,
      at: timeOf(r.requestedAt) ?? timeOf(r.startedAt),
      seconds: r.seconds ?? null,
      cost: r.cost ?? null,
    })),
    agents: report.agents.map((a) => ({
      agent: a.agent.slice(0, 200),
      calls: a.calls,
      failed: a.failed,
      cost: a.cost,
      callers: a.callers.map((c) => ({ caller: caller(c.caller), calls: c.calls })),
    })),
    updatedAt: now,
  }
}

export function registerSpecialistRuns(
  ctx: MainContext,
  chat: Pick<ChatHandles, 'assistants'>,
): void {
  const home = ctx.env.atomicAgentsHome
  const cli = home === null ? null : path.join(home, 'app/atomic-agents/src/cli.ts')
  const homedir = os.homedir()
  let pathEnv: Promise<string> | null = null
  const runCli = async (args: string[]) => {
    if (home === null || cli === null || !fs.existsSync(cli)) return null
    pathEnv ??= childPathFor(ctx.env.live, homedir)
    const cmd = buildCommand(cli, args, {
      pathEnv: await pathEnv,
      homedir,
      execPath: process.execPath,
      baseEnv: { ...process.env, ATOMIC_AGENTS_HOME: home },
    })
    return runCapture(cmd, home, RUNS_TIMEOUT_MS)
  }
  // A chat's title is read from its file once.
  const titles = new Map<string, string | null>()
  const title = (file: string): string | null => {
    if (!titles.has(file)) titles.set(file, sessionTitle(file))
    return titles.get(file) ?? null
  }
  // Trial arms, letters and switches, folded from the journal the CLI reads.
  const trials = home === null ? null : new TrialRuns(path.join(home, 'events.ndjson'))

  // The journal: watched once runs were first asked for, so chats see a run start and end live.
  let watching = false
  let timer: NodeJS.Timeout | undefined
  const watchJournal = (): void => {
    if (watching || home === null) return
    watching = true
    const journal = path.join(home, 'events.ndjson')
    fs.watchFile(journal, { interval: JOURNAL_POLL_MS, persistent: false }, (cur, prev) => {
      if (cur.mtimeMs === prev.mtimeMs && cur.size === prev.size) return
      clearTimeout(timer)
      timer = setTimeout(() => emit(ctx, 'agents.specialistsChanged', {}), CHANGED_DEBOUNCE_MS)
    })
  }
  handle(ctx, 'agents.specialists', async () => {
    watchJournal()
    const empty = (available: boolean, error: string | null): SpecialistRuns => ({
      available,
      error,
      days: SPECIALIST_DAYS,
      runs: [],
      agents: [],
      updatedAt: Date.now(),
    })
    const out = await runCli([
      'runs',
      '--days',
      String(SPECIALIST_DAYS),
      '--limit',
      String(SPECIALIST_LIMIT),
    ])
    if (out === null) return empty(false, null)
    const agents = chat.assistants().agents
    const caller = (raw: string | undefined) => callerOf(raw, agents, title)
    try {
      const now = Date.now()
      const runs = specialistRunsOf(out.stdout, caller, now)
      return trials === null ? runs : trials.apply(runs, caller, now, SPECIALIST_DAYS)
    } catch {
      const why = out.timedOut
        ? 'atomic-agents took too long to answer'
        : (out.stderr || out.stdout).trim().split('\n').slice(-2).join(' ') ||
          `atomic-agents exited ${String(out.code)}`
      return empty(true, why.slice(0, 2000))
    }
  })

  handle(ctx, 'agents.specialistRun', async ({ run }) => {
    const out = await runCli(['result', run, '--wait', '0ms'])
    if (out === null)
      throw Object.assign(new Error('The atomic-agents service is not installed here'), {
        code: 'unavailable',
      })
    return { ok: out.code === 0, text: lastLine(out.stdout).slice(0, 2_000_000) }
  })
}
