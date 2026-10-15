import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { EvaFs } from '@evaos/eva-core'
import { JobDoc, validateJob, type JobSettings } from '@evaos/eva-core/model/jobs'
import { listJobs } from '@evaos/eva-core/model/jobs-read'
import type { MainContext } from '../context'
import { handle } from '../ipc/handle'
import { buildCommand, childPathFor, recordSpawn, spawnDetached } from './spawn'
import { clockFor, evaFsFor } from './runtime'

type Clock = { now(): Date }
export type JobSpawner = (name: string) => Promise<void>

function coded(message: string, code: string): Error {
  return Object.assign(new Error(message), { code })
}

const jobPath = (name: string): string => `jobs/${name}/job.md`

export function jobsList(root: string, clock: Clock) {
  const now = clock.now().getTime()
  return { now, jobs: listJobs(root, now) }
}

export function jobsGet(root: string, name: string) {
  let text: string
  try {
    text = fs.readFileSync(path.join(root, jobPath(name)), 'utf8')
  } catch {
    throw coded(`${jobPath(name)} not found`, 'not-found')
  }
  const doc = JobDoc.parse(text)
  return {
    name,
    text,
    settings: doc.settings(),
    steps: doc.steps(),
    extraKeys: doc.extraKeys(),
  }
}

export async function jobsSave(
  root: string,
  evaFs: EvaFs,
  input: {
    name: string
    mode: 'create' | 'update'
    basis: string | null
    settings: JobSettings
    steps: string
  },
): Promise<{ text: string; changed: boolean }> {
  const existingNames = listJobs(root, 0).map((j) => j.name)
  const errors = validateJob({
    name: input.name,
    mode: input.mode,
    settings: input.settings,
    steps: input.steps,
    existingNames,
  })
  if (Object.keys(errors).length > 0) throw coded(JSON.stringify(errors), 'invalid-input')
  if (input.mode === 'create') {
    const text = JobDoc.parse('').withSteps(input.steps).render()
    const front: string[] = []
    const s = input.settings
    if (s.every.trim()) front.push(`every: ${s.every.trim()}`)
    if (!s.enabled) front.push('enabled: false')
    if (s.maxRun.trim()) front.push(`max_run: ${s.maxRun.trim()}`)
    if (s.keep.trim()) front.push(`keep: ${s.keep.trim()}`)
    const full = front.length > 0 ? `---\n${front.join('\n')}\n---\n${text}` : text
    await evaFs.create('job-md', jobPath(input.name), full)
    return { text: full, changed: true }
  }
  if (input.basis === null)
    throw coded('Missing the text the form was opened with.', 'invalid-input')
  const res = await evaFs.edit(
    'job-md',
    jobPath(input.name),
    (cur) => JobDoc.parse(cur).apply(input.settings).withSteps(input.steps).render(),
    { expected: input.basis },
  )
  return { text: res.after, changed: res.changed }
}

export async function jobsSetEnabled(
  evaFs: EvaFs,
  name: string,
  enabled: boolean,
): Promise<{ enabled: boolean }> {
  await evaFs.edit('job-md', jobPath(name), (cur) => JobDoc.parse(cur).setEnabled(enabled).render())
  return { enabled }
}

export async function jobsDelete(evaFs: EvaFs, name: string): Promise<{ deleted: true }> {
  await evaFs.remove('job-delete', `jobs/${name}`)
  return { deleted: true }
}

export async function jobsRun(
  root: string,
  name: string,
  spawner: JobSpawner,
): Promise<{ started: true }> {
  if (!listJobs(root, 0).some((j) => j.name === name)) {
    throw coded(`No job named ${name}.`, 'not-found')
  }
  await spawner(name)
  return { started: true }
}

function realSpawner(ctx: MainContext): JobSpawner {
  return async (name) => {
    const home = os.homedir()
    const pathEnv = await childPathFor(ctx.env.live, home)
    const cmd = buildCommand(ctx.env.jobRunBin, [name], {
      pathEnv,
      homedir: home,
      execPath: process.execPath,
      baseEnv: process.env,
    })
    recordSpawn(ctx.env.e2e, {
      kind: 'job-run',
      file: cmd.file,
      argv: cmd.argv,
      cwd: ctx.env.evaRoot,
      at: Date.now(),
    })
    spawnDetached(cmd, ctx.env.evaRoot)
  }
}

export function registerJobsIpc(ctx: MainContext): void {
  const root = ctx.env.evaRoot
  handle(ctx, 'jobs.list', () => jobsList(root, clockFor(ctx)))
  handle(ctx, 'jobs.get', ({ name }) => jobsGet(root, name))
  handle(ctx, 'jobs.save', (input) => jobsSave(root, evaFsFor(ctx), input))
  handle(ctx, 'jobs.setEnabled', ({ name, enabled }) =>
    jobsSetEnabled(evaFsFor(ctx), name, enabled),
  )
  handle(ctx, 'jobs.delete', ({ name }) => jobsDelete(evaFsFor(ctx), name))
  handle(ctx, 'jobs.run', ({ name }) => jobsRun(root, name, realSpawner(ctx)))
}
