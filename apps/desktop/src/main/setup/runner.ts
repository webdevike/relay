import { spawn, type ChildProcess } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { SetupRun } from '@evaos/contract'
import type { Command } from '../eva/spawn'

/** The scripts the wizard runs, all under resources/setup. */
export const SETUP_SCRIPTS = [
  'detect.sh',
  'install.sh',
  'scaffold-home.sh',
  'install-host.sh',
  'ai-login.sh',
] as const

/** Packaged: Relay.app/Contents/Resources/setup. Dev: apps/desktop/resources/setup. */
export function resolveSetupDir(
  o: { packaged: boolean; resourcesPath: string; appPath: string; override?: string },
  exists: (p: string) => boolean = (p) => fs.existsSync(p),
): string | null {
  const candidates = [
    ...(o.override ? [o.override] : []),
    o.packaged ? path.join(o.resourcesPath, 'setup') : path.join(o.appPath, 'resources/setup'),
  ]
  return candidates.find((d) => exists(d)) ?? null
}

/** Packaged: Relay.app/Contents/Resources/RelayHost/Relay Host.app. Dev: apps/desktop/resources/RelayHost. An explicit RELAY_HOST_APP wins. */
export function resolveHostApp(
  o: { packaged: boolean; resourcesPath: string; appPath: string; override?: string },
  exists: (p: string) => boolean = (p) => fs.existsSync(p),
): string | null {
  const candidates = [
    ...(o.override ? [o.override] : []),
    o.packaged
      ? path.join(o.resourcesPath, 'RelayHost/Relay Host.app')
      : path.join(o.appPath, 'resources/RelayHost/Relay Host.app'),
  ]
  return candidates.find((d) => exists(d)) ?? null
}

export function missingScripts(
  dir: string | null,
  exists: (p: string) => boolean = (p) => fs.existsSync(p),
): string[] {
  if (dir === null) return [...SETUP_SCRIPTS]
  return SETUP_SCRIPTS.filter((s) => !exists(path.join(dir, s)))
}

/** `~` and `~/x` to the home folder; anything else untouched. */
export function expandHome(p: string, homedir: string): string {
  if (p === '~') return homedir
  if (p.startsWith('~/')) return path.join(homedir, p.slice(2))
  return p
}

/**
 * The folder a wizard may build a home base in: absolute, not the home folder itself, and never
 * Eva's own (~/Eva, or anything inside it).
 */
export function checkRoot(raw: string, homedir: string): string {
  const root = path.resolve(expandHome(raw, homedir))
  const eva = path.join(homedir, 'Eva')
  const inside = (parent: string): boolean => root === parent || root.startsWith(parent + path.sep)
  if (!path.isAbsolute(root) || root === homedir || root === '/') {
    throw Object.assign(new Error('Pick a folder inside your home folder, like ~/Relay.'), {
      code: 'root-refused',
    })
  }
  if (inside(eva)) {
    throw Object.assign(new Error('That folder belongs to another setup. Pick a different one.'), {
      code: 'root-refused',
    })
  }
  return root
}

export type ScriptLine =
  | { kind: 'progress'; percent: number; message: string }
  | { kind: 'ok'; version: string }
  | { kind: 'err'; message: string }
  | { kind: 'text'; text: string }

/** `PROGRESS <0-100> <message>`, `OK <version>` and `ERR <message>` are the scripts' protocol. */
export function parseLine(line: string): ScriptLine | null {
  const t = line.replace(/\r$/, '')
  if (t.trim() === '') return null
  const p = /^PROGRESS\s+(\d{1,3})(?:\s+(.*))?$/.exec(t)
  if (p) {
    return { kind: 'progress', percent: Math.min(100, Number(p[1])), message: p[2] ?? '' }
  }
  const ok = /^OK(?:\s+(.*))?$/.exec(t)
  if (ok) return { kind: 'ok', version: ok[1] ?? '' }
  const bad = /^ERR(?:\s+(.*))?$/.exec(t)
  if (bad) return { kind: 'err', message: bad[1] ?? 'Failed' }
  return { kind: 'text', text: t }
}

/** Splits a stream into lines across chunk boundaries. */
export function lineSplitter(onLine: (line: string) => void): {
  push(chunk: string): void
  end(): void
} {
  let rest = ''
  return {
    push(chunk) {
      rest += chunk
      const parts = rest.split('\n')
      rest = parts.pop() ?? ''
      parts.forEach(onLine)
    },
    end() {
      if (rest !== '') onLine(rest)
      rest = ''
    },
  }
}

export interface ScriptPlan {
  script: (typeof SETUP_SCRIPTS)[number]
  args: string[]
  /** Piped to stdin (an API key); never echoed, logged or emitted. */
  stdin?: string
  /**
   * stdin stays an open pipe for the whole run and `send` writes lines to it. A browser sign-in
   * (`omp login`) reads a pasted code from stdin and ends the sign-in, callback listener and all,
   * the moment stdin closes, so its stdin must stay open until it finishes.
   */
  interactive?: boolean
  timeoutMs: number
  cleanup?: () => void
}

const MIN = 60_000

export function planRun(run: SetupRun, homedir: string): ScriptPlan {
  switch (run.task) {
    case 'install':
      return { script: 'install.sh', args: [run.tool], timeoutMs: 30 * MIN }
    case 'ai-login':
      return { script: 'ai-login.sh', args: [run.provider], interactive: true, timeoutMs: 10 * MIN }
    case 'ai-key':
      return {
        script: 'ai-login.sh',
        args: ['--stdin', run.provider],
        stdin: run.key.endsWith('\n') ? run.key : `${run.key}\n`,
        timeoutMs: 2 * MIN,
      }
    case 'scaffold': {
      const root = checkRoot(run.root, homedir)
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-setup-'))
      const answers = path.join(dir, 'answers.json')
      fs.writeFileSync(answers, JSON.stringify(run.answers, null, 2))
      return {
        script: 'scaffold-home.sh',
        args: [root, answers],
        timeoutMs: 2 * MIN,
        cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
      }
    }
    case 'install-host': {
      const root = checkRoot(run.root, homedir)
      return { script: 'install-host.sh', args: [root, run.hostName], timeoutMs: 5 * MIN }
    }
  }
}

export interface ScriptOutcome {
  ok: boolean
  version?: string
  message?: string
}

/**
 * Runs one setup script to its end, streaming each stdout/stderr line to `onLine`. Success is exit 0
 * with no `ERR` line. `cancel()` (or the timeout) closes stdin and signals the script's whole process
 * group, so nothing it started (an `omp login` holding its callback port) outlives it.
 */
export function runScript(
  cmd: Command,
  cwd: string,
  plan: Pick<ScriptPlan, 'stdin' | 'interactive' | 'timeoutMs'>,
  onLine: (line: ScriptLine) => void,
): { done: Promise<ScriptOutcome>; cancel: () => void; send: (text: string) => boolean } {
  let child: ChildProcess | null = null
  let cancelled = false
  let exited = false
  const { promise: done, resolve } = Promise.withResolvers<ScriptOutcome>()
  let version: string | undefined
  let error: string | undefined
  let lastText = ''
  const handle = (raw: string): void => {
    const line = parseLine(raw)
    if (!line) return
    if (line.kind === 'ok') version = line.version
    else if (line.kind === 'err') error = line.message
    else if (line.kind === 'text') lastText = line.text
    onLine(line)
  }
  const out = lineSplitter(handle)
  const errs = lineSplitter(handle)
  const stop = (): void => {
    const c = child
    if (c === null || exited) return
    c.stdin?.end()
    try {
      // Spawned detached, the script leads its own process group: a negative pid signals all of it.
      if (c.pid !== undefined) process.kill(-c.pid, 'SIGTERM')
    } catch {
      c.kill('SIGTERM')
    }
  }
  try {
    const c = spawn(cmd.file, cmd.argv, {
      cwd,
      env: cmd.env,
      stdio: [plan.stdin === undefined && !plan.interactive ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      shell: false,
      detached: true,
    })
    child = c
    const timer = setTimeout(() => {
      error ??= 'Timed out'
      stop()
    }, plan.timeoutMs)
    c.stdout?.setEncoding('utf8')
    c.stderr?.setEncoding('utf8')
    c.stdout?.on('data', (d: string) => out.push(d))
    c.stderr?.on('data', (d: string) => errs.push(d))
    c.stdin?.on('error', () => {})
    if (plan.stdin !== undefined) c.stdin?.end(plan.stdin)
    c.once('error', (e) => {
      clearTimeout(timer)
      exited = true
      resolve({ ok: false, message: `Could not start ${cmd.file}: ${e.message}` })
    })
    c.once('close', (code) => {
      clearTimeout(timer)
      exited = true
      c.stdin?.destroy()
      out.end()
      errs.end()
      if (cancelled) return resolve({ ok: false, message: 'Cancelled' })
      if (error !== undefined) return resolve({ ok: false, message: error })
      if (code !== 0) return resolve({ ok: false, message: lastText || `Exited with code ${code}` })
      resolve({ ok: true, ...(version !== undefined ? { version } : {}) })
    })
  } catch (e) {
    resolve({ ok: false, message: e instanceof Error ? e.message : String(e) })
  }
  return {
    done,
    cancel: () => {
      cancelled = true
      stop()
    },
    /** One line to an interactive script's stdin; false when it is not interactive or has ended. */
    send: (text) => {
      const stdin = child?.stdin
      if (!plan.interactive || exited || !stdin || stdin.writableEnded) return false
      stdin.write(`${text.replace(/[\r\n]+/g, ' ').trim()}\n`)
      return true
    },
  }
}
