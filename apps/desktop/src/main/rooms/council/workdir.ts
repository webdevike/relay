import { execFile } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { RoomRender } from '@evaos/contract'

/**
 * Runs a program and resolves with its stdout; rejects with stderr on a non-zero exit. Copies,
 * merges and commits in a room workdir go through child processes (cp, mkdir, git).
 */
export type Exec = (file: string, args: string[], cwd: string) => Promise<string>

export const execFileP: Exec = (file, args, cwd) => {
  const { promise, resolve, reject } = Promise.withResolvers<string>()
  execFile(file, args, { cwd, maxBuffer: 32 * 1024 * 1024 }, (e, stdout, stderr) => {
    if (e) reject(new Error(`${file} ${args.join(' ')}: ${String(stderr).trim() || e.message}`))
    else resolve(String(stdout))
  })
  return promise
}

/** Git with a fixed identity and no user hooks or signing, so room commits never prompt. */
const GIT = [
  '-c',
  'user.name=Relay Room',
  '-c',
  'user.email=room@relay.local',
  '-c',
  'commit.gpgsign=false',
  '-c',
  'core.hooksPath=/dev/null',
]

/** Outputs a tree makes are never tracked: renders would conflict on every merge. */
const EXCLUDES = ['renders/', '__pycache__/', '*.pyc', '*.blend1', '.DS_Store']

const IMAGE_RE = /\.(png|jpe?g|webp)$/i

/** The branch main/ is on; seats branch off it as `seat/<seat id>`. */
export const MAIN_BRANCH = 'main'
export const seatBranch = (seatId: string): string => `seat/${seatId}`

/**
 * `<eva>/work/rooms/<room id>`: `main/` (the integrator's tree, a git repo holding a copy of the
 * source), `seats/<seat id>/` (one worktree per seat), `refs/` (read-only copies of the
 * references), `rounds/r<N>/<seat id>/` (every render a turn made, kept past overwrites),
 * `tmp/<seat id>/` (each seat's TMPDIR), `sessions/<seat id>/` (omp seats' session files) and
 * `room.json` (the room's saved state, council/state.ts).
 */
export class RoomWorkdir {
  readonly main: string
  readonly refsDir: string
  readonly roundsDir: string
  readonly seatsDir: string

  private constructor(
    readonly root: string,
    /** The references as copied into `refs/`, absolute. */
    readonly refs: string[],
    private readonly exec: Exec,
  ) {
    this.main = path.join(root, 'main')
    this.refsDir = path.join(root, 'refs')
    this.roundsDir = path.join(root, 'rounds')
    this.seatsDir = path.join(root, 'seats')
  }

  /**
   * Copies `source` (never touched again; a chat room may have none) and `refs`, then makes main/
   * a repo with one commit.
   */
  static async create(o: {
    evaRoot: string
    roomId: string
    source?: string
    refs: readonly string[]
    exec?: Exec
  }): Promise<RoomWorkdir> {
    const exec = o.exec ?? execFileP
    const source = o.source === undefined ? null : path.resolve(o.evaRoot, o.source)
    if (source !== null && !fs.statSync(source, { throwIfNoEntry: false })?.isDirectory()) {
      throw Object.assign(new Error(`The source folder ${source} does not exist.`), {
        code: 'bad-input',
      })
    }
    const root = path.join(o.evaRoot, 'work', 'rooms', o.roomId)
    const wd0 = new RoomWorkdir(root, [], exec)
    await exec('mkdir', ['-p', wd0.main, wd0.refsDir, wd0.roundsDir, wd0.seatsDir], o.evaRoot)
    if (source !== null) {
      await exec('cp', ['-R', `${source}/.`, wd0.main], o.evaRoot)
      // A source that is its own repo would drag its history (and remotes) into the room.
      await exec('rm', ['-rf', path.join(wd0.main, '.git')], root)
    }
    const refs: string[] = []
    for (const [i, r] of o.refs.entries()) {
      const abs = path.resolve(o.evaRoot, r)
      if (!fs.existsSync(abs)) continue
      const base = path.basename(abs)
      const dest = path.join(
        wd0.refsDir,
        refs.some((x) => path.basename(x) === base) ? `${i}-${base}` : base,
      )
      await exec('cp', ['-R', abs, dest], root)
      refs.push(dest)
    }
    const wd = new RoomWorkdir(root, refs, exec)
    await wd.git(wd.main, ['init', '-q', '-b', MAIN_BRANCH])
    await exec(
      'sh',
      ['-c', `printf '%s\\n' ${EXCLUDES.map((e) => `'${e}'`).join(' ')} >> .git/info/exclude`],
      wd.main,
    )
    await wd.git(wd.main, ['add', '-A'])
    await wd.git(wd.main, [
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      source === null ? 'Room workdir' : `Room source: ${source}`,
    ])
    return wd
  }

  /** The workdir a saved room already has (Resume): nothing is copied again. */
  static open(o: { root: string; refs: readonly string[]; exec?: Exec }): RoomWorkdir {
    if (!fs.statSync(path.join(o.root, 'main'), { throwIfNoEntry: false })?.isDirectory()) {
      throw Object.assign(new Error(`The room workdir ${o.root} is gone.`), { code: 'bad-input' })
    }
    return new RoomWorkdir(o.root, [...o.refs], o.exec ?? execFileP)
  }

  git(cwd: string, args: string[]): Promise<string> {
    return this.exec('git', [...GIT, ...args], cwd)
  }

  /** A seat's worktree on its own branch, `seats/<seat id>`, from main's tip (kept when it exists). */
  async addSeat(seatId: string): Promise<string> {
    const dir = path.join(this.seatsDir, seatId)
    if (fs.existsSync(path.join(dir, '.git'))) return dir
    await this.git(this.main, ['worktree', 'add', '-q', '-b', seatBranch(seatId), dir, MAIN_BRANCH])
    return dir
  }

  async head(tree: string): Promise<string> {
    return (await this.git(tree, ['rev-parse', 'HEAD'])).trim()
  }

  /** Commits whatever the tree has (no-op when clean); resolves with HEAD. */
  async commit(tree: string, message: string): Promise<string> {
    await this.git(tree, ['add', '-A'])
    const dirty = (await this.git(tree, ['status', '--porcelain'])).trim() !== ''
    if (dirty) await this.git(tree, ['commit', '-q', '-m', message])
    return this.head(tree)
  }

  /** Files that changed between `from` and HEAD. */
  async changed(tree: string, from: string): Promise<string[]> {
    const out = await this.git(tree, ['diff', '--name-only', from, 'HEAD'])
    return out.split('\n').filter((l) => l.trim() !== '')
  }

  /**
   * Brings the integrated tree into a seat's worktree. A conflicting merge is aborted (the seat
   * keeps its own tree) and resolves false.
   */
  async syncFromMain(tree: string): Promise<boolean> {
    try {
      await this.git(tree, ['merge', '-q', '--no-edit', MAIN_BRANCH])
      return true
    } catch {
      await this.git(tree, ['merge', '--abort']).catch(() => undefined)
      return false
    }
  }

  /**
   * Images under `<tree>/renders` changed at or after `since` plus `extra` (images a seat
   * generated), copied to `rounds/<round>/<seat id>/` so later turns cannot overwrite them.
   */
  async keepRenders(o: {
    tree: string | null
    since: number
    extra: readonly string[]
    round: string
    seatId: string
    caption: string
  }): Promise<RoomRender[]> {
    const found: { src: string; name: string }[] = []
    if (o.tree) {
      const renders = path.join(o.tree, 'renders')
      for (const rel of walk(renders)) {
        const src = path.join(renders, rel)
        const st = fs.statSync(src, { throwIfNoEntry: false })
        if (st && st.mtimeMs >= o.since) found.push({ src, name: rel.split(path.sep).join('__') })
      }
    }
    for (const src of o.extra) {
      if (IMAGE_RE.test(src) && fs.existsSync(src)) found.push({ src, name: path.basename(src) })
    }
    if (found.length === 0) return []
    const dest = path.join(this.roundsDir, o.round, o.seatId)
    await this.exec('mkdir', ['-p', dest], this.root)
    const out: RoomRender[] = []
    const names = new Set<string>()
    for (const f of found.sort((a, b) => a.name.localeCompare(b.name))) {
      let name = f.name
      for (let n = 2; names.has(name); n++) name = `${n}-${f.name}`
      names.add(name)
      const to = path.join(dest, name)
      await this.exec('cp', ['-p', f.src, to], this.root)
      out.push({ path: to, caption: `${o.caption}: ${name.replace(/__/g, '/')}` })
    }
    return out
  }
}

/** Image files under `dir`, relative, depth-first; nothing when it is missing. */
function walk(dir: string, rel = ''): string[] {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true })
  } catch {
    return []
  }
  const out: string[] = []
  for (const e of entries) {
    const r = rel === '' ? e.name : path.join(rel, e.name)
    if (e.isDirectory()) out.push(...walk(dir, r))
    else if (e.isFile() && IMAGE_RE.test(e.name)) out.push(r)
  }
  return out
}

/**
 * The real path of `p` when it is a room image: inside the room workdir or one of its refs (the
 * originals or the copies). Anything else is a bad path.
 */
export function roomImagePath(workdir: string, refs: readonly string[], p: string): string {
  const bad = (): Error => Object.assign(new Error(`Not a room image: ${p}`), { code: 'bad-path' })
  if (!path.isAbsolute(p) || !IMAGE_RE.test(p)) throw bad()
  let real: string
  try {
    real = fs.realpathSync(p)
  } catch {
    throw bad()
  }
  const inside = (root: string): boolean => {
    let r: string
    try {
      r = fs.realpathSync(root)
    } catch {
      return false
    }
    const rel = path.relative(r, real)
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
  }
  if (inside(workdir) || refs.some(inside)) return real
  throw bad()
}
