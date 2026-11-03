import { execFile, spawn } from 'node:child_process'
import type { GitCode, GitStatus } from '@evaos/contract'
import { CodedError } from '../chat/session-ops'

const GIT_TIMEOUT_MS = 10_000
const GIT_MAX_BUFFER = 64 * 1024 * 1024
/** A status this young is served again; calls while one runs share it. */
export const GIT_STATUS_TTL_MS = 1500

/** The environment children run with (PATH from the login shell in the app). */
export type ChildEnv = () => Promise<NodeJS.ProcessEnv>

export interface ExecResult {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

/**
 * `git --no-optional-locks <args>` in `cwd`; never rejects (a missing git is code null). The
 * flag keeps reads from taking the index lock another git in the same checkout may want.
 */
export function execGit(
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs = GIT_TIMEOUT_MS,
): Promise<ExecResult> {
  const { promise, resolve } = Promise.withResolvers<ExecResult>()
  const child = execFile(
    'git',
    ['--no-optional-locks', ...args],
    { cwd, env, timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: GIT_MAX_BUFFER },
    (error, stdout, stderr) => {
      const e = error as (NodeJS.ErrnoException & { killed?: boolean; code?: unknown }) | null
      resolve({
        code: e ? (typeof e.code === 'number' ? e.code : null) : 0,
        stdout: String(stdout),
        stderr: String(stderr),
        timedOut: !!e && e.killed === true,
      })
    },
  )
  child.stdin?.end()
  return promise
}

export interface StreamOptions {
  cwd: string
  env: NodeJS.ProcessEnv
  /** Record terminator: '\n' or '\0'. */
  sep: '\n' | '\0'
  timeoutMs: number
  signal?: AbortSignal
}

export interface StreamResult {
  code: number | null
  /** The callback asked to stop (a cap); the child was killed. */
  stopped: boolean
  timedOut: boolean
  aborted: boolean
  stderr: string
}

/**
 * Runs `file args` and hands each `sep`-terminated stdout record (UTF-8) to `onRecord` as it
 * arrives. Returning false stops: the child is killed. A timeout or `signal` kills it too.
 */
export function streamRecords(
  file: string,
  args: string[],
  o: StreamOptions,
  onRecord: (record: string) => boolean,
): Promise<StreamResult> {
  const out: StreamResult = {
    code: null,
    stopped: false,
    timedOut: false,
    aborted: false,
    stderr: '',
  }
  if (o.signal?.aborted) {
    out.aborted = true
    return Promise.resolve(out)
  }
  const { promise, resolve } = Promise.withResolvers<StreamResult>()
  const child = spawn(file, args, { cwd: o.cwd, env: o.env, stdio: 'pipe' })
  child.stdin.end()
  const sepByte = o.sep === '\n' ? 0x0a : 0x00
  let pending: Buffer = Buffer.alloc(0)
  let done = false
  const kill = (): void => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
  const timer = setTimeout(() => {
    out.timedOut = true
    kill()
  }, o.timeoutMs)
  const onAbort = (): void => {
    out.aborted = true
    kill()
  }
  o.signal?.addEventListener('abort', onAbort, { once: true })
  child.stdout.on('data', (chunk: Buffer) => {
    if (out.stopped || out.aborted || out.timedOut) return
    let buf = pending.length > 0 ? Buffer.concat([pending, chunk]) : chunk
    let at = buf.indexOf(sepByte)
    while (at !== -1) {
      if (!onRecord(buf.toString('utf8', 0, at))) {
        out.stopped = true
        kill()
        return
      }
      buf = buf.subarray(at + 1)
      at = buf.indexOf(sepByte)
    }
    pending = buf
  })
  child.stderr.on('data', (chunk: Buffer) => {
    if (out.stderr.length < 4000) out.stderr += chunk.toString('utf8')
  })
  const finish = (code: number | null): void => {
    if (done) return
    done = true
    clearTimeout(timer)
    o.signal?.removeEventListener('abort', onAbort)
    if (!out.stopped && !out.aborted && !out.timedOut && pending.length > 0) {
      onRecord(pending.toString('utf8'))
    }
    out.code = code
    resolve(out)
  }
  child.on('error', (e) => {
    out.stderr += e.message
    finish(null)
  })
  child.on('close', (code) => finish(code))
  return promise
}

export interface RepoInfo {
  /** Repo-relative path of the root, '' at the top or ending with '/'. */
  prefix: string
}

/** The checkout `root` sits in, or null when it is not inside one (or git is missing). */
export async function repoOf(root: string, env: NodeJS.ProcessEnv): Promise<RepoInfo | null> {
  const r = await execGit(['rev-parse', '--show-toplevel', '--show-prefix'], root, env)
  if (r.code !== 0) return null
  const lines = r.stdout.split('\n')
  if (lines.length < 2 || lines[0] === '') return null
  return { prefix: lines[1] ?? '' }
}

/** The checked-out branch, else the short commit when detached, else null (no commit yet). */
async function branchOf(root: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  const sym = await execGit(['symbolic-ref', '--short', '-q', 'HEAD'], root, env)
  if (sym.code === 0 && sym.stdout.trim() !== '') return sym.stdout.trim()
  const sha = await execGit(['rev-parse', '--short', 'HEAD'], root, env)
  return sha.code === 0 && sha.stdout.trim() !== '' ? sha.stdout.trim() : null
}

function codeOf(xy: string): GitCode {
  const x = xy[0]
  const y = xy[1]
  if (xy === '??') return 'U'
  if (x === 'U' || y === 'U' || xy === 'AA' || xy === 'DD') return 'C'
  if (x === 'R' || y === 'R') return 'R'
  if (x === 'A' || x === 'C') return 'A'
  if (x === 'D' || y === 'D') return 'D'
  return 'M'
}

/**
 * `git status --porcelain=v1 -z` output (repo-relative paths) to root-relative changes and
 * ignored paths. A rename or copy entry carries its source path as the next field. An untracked
 * folder comes as `dir/` and is stored as `dir` (U covers everything below it); ignored folders
 * keep their trailing '/'. Paths outside the root (not under `prefix`) are dropped.
 */
export function parsePorcelain(
  out: string,
  prefix: string,
): { changes: Record<string, GitCode>; ignored: string[] } {
  const changes: Record<string, GitCode> = {}
  const ignored: string[] = []
  const fields = out.split('\0')
  for (let i = 0; i < fields.length; i++) {
    const rec = fields[i]!
    if (rec.length < 4) continue
    const xy = rec.slice(0, 2)
    if (/[RC]/.test(xy)) i++
    const full = rec.slice(3)
    if (!full.startsWith(prefix)) continue
    const rel = full.slice(prefix.length)
    if (rel === '' || rel === '/') continue
    if (xy === '!!') {
      ignored.push(rel)
      continue
    }
    changes[rel.endsWith('/') ? rel.slice(0, -1) : rel] = codeOf(xy)
  }
  return { changes, ignored }
}

/** Git status of `root` (a real path), with no cache. */
export async function gitStatus(root: string, env: NodeJS.ProcessEnv): Promise<GitStatus> {
  const repo = await repoOf(root, env)
  if (repo === null) return { repo: false, branch: null, changes: {}, ignored: [] }
  const [st, branch] = await Promise.all([
    execGit(
      [
        'status',
        '--porcelain=v1',
        '-z',
        '--ignored=traditional',
        '--untracked-files=normal',
        '--',
        '.',
      ],
      root,
      env,
    ),
    branchOf(root, env),
  ])
  if (st.code !== 0) {
    throw new CodedError(
      'git-failed',
      st.timedOut ? 'git status took too long.' : `git status failed: ${st.stderr.trim()}`,
    )
  }
  return { repo: true, branch, ...parsePorcelain(st.stdout, repo.prefix) }
}

/**
 * Git status per root: a result younger than `ttlMs` is served again, and calls while one runs
 * share it. A failed run is not kept.
 */
export function createGitStatusCache(
  env: ChildEnv,
  ttlMs = GIT_STATUS_TTL_MS,
  now: () => number = Date.now,
): (root: string) => Promise<GitStatus> {
  const cache = new Map<string, { at: number | null; value: Promise<GitStatus> }>()
  return (root) => {
    const hit = cache.get(root)
    if (hit && (hit.at === null || now() - hit.at < ttlMs)) return hit.value
    const entry: { at: number | null; value: Promise<GitStatus> } = {
      at: null,
      value: env().then((e) => gitStatus(root, e)),
    }
    cache.set(root, entry)
    entry.value.then(
      () => {
        entry.at = now()
      },
      () => {
        if (cache.get(root) === entry) cache.delete(root)
      },
    )
    return entry.value
  }
}
