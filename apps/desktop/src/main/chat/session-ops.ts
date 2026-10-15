import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { LineFramer } from '@evaos/chat-core/line-framer'
import type { Command } from '../eva/spawn'

/** An error that crosses IPC with a stable kebab-case code (see ipc/handle.ts). */
export class CodedError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

export const MAYBE_RUNNING_MESSAGE =
  'This chat may be open in a terminal. Rename it there, or try again later.'
export const CHAT_RUNNING_MESSAGE = 'Close this chat before deleting it.'
export const RENAME_FAILED_MESSAGE = 'Could not rename this chat. Try again.'

const PINS_FILE = 'session-pins.json'
const RENAME_ID = 'evaos-rename'
const RENAME_TIMEOUT_MS = 20_000

/** Pinned session ids. A missing or unreadable file reads as none, like omp. */
export function readPins(agentDir: string): string[] {
  try {
    const v: unknown = JSON.parse(fs.readFileSync(path.join(agentDir, PINS_FILE), 'utf8'))
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

/** Writes omp's pins file: sorted unique ids, pretty JSON, temp file then rename. */
export function writePins(agentDir: string, ids: readonly string[]): string[] {
  const sorted = [...new Set(ids)].sort()
  fs.mkdirSync(agentDir, { recursive: true })
  const file = path.join(agentDir, PINS_FILE)
  const tmp = path.join(agentDir, `${PINS_FILE}.${process.pid}.tmp`)
  fs.writeFileSync(tmp, JSON.stringify(sorted, null, 2) + '\n')
  fs.renameSync(tmp, file)
  return sorted
}

/**
 * Deletes a session like omp's picker: the .jsonl, the artifacts folder beside it (same name
 * without .jsonl) and `<file name>.*.bak` backups. A session that only shares a name prefix stays.
 */
export function deleteSession(file: string): void {
  const ignoreMissing = (fn: () => void): void => {
    try {
      fn()
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
    }
  }
  ignoreMissing(() => fs.rmSync(file))
  ignoreMissing(() => fs.rmSync(file.replace(/\.jsonl$/, ''), { recursive: true }))
  const dir = path.dirname(file)
  const prefix = `${path.basename(file)}.`
  let names: string[] = []
  try {
    names = fs.readdirSync(dir)
  } catch {
    // directory gone: nothing left to clean
  }
  for (const name of names) {
    if (name.startsWith(prefix) && name.endsWith('.bak')) {
      ignoreMissing(() => fs.rmSync(path.join(dir, name)))
    }
  }
}

export interface RenameViaResume {
  cmd: Command
  cwd: string
  file: string
  name: string
  timeoutMs?: number
}

/**
 * Renames a session nothing is running: a short `omp --mode rpc --resume` takes `set_session_name`
 * (the name travels only in a JSON line on stdin), then exits. The file's times are put back so
 * the chat keeps its place in the list.
 */
export async function renameViaResume(o: RenameViaResume): Promise<void> {
  const st = fs.statSync(o.file)
  const fail = (): CodedError => new CodedError('rename-failed', RENAME_FAILED_MESSAGE)
  const child = spawn(o.cmd.file, o.cmd.argv, {
    cwd: o.cwd,
    env: o.cmd.env,
    stdio: ['pipe', 'pipe', 'ignore'],
    shell: false,
  })
  const exited = new Promise<void>((resolve) => {
    child.once('exit', () => resolve())
    child.once('error', () => resolve())
  })
  let spawnFailed = false
  child.once('error', () => {
    spawnFailed = true
  })

  const answer = new Promise<boolean>((resolve) => {
    const framer = new LineFramer((f) => {
      if (f.id === RENAME_ID) resolve(f.success === true)
    })
    child.stdout?.on('data', (d: Buffer) => framer.push(d))
    child.once('exit', () => resolve(false))
    child.once('error', () => resolve(false))
  })
  child.stdin?.on('error', () => undefined)
  child.stdin?.write(
    JSON.stringify({ id: RENAME_ID, type: 'set_session_name', name: o.name }) + '\n',
  )

  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), o.timeoutMs ?? RENAME_TIMEOUT_MS)
  })
  const outcome = await Promise.race([answer, timeout])
  clearTimeout(timer)
  // Closing stdin lets omp finish writing and exit. Only our own child is ever signalled.
  child.stdin?.end()
  if (outcome === 'timeout') {
    const grace = setTimeout(() => child.kill('SIGKILL'), 2000)
    await exited
    clearTimeout(grace)
  } else {
    await exited
  }
  // omp records its exit in the file either way.
  try {
    fs.utimesSync(o.file, st.atimeMs / 1000, st.mtimeMs / 1000)
  } catch {
    // the file may be gone; nothing to restore
  }
  if (outcome !== true || spawnFailed) throw fail()
}
