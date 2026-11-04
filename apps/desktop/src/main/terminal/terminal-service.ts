import * as fs from 'node:fs'
import * as path from 'node:path'
import type { Place } from '@evaos/chat-core/work'
import type { TerminalMode } from '@evaos/contract'
import { CodedError } from '../chat/session-ops'

/** More ptys than this is a leak, not a workflow. */
export const MAX_TERMINALS = 16
/** Output is batched this long before it crosses IPC, so a fast `cat` is a few messages, not thousands. */
export const FLUSH_MS = 6
const FLUSH_BYTES = 64 * 1024

/** The part of a node-pty process this service uses (a seam for tests). */
export interface PtyLike {
  onData(cb: (data: string) => void): unknown
  onExit(cb: (e: { exitCode: number }) => void): unknown
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): void
}

export interface PtySpawn {
  file: string
  argv: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  cols: number
  rows: number
}

export interface TerminalDeps {
  evaRoot: string
  homedir: string
  /** The user's login shell. */
  shell: string
  /** herdr, or null when it is not installed. */
  herdrBin: string | null
  /** A chat session's place; null when it cannot be read. */
  placeOf: (file: string) => Place | null
  /** The environment a child gets (PATH resolved the way chat children get it). */
  env: () => Promise<NodeJS.ProcessEnv>
  /** The herdr pane that runs the session file, or null. */
  paneOf: (file: string) => Promise<string | null>
  spawn: (p: PtySpawn) => PtyLike
  emitData: (id: string, data: string) => void
  emitExit: (id: string, code: number | null) => void
  setTimer?: (fn: () => void, ms: number) => unknown
}

export interface TerminalService {
  spawn(input: {
    file: string | null
    mode: TerminalMode
    cols: number
    rows: number
    /** A herdr pane to attach to view-only (mode `attach`): no takeover, input ignored. */
    watch?: string
  }): Promise<{ id: string; cwd: string; title: string }>
  write(id: string, data: string): void
  resize(id: string, cols: number, rows: number): void
  kill(id: string): void
  attachable(file: string | null): Promise<string | null>
  /** Ends every pty (app quit). */
  close(): void
  size(): number
}

interface Live {
  pty: PtyLike
  pending: string
  timer: unknown
  /** A view-only attach: what the user types is dropped. */
  viewOnly: boolean
}

const isDir = (p: string): boolean => {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

/** herdr's markers of "this process runs inside a herdr pane": they make a nested `herdr` refuse to start. */
const HERDR_PANE_VARS = ['HERDR_ENV', 'HERDR_PANE_ID', 'HERDR_TAB_ID', 'HERDR_WORKSPACE_ID']

/**
 * The environment a terminal program expects, without the Electron process's own switches and,
 * when the app itself was started from a herdr pane, without that pane's identity.
 */
export function terminalEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base }
  for (const key of Object.keys(env)) {
    if (key.startsWith('ELECTRON_') || key.startsWith('EVAOS_E2E')) delete env[key]
  }
  for (const key of HERDR_PANE_VARS) delete env[key]
  delete env['RELAY_HERDR_OWNED']
  env['TERM'] = 'xterm-256color'
  env['COLORTERM'] = 'truecolor'
  env['TERM_PROGRAM'] = 'Relay'
  return env
}

export function createTerminalService(deps: TerminalDeps): TerminalService {
  const live = new Map<string, Live>()
  let seq = 0
  const timer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))

  const flush = (id: string): void => {
    const t = live.get(id)
    if (!t) return
    t.timer = null
    if (t.pending === '') return
    const data = t.pending
    t.pending = ''
    deps.emitData(id, data)
  }

  const folder = (file: string | null): string => {
    const place = file === null ? null : deps.placeOf(file)
    for (const candidate of [place?.active, place?.cwd, deps.evaRoot, deps.homedir]) {
      if (candidate && isDir(candidate)) return candidate
    }
    return deps.homedir
  }

  const known = (id: string): Live => {
    const t = live.get(id)
    if (!t) throw new CodedError('not-found', 'That terminal has ended.')
    return t
  }

  return {
    async spawn({ file, mode, cols, rows, watch }) {
      if (live.size >= MAX_TERMINALS) {
        throw new CodedError('too-many', `At most ${MAX_TERMINALS} terminals can be open.`)
      }
      const cwd = folder(file)
      const env = terminalEnv(await deps.env())
      let command: { file: string; argv: string[]; title: string }
      if (mode === 'attach') {
        if (deps.herdrBin === null) throw new CodedError('no-herdr', 'herdr is not installed.')
        const pane = watch ?? (file === null ? null : await deps.paneOf(file))
        if (pane === null)
          throw new CodedError('not-in-herdr', 'This chat is not running in herdr.')
        command = {
          file: deps.herdrBin,
          argv: ['agent', 'attach', pane, ...(watch === undefined ? ['--takeover'] : [])],
          title: 'herdr',
        }
      } else {
        command = { file: deps.shell, argv: ['-l'], title: path.basename(deps.shell) }
      }
      const id = `t${++seq}`
      const pty = deps.spawn({ file: command.file, argv: command.argv, cwd, env, cols, rows })
      const entry: Live = { pty, pending: '', timer: null, viewOnly: watch !== undefined }
      live.set(id, entry)
      pty.onData((data) => {
        entry.pending += data
        if (entry.pending.length >= FLUSH_BYTES) flush(id)
        else entry.timer ??= timer(() => flush(id), FLUSH_MS)
      })
      pty.onExit(({ exitCode }) => {
        flush(id)
        live.delete(id)
        deps.emitExit(id, exitCode)
      })
      return { id, cwd, title: command.title }
    },
    write(id, data) {
      const t = known(id)
      if (!t.viewOnly) t.pty.write(data)
    },
    resize: (id, cols, rows) => known(id).pty.resize(cols, rows),
    kill(id) {
      const t = live.get(id)
      if (!t) return
      // Its exit event follows; the entry goes there.
      t.pty.kill()
    },
    attachable: async (file) =>
      file === null || deps.herdrBin === null ? null : deps.paneOf(file),
    close() {
      for (const t of live.values()) t.pty.kill()
      live.clear()
    },
    size: () => live.size,
  }
}
