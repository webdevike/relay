import * as fs from 'node:fs'
import * as path from 'node:path'
import { APP_DIR, proofDir } from './paths'

/** Where proof artifacts go: the committed proof tree only for EVAOS_PROOF=1 runs. */
export function proofOutDir(phase = 'phase-1'): string {
  return process.env.EVAOS_PROOF === '1'
    ? path.join(proofDir(phase.replace(/^phase-/, '')))
    : path.join(APP_DIR, 'test-results/proof', phase)
}

/** Merge-writes one section of metrics.json; repeated calls to a section shallow-merge keys. */
export function recordMetrics(section: string, data: Record<string, unknown>): void {
  const dir = proofOutDir('phase-1')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'metrics.json')
  let all: Record<string, Record<string, unknown>> = {}
  try {
    all = JSON.parse(fs.readFileSync(file, 'utf8')) as typeof all
  } catch {
    /* first write */
  }
  all[section] = { ...all[section], ...data }
  fs.writeFileSync(file, JSON.stringify(all, null, 2) + '\n')
}
