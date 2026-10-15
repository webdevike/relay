// Builds a fresh, date-relative copy of fixtures/eva-p3 per test, plus the env that wires the fakes.
//
// Pattern for a spec that needs dated data or writes (never mutate fixtures/eva-root or the template):
//   let fx: EvaFixture
//   test.beforeEach(() => { fx = makeEvaFixture() })
//   test.afterEach(() => fx.cleanup())
//   test.use({ launchEnv: ... })  // static options cannot see fx, so instead launch with
//   launchApp(configDir, fx.env), or override the `launchEnv` fixture in a test.extend().
// buildLaunchEnv already defaults the fake gate (unlocked) and fake job-run for every spec.
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { EVA_P3_TEMPLATE, FAKE_GATE, FAKE_JOB_RUN, SESSIONS_FIXTURE_DIR } from './paths'

export interface EvaFixtureOpts {
  now?: Date
  gateScenario?: 'unlocked' | 'locked'
  minuteMs?: number
  jobMs?: number
}

export interface EvaFixture {
  root: string
  dir: string
  env: Record<string, string>
  read(rel: string): string
  gateLog(): unknown[]
  jobLog(): unknown[]
  cleanup(): void
}

/** Numbers specs assert against; mirrors fixtures/eva-p3/README.md. */
export const EXPECT_P3 = {
  workspaces: 7,
  openTodos: 5,
  nextId: 'T16',
  updatesThisWeek: 4,
  filters: { all: 7, active: 5, todos: 4, quiet: 2 },
  jobs: 6,
  scheduledJobs: 4,
  meetings: 5,
  pendingProposals: 3,
  meetingsThisWeek: 2,
} as const

const SESSION_FILE = path.join(SESSIONS_FIXTURE_DIR, '2026-10-01T09-00-00-000Z_small.jsonl')

const pad = (n: number): string => String(n).padStart(2, '0')
const ymd = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

/** Local date today-N at HH:MM. Built with local setters, never by slicing ISO strings. */
function localAt(now: Date, daysAgo: number, hhmm: string): Date {
  const [h, m] = hhmm.split(':').map(Number)
  const d = new Date(now)
  d.setDate(d.getDate() - daysAgo)
  d.setHours(h, m, 0, 0)
  return d
}

export function resolveTokens(text: string, now: Date, root: string): string {
  return text.replace(/\{\{([^}]+)\}\}/g, (whole, body: string) => {
    let m = /^day([+-])(\d+)$/.exec(body)
    if (m) {
      const d = new Date(now)
      d.setDate(d.getDate() + (m[1] === '+' ? 1 : -1) * Number(m[2]))
      return ymd(d)
    }
    m = /^(at|ms|runid)-(\d+)-(\d{2}:\d{2})$/.exec(body)
    if (m) {
      const d = localAt(now, Number(m[2]), m[3])
      if (m[1] === 'at') return d.toISOString()
      if (m[1] === 'ms') return String(d.getTime())
      return `${ymd(d)}T${pad(d.getHours())}${pad(d.getMinutes())}00`
    }
    if (body === 'root') return root
    if (body === 'session-file') return SESSION_FILE
    throw new Error(`unknown fixture token: ${whole}`)
  })
}

function copyResolved(src: string, dest: string, now: Date, root: string): void {
  fs.mkdirSync(dest, { recursive: true })
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const name = resolveTokens(entry.name, now, root)
    const from = path.join(src, entry.name)
    const to = path.join(dest, name)
    if (entry.isDirectory()) copyResolved(from, to, now, root)
    else if (entry.name === 'README.md')
      continue // documents the tokens literally; not part of the root
    else fs.writeFileSync(to, resolveTokens(fs.readFileSync(from, 'utf8'), now, root))
  }
}

export function makeEvaFixture(opts: EvaFixtureOpts = {}): EvaFixture {
  const now = opts.now ?? new Date()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evaos-p3-'))
  const root = path.join(dir, 'eva')
  copyResolved(EVA_P3_TEMPLATE, root, now, root)
  const logFile = path.join(dir, 'fake-log.jsonl')
  const env: Record<string, string> = {
    EVAOS_EVA_ROOT: root,
    EVAOS_HABIT_GATE_BIN: FAKE_GATE,
    EVAOS_JOB_RUN_BIN: FAKE_JOB_RUN,
    EVAOS_HABIT_PHOTOS_DIR: path.join(dir, 'photos'),
    FAKE_GATE_STATE: path.join(dir, 'gate.json'),
    FAKE_GATE_PHOTOS: path.join(dir, 'photos'),
    FAKE_GATE_SCENARIO: opts.gateScenario ?? 'unlocked',
    FAKE_GATE_MINUTE_MS: String(opts.minuteMs ?? 60000),
    FAKE_LOG: logFile,
    FAKE_JOB_RUN_WRITE: '1',
    FAKE_JOB_MS: String(opts.jobMs ?? 1500),
  }
  const log = (tool: string): unknown[] => {
    if (!fs.existsSync(logFile)) return []
    return fs
      .readFileSync(logFile, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { tool: string })
      .filter((e) => e.tool === tool)
  }
  return {
    root,
    dir,
    env,
    read: (rel) => fs.readFileSync(path.join(root, rel), 'utf8'),
    gateLog: () => log('gate'),
    jobLog: () => log('job-run'),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  }
}
