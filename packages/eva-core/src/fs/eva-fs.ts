import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { matchWrite, type WriteKind } from './allowlist'
import { atomicWrite } from './atomic-write'
import { createPathQueue } from './path-queue'
import { withEvaFsWrite } from './write-trap'

export type { WriteKind }

export class EvaFsDenied extends Error {
  constructor(
    readonly kind: string,
    readonly path: string,
    readonly reason: string,
  ) {
    super(`EvaFs denied ${kind} ${path}: ${reason}`)
    this.name = 'EvaFsDenied'
  }
}

export interface ReadStamp {
  text: string
  mtimeMs: number
  size: number
  /** sha256 hex of text */
  hash: string
}

export interface EvaFs {
  write(kind: WriteKind, relPath: string, data: string | Buffer): Promise<void>
  remove(kind: 'job-delete', relPath: string): Promise<void>
  readStamp(kind: WriteKind, relPath: string): Promise<ReadStamp | null>
  edit(
    kind: WriteKind,
    relPath: string,
    fn: (current: string) => string | null,
    opts?: { expected?: string; retryOnChange?: boolean },
  ): Promise<{ before: string; after: string; changed: boolean }>
  create(kind: 'job-md', relPath: string, data: string): Promise<void>
}

function coded(message: string, code: string): Error {
  return Object.assign(new Error(message), { code })
}

const sha = (text: string): string => createHash('sha256').update(text).digest('hex')

async function stampOf(abs: string): Promise<ReadStamp | null> {
  try {
    const [text, st] = await Promise.all([fs.promises.readFile(abs, 'utf8'), fs.promises.stat(abs)])
    return { text, mtimeMs: st.mtimeMs, size: st.size, hash: sha(text) }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

/** The only sanctioned writer for the Eva checkout. */
export function createEvaFs(opts: { root: string }): EvaFs {
  const { root } = opts
  const queue = createPathQueue()
  const accept = (kind: string, relPath: string): string => {
    const m = matchWrite(kind, root, relPath)
    if (!m.ok) throw new EvaFsDenied(kind, relPath, m.reason)
    return m.abs
  }
  return {
    async write(kind, relPath, data) {
      if (kind === 'job-delete') throw new EvaFsDenied(kind, relPath, 'use remove() for job-delete')
      const abs = accept(kind, relPath)
      await queue.run(abs, () => withEvaFsWrite(() => atomicWrite(abs, data)))
    },
    async remove(kind, relPath) {
      if (kind !== 'job-delete')
        throw new EvaFsDenied(String(kind), relPath, 'remove() is job-delete only')
      const abs = accept(kind, relPath)
      await queue.run(abs, () =>
        withEvaFsWrite(() => fs.promises.rm(abs, { recursive: true, force: true })),
      )
    },
    async readStamp(kind, relPath) {
      const abs = accept(kind, relPath)
      return stampOf(abs)
    },
    async edit(kind, relPath, fn, o = {}) {
      if (kind === 'job-delete')
        throw new EvaFsDenied(kind, relPath, 'edit() cannot target job-delete')
      const abs = accept(kind, relPath)
      return queue.run(abs, async () => {
        for (let attempt = 0; ; attempt++) {
          const stamp = await stampOf(abs)
          if (!stamp) throw coded(`${relPath} not found`, 'not-found')
          if (o.expected !== undefined && stamp.text !== o.expected) {
            throw coded(`${relPath} changed on disk since it was opened`, 'changed-on-disk')
          }
          const next = fn(stamp.text)
          if (next === null || next === stamp.text) {
            return { before: stamp.text, after: stamp.text, changed: false }
          }
          // Residual race: an external writer between this re-check and the rename cannot be
          // excluded, because an atomic rename is not lock-free against other processes.
          const again = await stampOf(abs)
          if (
            !again ||
            again.mtimeMs !== stamp.mtimeMs ||
            again.size !== stamp.size ||
            again.hash !== stamp.hash
          ) {
            if (o.retryOnChange && attempt === 0 && again) {
              // retry once from the fresh text; expected no longer applies
              o = { ...o, expected: undefined }
              continue
            }
            throw coded(`${relPath} changed on disk since it was opened`, 'changed-on-disk')
          }
          await withEvaFsWrite(() => atomicWrite(abs, next))
          return { before: stamp.text, after: next, changed: true }
        }
      })
    },
    async create(kind, relPath, data) {
      if (kind !== 'job-md') throw new EvaFsDenied(String(kind), relPath, 'create() is job-md only')
      const abs = accept(kind, relPath)
      const dir = path.dirname(abs)
      await queue.run(abs, async () => {
        if (fs.existsSync(dir)) {
          throw coded(`jobs/${path.basename(dir)} already exists.`, 'already-exists')
        }
        await withEvaFsWrite(async () => {
          await fs.promises.mkdir(path.dirname(dir), { recursive: true })
          await fs.promises.mkdir(dir)
          try {
            await atomicWrite(abs, data)
          } catch (err) {
            // Do not strand an empty folder that every retry would report as already-exists.
            await fs.promises.rmdir(dir).catch(() => {})
            throw err
          }
        })
      })
    },
  }
}
