#!/usr/bin/env node
// Stand-in for .omp/tools/job-run.ts. Called as `fake-job-run.mjs <name>` with cwd = Eva root.
// Writes into cwd only when FAKE_JOB_RUN_WRITE=1, so a dev click never touches the repo fixture.
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const argv = process.argv.slice(2)
const LOG = process.env.FAKE_LOG
if (LOG) {
  try {
    appendFileSync(LOG, JSON.stringify({ t: Date.now(), tool: 'job-run', argv, cwd: process.cwd() }) + '\n')
  } catch {
    /* ignore */
  }
}

const name = argv[0]
if (!name || !/^[a-z0-9][a-z0-9-]*$/.test(name)) {
  process.stderr.write(`fake-job-run: invalid job name: ${name}\n`)
  process.exit(2)
}

if (process.env.FAKE_JOB_RUN_WRITE !== '1') process.exit(0)

const pad = (n) => String(n).padStart(2, '0')
const d = new Date()
const runId = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
const runs = join(process.cwd(), 'jobs', '.runs')
const lock = join(runs, `${name}.lock`)
const runDir = join(runs, name, runId)
const startedAt = d.toISOString()

mkdirSync(runDir, { recursive: true })
writeFileSync(lock, `${process.pid} ${startedAt}\n`)
writeFileSync(join(runDir, 'status.json'), JSON.stringify({ state: 'running', startedAt }, null, 2) + '\n')

await new Promise((r) => setTimeout(r, Number(process.env.FAKE_JOB_MS ?? 1500)))

writeFileSync(
  join(runDir, 'status.json'),
  JSON.stringify({ state: 'done', startedAt, endedAt: new Date().toISOString(), note: 'fake exit 0' }, null, 2) + '\n',
)
writeFileSync(join(runs, name, 'last-run'), `${Date.now()}\n`)
rmSync(lock, { force: true })
process.exit(0)
