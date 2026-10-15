import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { FAKE_GATE, FAKE_JOB_RUN } from './paths'

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evaos-fakes-'))
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

const env = (extra: Record<string, string> = {}) => ({
  ...process.env,
  FAKE_GATE_STATE: path.join(dir, 'gate.json'),
  FAKE_GATE_PHOTOS: path.join(dir, 'photos'),
  FAKE_LOG: path.join(dir, 'log.jsonl'),
  ...extra,
})

const gate = (args: string[], extra: Record<string, string> = {}) => {
  const r = spawnSync(process.execPath, [FAKE_GATE, ...args, '--json'], {
    env: env(extra),
    encoding: 'utf8',
  })
  let json: any
  try {
    json = JSON.parse(r.stdout)
  } catch {
    json = null
  }
  return { code: r.status, json, stderr: r.stderr }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('fake gate', () => {
  it('status prints the full status JSON', () => {
    const { code, json } = gate(['status'])
    expect(code).toBe(0)
    expect(json.locked).toBe(false)
    for (const k of ['lockedAt', 'reason', 'active', 'plan', 'history', 'habits', 'tasks', 'schedule', 'canFinish', 'remainingSeconds', 'blocked']) {
      expect(json).toHaveProperty(k)
    }
    expect(json.habits.map((h: any) => h.id)).toEqual(['stretch', 'walk'])
    expect(json.plan.source).toBe('calendar')
  })

  it('done before the timer ends fails with an error JSON and exit 1', () => {
    expect(gate(['start', 'stretch']).code).toBe(0)
    const r = gate(['done', 'stretch'])
    expect(r.code).toBe(1)
    expect(r.json.error).toMatch(/timer not finished: \d+ min left/)
  })

  it('start then done after the fast clock grows history', async () => {
    const fast = { FAKE_GATE_MINUTE_MS: '10' }
    const before = gate(['status'], fast).json.history.length
    gate(['start', 'stretch'], fast)
    await sleep(150)
    const r = gate(['done', 'stretch'], fast)
    expect(r.code).toBe(0)
    expect(r.json.history.length).toBe(before + 1)
    expect(r.json.active).toBeNull()
  })

  it('done walk without a photo errors, with a photo copies it', async () => {
    const fast = { FAKE_GATE_MINUTE_MS: '5' }
    gate(['start', 'walk'], fast)
    await sleep(150)
    const no = gate(['done', 'walk'], fast)
    expect(no.code).toBe(1)
    expect(no.json.error).toMatch(/photo required/)
    const missing = gate(['done', 'walk', '--photo', path.join(dir, 'nope.png')], fast)
    expect(missing.json.error).toMatch(/photo not found/)
    const src = path.join(dir, 'p.png')
    fs.writeFileSync(src, 'x')
    const ok = gate(['done', 'walk', '--photo', src], fast)
    expect(ok.code).toBe(0)
    const last = ok.json.history.at(-1)
    expect(fs.existsSync(last.photo)).toBe(true)
  })

  it('locked scenario unlocks on override', () => {
    const locked = { FAKE_GATE_SCENARIO: 'locked' }
    expect(gate(['status'], locked).json.locked).toBe(true)
    expect(gate(['override'], locked).json.error).toMatch(/needs a reason/)
    const r = gate(['override', 'too', 'tired'], locked)
    expect(r.json.locked).toBe(false)
    expect(r.json.history.at(-1).override).toBe('too tired')
    expect(gate(['override', 'again']).json.error).toBe('gate is not locked')
  })

  it('habit and task management with de-duplicated slugs', () => {
    const a = gate(['habit', 'add', 'Read --x', '--minutes', '15', '--photo'])
    expect(a.json.habits.at(-1)).toEqual({ id: 'read-x', name: 'Read --x', minutes: 15, photo: true })
    const b = gate(['habit', 'add', 'Read x', '--minutes', '5'])
    expect(b.json.habits.at(-1).id).toBe('read-x-2')
    const e = gate(['habit', 'edit', 'read-x', '--name=Reading', '--minutes', '20', '--no-photo'])
    expect(e.json.habits.find((h: any) => h.id === 'read-x')).toMatchObject({ name: 'Reading', minutes: 20, photo: false })
    expect(gate(['habit', 'rm', 'read-x']).json.habits.some((h: any) => h.id === 'read-x')).toBe(false)
    const t = gate(['task', 'add', 'Mail', 'package'])
    expect(t.json.tasks.at(-1)).toMatchObject({ id: 'mail-package', minutes: null, done: false })
    expect(gate(['task', 'rm', 'mail-package']).json.tasks.length).toBe(1)
    expect(gate(['start', 'nope']).json.error).toBe('unknown habit or task: nope')
  })

  it('a .fail file forces errors and argv is logged', () => {
    gate(['status'])
    fs.writeFileSync(path.join(dir, 'gate.json.fail'), '')
    const r = gate(['status'])
    expect(r.code).toBe(1)
    expect(r.json.error).toBe('simulated failure')
    const lines = fs.readFileSync(path.join(dir, 'log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    expect(lines.length).toBe(2)
    expect(lines[0]).toMatchObject({ tool: 'gate', argv: ['status', '--json'] })
  })
})

describe('fake job-run', () => {
  const run = (args: string[], extra: Record<string, string>) =>
    spawnSync(process.execPath, [FAKE_JOB_RUN, ...args], { cwd: dir, env: env(extra), encoding: 'utf8' })

  it('creates then removes the lock and leaves status and last-run', async () => {
    fs.mkdirSync(path.join(dir, 'jobs/.runs'), { recursive: true })
    const { spawn } = await import('node:child_process')
    const child = spawn(process.execPath, [FAKE_JOB_RUN, 'nightly'], {
      cwd: dir,
      env: env({ FAKE_JOB_RUN_WRITE: '1', FAKE_JOB_MS: '400' }),
    })
    const done = new Promise<number | null>((r) => child.on('exit', r))
    const lock = path.join(dir, 'jobs/.runs/nightly.lock')
    await sleep(200)
    expect(fs.existsSync(lock)).toBe(true)
    expect(await done).toBe(0)
    expect(fs.existsSync(lock)).toBe(false)
    const runs = fs.readdirSync(path.join(dir, 'jobs/.runs/nightly')).filter((n) => n !== 'last-run')
    expect(runs).toHaveLength(1)
    const status = JSON.parse(fs.readFileSync(path.join(dir, 'jobs/.runs/nightly', runs[0], 'status.json'), 'utf8'))
    expect(status.state).toBe('done')
    expect(Number(fs.readFileSync(path.join(dir, 'jobs/.runs/nightly/last-run'), 'utf8'))).toBeGreaterThan(0)
  })

  it('writes nothing without FAKE_JOB_RUN_WRITE and rejects bad names', () => {
    expect(run(['nightly'], {}).status).toBe(0)
    expect(fs.existsSync(path.join(dir, 'jobs'))).toBe(false)
    expect(run(['Bad_Name'], {}).status).toBe(2)
    const log = fs.readFileSync(path.join(dir, 'log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    expect(log[0]).toMatchObject({ tool: 'job-run', argv: ['nightly'] })
  })
})
