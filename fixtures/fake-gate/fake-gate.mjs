#!/usr/bin/env node
// Stateful stand-in for .omp/tools/habit-gate.ts (D-23 style fake). No dependencies. See README.md.
// Every successful command prints the full status JSON. With --json, failures print {"error"} and exit 1.
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'

const argv = process.argv.slice(2)

const VALUE_FLAGS = {
  done: ['photo'],
  'habit add': ['minutes'],
  'habit edit': ['name', 'minutes'],
  'task add': ['minutes'],
}

const STATE = process.env.FAKE_GATE_STATE ?? join(tmpdir(), 'evaos-fake-gate', 'state.json')
const PHOTOS = process.env.FAKE_GATE_PHOTOS ?? join(dirname(STATE), 'photos')
const MINUTE_MS = Number(process.env.FAKE_GATE_MINUTE_MS ?? 60000)
const SCENARIO = process.env.FAKE_GATE_SCENARIO ?? 'unlocked'
const LOG = process.env.FAKE_LOG

const log = () => {
  if (!LOG) return
  try {
    appendFileSync(LOG, JSON.stringify({ t: Date.now(), tool: 'gate', argv, cwd: process.cwd() }) + '\n')
  } catch {
    /* ignore */
  }
}

class GateError extends Error {}
const fail = (msg) => {
  throw new GateError(msg)
}

// ---- argument parsing: anything starting with -- is a flag ----
const parse = (args) => {
  const positional = []
  const flags = {}
  const raw = [...args]
  const cmdKey = (() => {
    const [a, b] = raw.filter((x) => !x.startsWith('--'))
    return a === 'habit' || a === 'task' ? `${a} ${b}` : a
  })()
  const valued = new Set(VALUE_FLAGS[cmdKey] ?? [])
  for (let i = 0; i < raw.length; i++) {
    const a = raw[i]
    if (!a.startsWith('--')) {
      positional.push(a)
      continue
    }
    const eq = a.indexOf('=')
    if (eq > 0) {
      flags[a.slice(2, eq)] = a.slice(eq + 1)
      continue
    }
    const name = a.slice(2)
    if (valued.has(name)) {
      const v = raw[i + 1]
      if (v === undefined) fail(`--${name} needs a value`)
      flags[name] = v
      i++
    } else {
      flags[name] = true
    }
  }
  return { positional, flags }
}

// ---- time helpers (local time) ----
const pad = (n) => String(n).padStart(2, '0')
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const at = (daysAgo, h, m) => {
  const d = new Date()
  d.setDate(d.getDate() - daysAgo)
  d.setHours(h, m, 0, 0)
  return d.toISOString()
}

// 1x1 transparent PNG
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
)

const seed = () => {
  mkdirSync(PHOTOS, { recursive: true })
  const proof = join(PHOTOS, 'walk-proof.png')
  if (!existsSync(proof)) writeFileSync(proof, PNG)
  const locked = SCENARIO === 'locked'
  return {
    locked,
    lockedAt: locked ? new Date().toISOString() : null,
    reason: locked ? 'Break due' : null,
    active: null,
    plan: {
      date: ymd(new Date()),
      breaks: [
        { at: at(0, 10, 0), done: true },
        { at: at(0, 23, 30), done: false },
      ],
      source: 'calendar',
    },
    history: [
      { kind: 'habit', id: 'stretch', name: 'Stretch', startedAt: at(1, 10, 0), doneAt: at(1, 10, 10), photo: null, override: null },
      { kind: 'habit', id: 'stretch', name: 'Stretch', startedAt: at(0, 10, 0), doneAt: at(0, 10, 10), photo: null, override: null },
      { kind: 'habit', id: 'walk', name: 'Walk', startedAt: at(0, 11, 0), doneAt: at(0, 11, 20), photo: proof, override: null },
    ],
    habits: [
      { id: 'stretch', name: 'Stretch', minutes: 10, photo: false },
      { id: 'walk', name: 'Walk', minutes: 20, photo: true },
    ],
    tasks: [{ id: 'taxes', name: 'Do taxes', minutes: 30, done: false }],
    schedule: { breaks_per_day: 3, window: '09:00-18:00', min_gap_minutes: 60 },
  }
}

const load = () => {
  if (!existsSync(STATE)) {
    mkdirSync(dirname(STATE), { recursive: true })
    const s = seed()
    writeFileSync(STATE, JSON.stringify(s, null, 2))
    return s
  }
  return JSON.parse(readFileSync(STATE, 'utf8'))
}
const save = (s) => writeFileSync(STATE, JSON.stringify(s, null, 2))

const view = (s) => {
  const remainingMs = s.active ? Math.max(0, Date.parse(s.active.endsAt) - Date.now()) : 0
  const remainingSeconds = Math.ceil(remainingMs / 1000)
  return {
    locked: s.locked,
    lockedAt: s.lockedAt,
    reason: s.reason,
    active: s.active,
    plan: s.plan,
    history: s.history,
    habits: s.habits,
    tasks: s.tasks,
    schedule: s.schedule,
    canFinish: Boolean(s.active) && remainingMs === 0,
    remainingSeconds,
    blocked: s.locked,
  }
}

const slug = (name) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'item'
const uniqueId = (name, taken) => {
  const base = slug(name)
  let id = base
  for (let n = 2; taken.includes(id); n++) id = `${base}-${n}`
  return id
}
const minutesOf = (v, required) => {
  if (v === undefined) {
    if (required) fail('--minutes is required')
    return null
  }
  const n = Number(v)
  if (!Number.isInteger(n) || n < 1 || n > 600) fail('minutes must be a whole number from 1 to 600')
  return n
}

const run = () => {
  const { positional, flags } = parse(argv)
  const s0 = load()
  if (existsSync(`${STATE}.fail`)) fail('simulated failure')
  const s = s0
  const [cmd, ...rest] = positional
  switch (cmd) {
    case 'status':
    case undefined:
      break
    case 'start': {
      const id = rest[0]
      const habit = s.habits.find((h) => h.id === id)
      const task = s.tasks.find((t) => t.id === id && !t.done)
      if (!habit && !task) fail(`unknown habit or task: ${id}`)
      if (s.active && s.active.id === id) break
      const minutes = habit ? habit.minutes : (task.minutes ?? 0)
      const now = Date.now()
      s.active = {
        kind: habit ? 'habit' : 'task',
        id,
        startedAt: new Date(now).toISOString(),
        endsAt: new Date(now + minutes * MINUTE_MS).toISOString(),
      }
      break
    }
    case 'done': {
      const id = rest[0]
      if (!s.active || s.active.id !== id) fail(`not active: ${id}`)
      const remainingMs = Math.max(0, Date.parse(s.active.endsAt) - Date.now())
      if (remainingMs > 0) fail(`timer not finished: ${Math.ceil(remainingMs / MINUTE_MS)} min left`)
      const habit = s.active.kind === 'habit' ? s.habits.find((h) => h.id === id) : null
      const task = s.active.kind === 'task' ? s.tasks.find((t) => t.id === id) : null
      const name = (habit ?? task)?.name ?? id
      let photo = null
      if (habit?.photo && !flags.photo) fail(`photo required for ${name}`)
      if (flags.photo) {
        if (typeof flags.photo !== 'string' || !existsSync(flags.photo)) fail(`photo not found: ${flags.photo}`)
        mkdirSync(PHOTOS, { recursive: true })
        photo = join(PHOTOS, `${Date.now()}-${basename(flags.photo)}`)
        copyFileSync(flags.photo, photo)
      }
      s.history.push({
        kind: s.active.kind,
        id,
        name,
        startedAt: s.active.startedAt,
        doneAt: new Date().toISOString(),
        photo,
        override: null,
      })
      if (task) task.done = true
      s.active = null
      s.locked = false
      s.lockedAt = null
      s.reason = null
      const due = s.plan.breaks.find((b) => !b.done && Date.parse(b.at) <= Date.now())
      if (due) due.done = true
      break
    }
    case 'override': {
      if (!s.locked) fail('gate is not locked')
      const reason = rest.join(' ').trim()
      if (!reason) fail('override needs a reason')
      s.history.push({ kind: 'override', id: null, name: 'Override', startedAt: null, doneAt: new Date().toISOString(), photo: null, override: reason })
      s.locked = false
      s.lockedAt = null
      s.reason = null
      s.active = null
      break
    }
    case 'habit': {
      const [sub, ...args] = rest
      if (sub === 'add') {
        const name = args.join(' ').trim()
        if (!name) fail('habit needs a name')
        const minutes = minutesOf(flags.minutes, true)
        const id = uniqueId(name, s.habits.map((h) => h.id))
        s.habits.push({ id, name, minutes, photo: Boolean(flags.photo) })
      } else if (sub === 'edit') {
        const h = s.habits.find((x) => x.id === args[0])
        if (!h) fail(`unknown habit: ${args[0]}`)
        if (typeof flags.name === 'string' && flags.name.trim()) h.name = flags.name.trim()
        if (flags.minutes !== undefined) h.minutes = minutesOf(flags.minutes, true)
        if (flags.photo) h.photo = true
        if (flags['no-photo']) h.photo = false
      } else if (sub === 'rm') {
        if (!s.habits.some((x) => x.id === args[0])) fail(`unknown habit: ${args[0]}`)
        s.habits = s.habits.filter((x) => x.id !== args[0])
      } else fail(`unknown habit command: ${sub}`)
      break
    }
    case 'task': {
      const [sub, ...args] = rest
      if (sub === 'add') {
        const name = args.join(' ').trim()
        if (!name) fail('task needs a name')
        const minutes = minutesOf(flags.minutes, false)
        const id = uniqueId(name, s.tasks.map((t) => t.id))
        s.tasks.push({ id, name, minutes, done: false })
      } else if (sub === 'rm') {
        if (!s.tasks.some((x) => x.id === args[0])) fail(`unknown task: ${args[0]}`)
        s.tasks = s.tasks.filter((x) => x.id !== args[0])
      } else fail(`unknown task command: ${sub}`)
      break
    }
    default:
      fail(`unknown command: ${cmd}`)
  }
  save(s)
  process.stdout.write(JSON.stringify(view(s), null, 2) + '\n')
}

log()
try {
  run()
} catch (e) {
  const message = e instanceof Error ? e.message : String(e)
  if (argv.includes('--json')) process.stdout.write(JSON.stringify({ error: message }) + '\n')
  else process.stderr.write(`${message}\n`)
  process.exit(1)
}
