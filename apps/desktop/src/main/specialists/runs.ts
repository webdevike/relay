// Specialist runs on the Agents page and in each chat's strip: which assistant or chat asked which
// atomic-agents specialist, when, and what it cost. The record is the service's own journal, folded
// by its CLI (`atomic-agents runs` and `result <run>`, packages/atomic-agents/src/core/Requests.ts),
// the same CLI relay-mcp's agents_runs and agents_result call, so the app and the assistants read
// one record. Main names the callers.
import * as path from 'node:path'
import { z } from 'zod'
import type { Assistant, SpecialistCaller, SpecialistRuns } from '@evaos/contract'

const RunJson = z.object({
  run: z.string().min(1),
  agent: z.string(),
  status: z.enum(['running', 'done', 'failed']),
  caller: z.string().optional(),
  summary: z.string().optional(),
  job: z.string().optional(),
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

/** An ISO time as epoch ms, or null. */
export const timeOf = (iso: string | undefined): number | null => {
  const at = iso === undefined ? NaN : Date.parse(iso)
  return Number.isNaN(at) ? null : at
}

/** The CLI prints its JSON as the last stdout line. */
export const lastLine = (stdout: string): string => stdout.trim().split('\n').at(-1) ?? ''

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
      job: r.job?.slice(0, 200) ?? null,
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
