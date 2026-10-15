import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

export interface Env {
  evaRoot: string
  ompBin: string
  configDir: string
  sessionsDir: string
  arcExportCmd: string[] | null
  live: boolean
  e2e: boolean
  repoRoot: string
}

export interface ResolveEnvInput {
  env: NodeJS.ProcessEnv
  isPackaged: boolean
  repoRoot: string
  homedir: string
  tmpdir: string
  pid: number
}

const DEFAULT_ARC_CMD = ['bun', '.omp/tools/arc-cookies.ts', '.omp/tools/lib/evaos-arc-sites.txt']

function real(p: string): string {
  try {
    return fs.realpathSync(p)
  } catch {
    return path.resolve(p)
  }
}

/** Mirrors the Rust `binary()` lookup: PATH, then the usual install locations. */
function findOmp(env: NodeJS.ProcessEnv, homedir: string): string {
  const dirs = (env.PATH ?? '').split(path.delimiter).filter(Boolean)
  dirs.push(
    path.join(homedir, '.local/bin'),
    path.join(homedir, '.bun/bin'),
    '/opt/homebrew/bin',
  )
  for (const d of dirs) {
    const candidate = path.join(d, 'omp')
    try {
      if (fs.statSync(candidate).isFile()) return candidate
    } catch {
      /* keep looking */
    }
  }
  return 'omp'
}

function parseArcCmd(raw: string | undefined): string[] | null {
  if (!raw) return DEFAULT_ARC_CMD
  try {
    const parsed: unknown = JSON.parse(raw)
    if (Array.isArray(parsed) && parsed.every((x) => typeof x === 'string') && parsed.length > 0) {
      return parsed as string[]
    }
  } catch {
    /* fall through */
  }
  throw new Error('EVAOS_ARC_EXPORT_CMD must be a JSON array of strings')
}

export function resolveEnv(input: ResolveEnvInput): Env {
  const { env, isPackaged, repoRoot, homedir, tmpdir, pid } = input
  const live = isPackaged || env.EVAOS_LIVE === '1'
  const realRoot = path.join(homedir, 'Eva')

  const evaRoot = env.EVAOS_EVA_ROOT
    ? env.EVAOS_EVA_ROOT
    : live
      ? realRoot
      : path.join(repoRoot, 'fixtures/eva-root')
  if (!live && real(evaRoot) === real(realRoot)) {
    throw new Error(
      `Refusing to use the real Eva root (${realRoot}) in dev or test. Set EVAOS_LIVE=1 to opt in.`,
    )
  }

  const ompBin = env.EVAOS_OMP_BIN
    ? env.EVAOS_OMP_BIN
    : live
      ? findOmp(env, homedir)
      : path.join(repoRoot, 'fixtures/fake-omp/fake-omp.mjs')

  const sessionsDir = env.EVAOS_SESSIONS_DIR
    ? env.EVAOS_SESSIONS_DIR
    : live
      ? path.join(env.PI_CODING_AGENT_DIR || path.join(homedir, '.omp/agent'), 'sessions/-Eva')
      : path.join(repoRoot, 'fixtures/agent/sessions/-fixture')

  const configDir = env.EVAOS_CONFIG_DIR
    ? env.EVAOS_CONFIG_DIR
    : live
      ? path.join(homedir, 'Library/Application Support/EvaOS Electron')
      : path.join(tmpdir, `evaos-electron-dev-${pid}`)

  return {
    evaRoot,
    ompBin,
    configDir,
    sessionsDir,
    arcExportCmd: parseArcCmd(env.EVAOS_ARC_EXPORT_CMD),
    live,
    e2e: env.EVAOS_E2E === '1',
    repoRoot,
  }
}

export function loadEnv(app: { isPackaged: boolean; getAppPath(): string }): Env {
  return resolveEnv({
    env: process.env,
    isPackaged: app.isPackaged,
    repoRoot: path.resolve(app.getAppPath(), '../..'),
    homedir: os.homedir(),
    tmpdir: os.tmpdir(),
    pid: process.pid,
  })
}
