import { execFile, spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { resolveSpawnPath } from '../chat/shell-path'
import { registerTestHook } from '../test-hooks'

export interface Command {
  file: string
  argv: string[]
  env: NodeJS.ProcessEnv
}

export interface BuildOptions {
  pathEnv: string
  homedir: string
  execPath: string
  baseEnv: NodeJS.ProcessEnv
  exists?: (p: string) => boolean
}

const defaultExists = (p: string): boolean => {
  try {
    return fs.statSync(p).isFile()
  } catch {
    return false
  }
}

/** First `bun` on PATH, then /opt/homebrew/bin, then ~/.bun/bin, else the bare name. */
export function resolveBun(
  pathEnv: string,
  homedir: string,
  exists: (p: string) => boolean = defaultExists,
): string {
  const dirs = pathEnv.split(path.delimiter).filter(Boolean)
  dirs.push('/opt/homebrew/bin', path.join(homedir, '.bun/bin'))
  for (const d of dirs) {
    const candidate = path.join(d, 'bun')
    if (exists(candidate)) return candidate
  }
  return 'bun'
}

function nodeOnPath(pathEnv: string, exists: (p: string) => boolean): boolean {
  return pathEnv.split(path.delimiter).some((d) => d !== '' && exists(path.join(d, 'node')))
}

function withDirs(pathEnv: string, extra: string[]): string {
  const seen = new Set<string>()
  const out: string[] = []
  for (const d of [...pathEnv.split(path.delimiter), ...extra]) {
    if (d === '' || seen.has(d)) continue
    seen.add(d)
    out.push(d)
  }
  return out.join(path.delimiter)
}

/** Argv-based command: `.ts` through bun, `.mjs` through node (or Electron-as-node), else direct. */
export function buildCommand(bin: string, args: string[], o: BuildOptions): Command {
  const exists = o.exists ?? defaultExists
  const bun = resolveBun(o.pathEnv, o.homedir, exists)
  const bunDir = path.isAbsolute(bun) ? path.dirname(bun) : null
  const env: NodeJS.ProcessEnv = {
    ...o.baseEnv,
    PATH: withDirs(o.pathEnv, [
      ...(bunDir ? [bunDir] : []),
      '/opt/homebrew/bin',
      path.join(o.homedir, '.local/bin'),
    ]),
  }
  if (bin.endsWith('.ts')) return { file: bun, argv: [bin, ...args], env }
  if (bin.endsWith('.mjs')) {
    if (nodeOnPath(env.PATH ?? '', exists)) return { file: 'node', argv: [bin, ...args], env }
    return { file: o.execPath, argv: [bin, ...args], env: { ...env, ELECTRON_RUN_AS_NODE: '1' } }
  }
  return { file: bin, argv: args, env }
}

export async function childPathFor(live: boolean, homedir: string): Promise<string> {
  const base = await resolveSpawnPath(live)
  const bun = resolveBun(base, homedir)
  return withDirs(base, [
    ...(path.isAbsolute(bun) ? [path.dirname(bun)] : []),
    '/opt/homebrew/bin',
    path.join(homedir, '.local/bin'),
  ])
}

/**
 * Starts a child the app never waits on or signals (CONTEXT: never killed by the app). Resolves
 * once the process has started; rejects with code 'spawn-failed' when it cannot (for example ENOENT).
 */
export function spawnDetached(cmd: Command, cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd.file, cmd.argv, {
      cwd,
      env: cmd.env,
      stdio: 'ignore',
      detached: true,
      shell: false,
    })
    child.once('error', (e) => {
      console.error('[spawn] detached start failed:', e.message)
      reject(
        Object.assign(new Error(`Could not start ${cmd.file}: ${e.message}`), {
          code: 'spawn-failed',
        }),
      )
    })
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}

export interface CaptureResult {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

/** Runs a CLI to completion; never rejects. Only execFile's own timeout signals its own child. */
export function runCapture(cmd: Command, cwd: string, timeoutMs: number): Promise<CaptureResult> {
  return new Promise((resolve) => {
    const child = execFile(
      cmd.file,
      cmd.argv,
      { cwd, env: cmd.env, timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 4_000_000 },
      (error, stdout, stderr) => {
        const err = error as (NodeJS.ErrnoException & { killed?: boolean; code?: unknown }) | null
        const timedOut = !!err && err.killed === true
        let code: number | null = 0
        if (err) code = typeof err.code === 'number' ? err.code : null
        resolve({ code, stdout: String(stdout), stderr: String(stderr), timedOut })
      },
    )
    child.stdin?.end()
  })
}

export interface SpawnEntry {
  kind: 'job-run' | 'habit-gate'
  file: string
  argv: string[]
  cwd: string
  at: number
}

const MAX_LOG = 200
let spawnLog: SpawnEntry[] | null = null

export function recordSpawn(e2e: boolean, entry: SpawnEntry): void {
  if (!e2e) return
  if (!spawnLog) {
    spawnLog = []
    registerTestHook('spawnLog', spawnLog)
  }
  spawnLog.push(entry)
  if (spawnLog.length > MAX_LOG) spawnLog.splice(0, spawnLog.length - MAX_LOG)
}
