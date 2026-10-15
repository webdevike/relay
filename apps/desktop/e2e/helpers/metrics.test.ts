import * as fs from 'node:fs'
import * as path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { proofOutDir, recordMetrics } from './metrics'

const file = (): string => path.join(proofOutDir('phase-1'), 'metrics.json')

describe('recordMetrics', () => {
  beforeEach(() => {
    delete process.env.EVAOS_PROOF
    fs.rmSync(file(), { force: true })
  })
  it('keeps sections side by side and shallow-merges repeated sections', () => {
    recordMetrics('chat', { a: 1 })
    recordMetrics('browser', { b: 2 })
    recordMetrics('chat', { c: 3 })
    expect(JSON.parse(fs.readFileSync(file(), 'utf8'))).toEqual({
      chat: { a: 1, c: 3 },
      browser: { b: 2 },
    })
  })
})
