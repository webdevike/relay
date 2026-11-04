import * as fs from 'node:fs'
import * as path from 'node:path'
import { APP_DIR, proofDir } from './paths'

/** Where proof artifacts go: the committed proof tree only for EVAOS_PROOF=1 runs. */
export function proofOutDir(phase = 'phase-1'): string {
  return process.env.EVAOS_PROOF === '1'
    ? path.join(proofDir(phase.replace(/^phase-/, '')))
    : path.join(APP_DIR, 'test-results/proof', phase)
}

/**
 * Merge-writes one section of metrics.json; repeated calls to a section shallow-merge keys.
 * Parallel workers share the file, so the read-merge-write runs under a mkdir lock (a stale lock,
 * left by a killed worker, is broken after 10 s) and the write is renamed into place.
 */
export function recordMetrics(section: string, data: Record<string, unknown>): void {
  const dir = proofOutDir('phase-1')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'metrics.json')
  const lock = `${file}.lock`
  const deadline = Date.now() + 10_000
  for (;;) {
    try {
      fs.mkdirSync(lock)
      break
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
      if (Date.now() > deadline) fs.rmSync(lock, { recursive: true, force: true })
      else Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)
    }
  }
  try {
    let all: Record<string, Record<string, unknown>> = {}
    try {
      all = JSON.parse(fs.readFileSync(file, 'utf8')) as typeof all
    } catch {
      /* first write */
    }
    all[section] = { ...all[section], ...data }
    const tmp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(all, null, 2) + '\n')
    fs.renameSync(tmp, file)
  } finally {
    fs.rmSync(lock, { recursive: true, force: true })
  }
}
