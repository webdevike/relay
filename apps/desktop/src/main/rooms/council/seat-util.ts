import { execFileSync, type ChildProcess } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { STOP_STEP_MS } from '../omp-frames'

/** Where a seat's generated images land, inside its own worktree. */
export const GENERATED_DIR = path.join('renders', 'generated')

const IMAGE_EXT = /\.(png|jpe?g|webp|gif)$/i

export function isImagePath(p: string): boolean {
  return IMAGE_EXT.test(p)
}

export function imageMime(p: string): string {
  const ext = path.extname(p).toLowerCase()
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg'
  if (ext === '.webp') return 'image/webp'
  if (ext === '.gif') return 'image/gif'
  return 'image/png'
}

/**
 * Copies images a seat generated (wherever its harness saved them) into
 * `<cwd>/renders/generated/`, keeping names unique; answers the copies' absolute paths. The
 * copy runs through mkdir and cp: seat trees sit under the Eva root, where the app's write trap
 * throws on in-process writes.
 */
export function keepGenerated(files: readonly string[], cwd: string): string[] {
  if (files.length === 0) return []
  const dir = path.join(cwd, GENERATED_DIR)
  execFileSync('/bin/mkdir', ['-p', dir])
  const out: string[] = []
  for (const file of files) {
    if (path.dirname(path.resolve(file)) === dir) {
      out.push(path.resolve(file))
      continue
    }
    const ext = path.extname(file)
    const stem = path.basename(file, ext)
    let dest = path.join(dir, `${stem}${ext}`)
    for (let n = 2; fs.existsSync(dest); n++) dest = path.join(dir, `${stem}-${n}${ext}`)
    try {
      execFileSync('/bin/cp', [file, dest])
      out.push(dest)
    } catch {
      /* gone already: nothing to keep */
    }
  }
  return out
}

/** An abort as a DOMException-style error the engine can tell from a failure. */
export function abortError(reason?: unknown): Error {
  const e = new Error(typeof reason === 'string' ? reason : 'turn aborted')
  e.name = 'AbortError'
  return e
}

function signalGroup(pid: number | undefined, signal: 'SIGTERM' | 'SIGKILL'): void {
  if (pid === undefined) return
  try {
    process.kill(-pid, signal)
  } catch {
    /* already exited */
  }
}

/**
 * Ends a child spawned as a process-group leader (`detached: true`): stdin EOF, then SIGTERM to
 * the group, then SIGKILL, each step waiting STOP_STEP_MS. Resolves once it has exited.
 */
export async function stopChild(child: ChildProcess, opts: { eof: boolean }): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = Promise.withResolvers<boolean>()
  child.once('close', () => exited.resolve(true))
  const waitStep = (): Promise<boolean> => {
    const step = Promise.withResolvers<boolean>()
    const timer = setTimeout(() => step.resolve(false), STOP_STEP_MS)
    void exited.promise.then(() => {
      clearTimeout(timer)
      step.resolve(true)
    })
    return step.promise
  }
  if (opts.eof) {
    child.stdin?.end()
    if (await waitStep()) return
  }
  for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
    signalGroup(child.pid, signal)
    if (await waitStep()) return
  }
}

/** Last few stderr lines, joined for an error message. */
export class StderrTail {
  private lines: string[] = []
  private carry = ''

  push(chunk: Buffer | string): void {
    this.carry += chunk.toString()
    const parts = this.carry.split('\n')
    this.carry = parts.pop() ?? ''
    for (const l of parts) if (l.trim() !== '') this.lines.push(l.trim())
    if (this.lines.length > 8) this.lines.splice(0, this.lines.length - 8)
  }

  text(fallback: string): string {
    const all = [...this.lines, this.carry.trim()].filter((l) => l !== '')
    return all.length === 0 ? fallback : all.slice(-3).join(' | ')
  }
}
