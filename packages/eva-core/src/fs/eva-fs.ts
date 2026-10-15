import * as fs from 'node:fs'
import { matchWrite, type WriteKind } from './allowlist'
import { atomicWrite } from './atomic-write'
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

export interface EvaFs {
  write(kind: WriteKind, relPath: string, data: string | Buffer): Promise<void>
  remove(kind: 'job-delete', relPath: string): Promise<void>
}

/** The only sanctioned writer for the Eva checkout. No callers in Phase 1. */
export function createEvaFs(opts: { root: string }): EvaFs {
  const { root } = opts
  const accept = (kind: string, relPath: string): string => {
    const m = matchWrite(kind, root, relPath)
    if (!m.ok) throw new EvaFsDenied(kind, relPath, m.reason)
    return m.abs
  }
  return {
    async write(kind, relPath, data) {
      if (kind === 'job-delete') throw new EvaFsDenied(kind, relPath, 'use remove() for job-delete')
      const abs = accept(kind, relPath)
      await withEvaFsWrite(() => atomicWrite(abs, data))
    },
    async remove(kind, relPath) {
      if (kind !== 'job-delete')
        throw new EvaFsDenied(String(kind), relPath, 'remove() is job-delete only')
      const abs = accept(kind, relPath)
      await withEvaFsWrite(() => fs.promises.rm(abs, { recursive: true, force: true }))
    },
  }
}
