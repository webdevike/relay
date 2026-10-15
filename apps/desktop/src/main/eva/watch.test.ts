import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { areaFor, startEvaWatchWith, watchTargets, type EvaArea } from './watch'

const R = '/eva'
const roots: string[] = []
afterEach(() => {
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true })
})

function tmpRoot(): string {
  const r = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'evaos-watch-')))
  roots.push(r)
  fs.mkdirSync(path.join(r, 'memory'), { recursive: true })
  fs.mkdirSync(path.join(r, 'jobs/x'), { recursive: true })
  fs.writeFileSync(path.join(r, 'memory/todos.md'), 'a\n')
  fs.writeFileSync(path.join(r, 'jobs/x/job.md'), 'a\n')
  return r
}

describe('watchTargets / areaFor', () => {
  it('lists exactly the seven narrow targets', () => {
    expect(watchTargets(R)).toEqual([
      '/eva/workspaces',
      '/eva/memory/journal.md',
      '/eva/memory/archive',
      '/eva/memory/todos.md',
      '/eva/memory/todos-done.md',
      '/eva/jobs',
      '/eva/work/meetings',
    ])
  })
  it('maps paths to areas', () => {
    expect(areaFor(R, '/eva/workspaces/a.md')).toBe('workspaces')
    expect(areaFor(R, '/eva/memory/archive/x.md')).toBe('memory')
    expect(areaFor(R, '/eva/jobs/.runs/r.json')).toBe('jobs')
    expect(areaFor(R, '/eva/work/meetings/m.json')).toBe('meetings')
    expect(areaFor(R, '/eva/work/items/i.md')).toBeNull()
    expect(areaFor(R, '/other/x')).toBeNull()
  })
})

describe('startEvaWatchWith', () => {
  it('debounces a burst into one emit and stops after close', async () => {
    const root = tmpRoot()
    const calls: EvaArea[][] = []
    const w = startEvaWatchWith(root, (a) => calls.push(a), { debounceMs: 700 })
    // FSEvents can replay the fixture writes made just before start; let that settle.
    await new Promise((r) => setTimeout(r, 1800))
    calls.length = 0
    fs.writeFileSync(path.join(root, 'memory/todos.md'), 'b\n')
    await new Promise((r) => setTimeout(r, 50))
    fs.writeFileSync(path.join(root, 'jobs/x/job.md'), 'b\n')
    await expect.poll(() => calls.length, { timeout: 4000 }).toBe(1)
    expect([...calls[0]!].sort()).toEqual(['jobs', 'memory'])
    await new Promise((r) => setTimeout(r, 900))
    expect(calls).toHaveLength(1)
    await w.close()
    fs.writeFileSync(path.join(root, 'memory/todos.md'), 'c\n')
    await new Promise((r) => setTimeout(r, 800))
    expect(calls).toHaveLength(1)
  })

  it('does not throw when a target is missing', async () => {
    const root = tmpRoot()
    const w = startEvaWatchWith(root, () => {})
    await w.close()
  })
})
