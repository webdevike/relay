// Trial mode on the specialist badges (@relay/protocol trials.ts). `atomic-agents runs` lists the
// requests callers made, so a trial's default arm is there (the caller's own run, by its request id)
// but its other arms answer no request. This folds the atomic-agents journal itself, the way the
// Relay Host does and without importing packages/atomic-agents: `trial.started` (caller, arms),
// `job.started` with `trial`, `job.succeeded` / `job.failed` and `trial.result` (each arm's end),
// `trial.picked` (models may show), `trial.switched` and `trial.undone`. The journal is read from
// where the last read stopped, so a long one is read once.
//
// What it adds to the runs: each arm as its own run with its letter (`Diagram B`), the caller's run
// with its arm's letter, no model on any of them until Isaac picks, and for a day after a switch
// that was not undone the new model's name on that specialist's runs (`Diagram · Sonnet 5.5`).
import * as fs from 'node:fs'
import { StringDecoder } from 'node:string_decoder'
import { z } from 'zod'
import { TRIAL_SWITCH_BADGE_MS } from '@relay/protocol'
import type {
  SpecialistCaller,
  SpecialistRun,
  SpecialistRuns,
  TrialLetterValue,
} from '@evaos/contract'

/** How much of the journal one read holds in memory at a time. */
const CHUNK_BYTES = 1 << 20
const DAY_MS = 24 * 60 * 60_000

const Letter = z.enum(['A', 'B', 'C'])
const Envelope = z.object({
  type: z.string(),
  component: z.string().min(1),
  run: z.string(),
  at: z.string(),
  caller: z.string().optional(),
  data: z.record(z.string(), z.unknown()),
})
const TrialStarted = z.object({
  trialId: z.string().min(1),
  requestId: z.string().optional(),
  caller: z.string().optional(),
  request: z.string().optional(),
  job: z.string().optional(),
  arms: z.array(z.object({ letter: Letter, model: z.string(), default: z.boolean() })).min(1),
})
const ArmStarted = z.object({ trial: z.object({ id: z.string().min(1), letter: Letter }) })
const JobEnded = z.object({ seconds: z.number().optional(), message: z.string().optional() })
const TrialResult = z.object({
  trialId: z.string(),
  letter: Letter,
  ok: z.boolean(),
  error: z.string().optional(),
  seconds: z.number().optional(),
  cost: z.number().optional(),
})
const TrialPicked = z.object({ trialId: z.string() })
const TrialSwitched = z.object({
  switchId: z.string().min(1),
  toLabel: z.string(),
  kept: z.boolean(),
})
const TrialUndone = z.object({ switchId: z.string() })

interface Arm {
  readonly letter: TrialLetterValue
  readonly model: string
  status: SpecialistRun['status']
  seconds?: number
  cost?: number
  error?: string
}

interface TrialState {
  readonly id: string
  readonly agent: string
  readonly caller: string | undefined
  readonly at: number
  readonly request: string | null
  /** The job each arm runs (`draw`). */
  readonly job: string | null
  /** The arms with no request of their own (every arm but the caller's, when the caller's is a request). */
  readonly arms: Arm[]
  picked: boolean
}

interface SwitchState {
  readonly agent: string
  readonly at: number
  readonly toLabel: string
}

export class TrialRuns {
  private offset = 0
  private decoder = new StringDecoder('utf8')
  private rest = ''
  private readonly trials = new Map<string, TrialState>()
  /** The caller's run (its request id) of each trial: its arm's letter. */
  private readonly own = new Map<string, { trialId: string; letter: TrialLetterValue }>()
  /** Arm jobs by `<component> <run>`, until they end. */
  private readonly jobs = new Map<string, { trialId: string; letter: TrialLetterValue }>()
  /** Switches that were not undone (kept ones switched nothing). */
  private readonly switches = new Map<string, SwitchState>()

  constructor(private readonly file: string) {}

  /**
   * `report`'s runs with the trial arms added (newest first) and letters, hidden models and new
   * model names applied. `caller` names a recorded caller as the page does.
   */
  apply(
    report: SpecialistRuns,
    caller: (raw: string | undefined) => SpecialistCaller,
    now: number,
    days: number,
  ): SpecialistRuns {
    this.read()
    const since = now - days * DAY_MS
    for (const [id, t] of this.trials) if (t.at < since) this.trials.delete(id)
    for (const [id, own] of this.own) if (!this.trials.has(own.trialId)) this.own.delete(id)
    for (const [key, job] of this.jobs) if (!this.trials.has(job.trialId)) this.jobs.delete(key)
    for (const [id, s] of this.switches)
      if (now - s.at >= TRIAL_SWITCH_BADGE_MS) this.switches.delete(id)

    const arms = [...this.trials.values()].flatMap((t) =>
      t.arms.map((arm): SpecialistRun => ({
        run: `${t.id}:${arm.letter}`.slice(0, 200),
        agent: t.agent.slice(0, 200),
        caller: caller(t.caller),
        status: arm.status,
        summary: t.request,
        job: t.job,
        error: arm.error?.slice(0, 4000) ?? null,
        model: t.picked ? arm.model.slice(0, 200) : null,
        at: t.at,
        seconds: arm.seconds ?? null,
        cost: arm.cost ?? null,
        trial: arm.letter,
        trialId: t.id.slice(0, 200),
      })),
    )
    if (arms.length === 0 && this.own.size === 0 && this.switches.size === 0) return report
    const runs = [...report.runs, ...arms].map((r) => {
      let out = r
      const own = this.own.get(r.run)
      if (own !== undefined) {
        const picked = this.trials.get(own.trialId)?.picked === true
        // Blind until Isaac picks: no model, thinking level or backup mark of the caller's own run.
        const { thinking: _t, fellBack: _f, ...blind } = out
        out = {
          ...(picked ? out : blind),
          trial: own.letter,
          trialId: own.trialId.slice(0, 200),
          model: picked ? out.model : null,
        }
      }
      // The latest switch of this specialist the run ran after.
      let latest: SwitchState | undefined
      for (const s of this.switches.values())
        if (s.agent === r.agent && (r.at === null || r.at >= s.at) && (latest?.at ?? -1) < s.at)
          latest = s
      return latest === undefined ? out : { ...out, newModel: latest.toLabel.slice(0, 200) }
    })
    runs.sort((a, b) => (b.at ?? 0) - (a.at ?? 0))
    return { ...report, runs }
  }

  /** Folds what was appended since the last read; a journal that shrank is read again from the start. */
  private read(): void {
    let size: number
    try {
      size = fs.statSync(this.file).size
    } catch {
      return
    }
    if (size < this.offset) {
      this.offset = 0
      this.rest = ''
      this.decoder = new StringDecoder('utf8')
      this.trials.clear()
      this.own.clear()
      this.jobs.clear()
      this.switches.clear()
    }
    if (size === this.offset) return
    let fd: number
    try {
      fd = fs.openSync(this.file, 'r')
    } catch {
      return
    }
    try {
      const buf = Buffer.alloc(Math.min(CHUNK_BYTES, size - this.offset))
      while (this.offset < size) {
        const n = fs.readSync(fd, buf, 0, Math.min(buf.length, size - this.offset), this.offset)
        if (n === 0) break
        this.offset += n
        const lines = (this.rest + this.decoder.write(buf.subarray(0, n))).split('\n')
        // The last piece has no newline yet: the rest of it comes with the next append.
        this.rest = lines.pop() ?? ''
        for (const line of lines) this.fold(line)
      }
    } finally {
      fs.closeSync(fd)
    }
  }

  private fold(line: string): void {
    // Only trial lines, and the ends of arm jobs, matter; the rest are not parsed.
    const ends = line.includes('/job.succeeded') || line.includes('/job.failed')
    if (!line.includes('trial') && !(ends && this.jobs.size > 0)) return
    let raw: unknown
    try {
      raw = JSON.parse(line)
    } catch {
      return
    }
    const env = Envelope.safeParse(raw)
    if (!env.success) return
    const { type, component, run, data } = env.data
    const name = type.slice(type.indexOf('/') + 1)
    const at = Date.parse(env.data.at)
    if (Number.isNaN(at)) return
    switch (name) {
      case 'trial.started': {
        const s = TrialStarted.safeParse(data)
        if (!s.success) return
        const { requestId } = s.data
        const own = requestId === undefined ? undefined : s.data.arms.find((a) => a.default)
        if (requestId !== undefined && own !== undefined)
          this.own.set(requestId, { trialId: s.data.trialId, letter: own.letter })
        this.trials.set(s.data.trialId, {
          id: s.data.trialId,
          agent: component,
          caller: s.data.caller ?? env.data.caller,
          at,
          request: s.data.request?.slice(0, 400) ?? null,
          job: s.data.job?.slice(0, 200) ?? null,
          arms: s.data.arms
            .filter((a) => a !== own)
            .map((a): Arm => ({ letter: a.letter, model: a.model, status: 'running' })),
          picked: false,
        })
        return
      }
      case 'job.started': {
        const s = ArmStarted.safeParse(data)
        if (s.success)
          this.jobs.set(`${component} ${run}`, {
            trialId: s.data.trial.id,
            letter: s.data.trial.letter,
          })
        return
      }
      case 'job.succeeded':
      case 'job.failed': {
        const job = this.jobs.get(`${component} ${run}`)
        if (job === undefined) return
        this.jobs.delete(`${component} ${run}`)
        const arm = this.trials.get(job.trialId)?.arms.find((a) => a.letter === job.letter)
        const s = JobEnded.safeParse(data)
        if (arm === undefined || arm.status !== 'running' || !s.success) return
        arm.status = name === 'job.succeeded' ? 'done' : 'failed'
        if (s.data.seconds !== undefined) arm.seconds = s.data.seconds
        if (name === 'job.failed' && s.data.message !== undefined) arm.error = s.data.message
        return
      }
      case 'trial.result': {
        const s = TrialResult.safeParse(data)
        if (!s.success) return
        const arm = this.trials.get(s.data.trialId)?.arms.find((a) => a.letter === s.data.letter)
        if (arm === undefined) return
        arm.status = s.data.ok ? 'done' : 'failed'
        if (s.data.seconds !== undefined) arm.seconds = s.data.seconds
        if (s.data.cost !== undefined) arm.cost = s.data.cost
        if (!s.data.ok) arm.error = s.data.error ?? 'the run failed'
        return
      }
      case 'trial.picked': {
        const s = TrialPicked.safeParse(data)
        const t = s.success ? this.trials.get(s.data.trialId) : undefined
        if (t !== undefined) t.picked = true
        return
      }
      case 'trial.switched': {
        const s = TrialSwitched.safeParse(data)
        if (s.success && !s.data.kept)
          this.switches.set(s.data.switchId, { agent: component, at, toLabel: s.data.toLabel })
        return
      }
      case 'trial.undone': {
        const s = TrialUndone.safeParse(data)
        if (s.success) this.switches.delete(s.data.switchId)
        return
      }
    }
  }
}
