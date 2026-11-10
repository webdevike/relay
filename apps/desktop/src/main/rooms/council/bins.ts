import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

/** A regular file this process may execute. */
export function isExecutable(file: string): boolean {
  try {
    if (!fs.statSync(file).isFile()) return false
    fs.accessSync(file, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

function dirs(pathEnv: string | undefined): string[] {
  return (pathEnv ?? '').split(path.delimiter).filter((d) => d !== '')
}

function listDir(dir: string): string[] {
  try {
    return fs.readdirSync(dir)
  } catch {
    return []
  }
}

/** Highest semver first: `v24.22.0` before `v22.9.1`. */
function byVersionDesc(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split('.').map(Number)
  const pb = b.replace(/^v/, '').split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const d = (pb[i] ?? 0) - (pa[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

/**
 * fnm's node bin dirs: the default alias first, then every installed version, newest first.
 * fnm's per-shell `fnm_multishells` dirs are gone once that shell exits, so they never count.
 */
export function fnmBinDirs(homedir: string): string[] {
  const root = path.join(homedir, '.local/share/fnm')
  const versions = listDir(path.join(root, 'node-versions'))
    .filter((v) => /^v\d/.test(v))
    .sort(byVersionDesc)
    .map((v) => path.join(root, 'node-versions', v, 'installation/bin'))
  return [path.join(root, 'aliases/default/bin'), ...versions].filter((d) =>
    fs.existsSync(path.join(d, 'node')),
  )
}

/**
 * PATH for a seat. A packaged app starts with launchd's bare PATH, so the usual tool dirs are
 * appended after whatever PATH the app already has: ~/.local/bin (omp, claude), Homebrew,
 * /usr/local/bin, ~/.bun/bin, fnm's node (codex, npm globals), then the system dirs.
 */
export function seatPath(basePath: string | undefined, homedir = os.homedir()): string {
  const out: string[] = []
  for (const d of [
    ...dirs(basePath),
    path.join(homedir, '.local/bin'),
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    path.join(homedir, '.bun/bin'),
    ...fnmBinDirs(homedir),
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ]) {
    if (!out.includes(d)) out.push(d)
  }
  return out.join(path.delimiter)
}

/** First executable `name` in the PATH dirs, else in `extra`; null when there is none. */
export function whichIn(
  name: string,
  pathEnv: string | undefined,
  extra: string[] = [],
): string | null {
  for (const d of [...dirs(pathEnv), ...extra]) {
    const candidate = path.join(d, name)
    if (isExecutable(candidate)) return candidate
  }
  return null
}

/** The Claude Code CLI: PATH, then ~/.local/bin and Homebrew; null when it is not installed. */
export function findClaude(
  env: NodeJS.ProcessEnv = process.env,
  homedir = os.homedir(),
): string | null {
  return whichIn('claude', env.PATH, [path.join(homedir, '.local/bin'), '/opt/homebrew/bin'])
}

/**
 * The native binary behind the npm `codex` wrapper (`bin/codex.js`), so a seat needs no node:
 * `<pkg>/node_modules/@openai/codex-<platform>/vendor/<triple>/bin/codex`, or the older
 * `<pkg>/vendor/<triple>/bin/codex`. Anything else is returned as is.
 */
export function nativeCodex(bin: string): string {
  let real: string
  try {
    real = fs.realpathSync(bin)
  } catch {
    return bin
  }
  if (!real.endsWith(path.join('bin', 'codex.js'))) return real
  const pkg = path.dirname(path.dirname(real))
  const vendors = [
    ...listDir(path.join(pkg, 'node_modules/@openai'))
      .filter((p) => p.startsWith('codex-'))
      .map((p) => path.join(pkg, 'node_modules/@openai', p, 'vendor')),
    path.join(pkg, 'vendor'),
  ]
  for (const v of vendors) {
    for (const triple of listDir(v)) {
      const candidate = path.join(v, triple, 'bin/codex')
      if (isExecutable(candidate)) return candidate
    }
  }
  return real
}

/**
 * The Codex CLI: PATH and the usual bin dirs, then every fnm node version (where
 * `npm i -g @openai/codex` puts it); the native vendor binary when there is one.
 */
export function findCodex(
  env: NodeJS.ProcessEnv = process.env,
  homedir = os.homedir(),
): string | null {
  const root = path.join(homedir, '.local/share/fnm/node-versions')
  const fnm = listDir(root)
    .sort(byVersionDesc)
    .map((v) => path.join(root, v, 'installation/bin'))
  const found = whichIn('codex', env.PATH, [
    path.join(homedir, '.local/bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    ...fnm,
  ])
  return found === null ? null : nativeCodex(found)
}
