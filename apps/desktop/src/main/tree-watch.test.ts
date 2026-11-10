import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { watchTrees, type TreeWatch } from './tree-watch'

let dir: string
let watch: TreeWatch | null = null

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'evaos-tree-watch-')))
})
afterEach(() => {
  watch?.close()
  watch = null
  fs.rmSync(dir, { recursive: true, force: true })
})

// Real FSEvents arrive on the platform clock (fake timers cannot drive them); these waits let
// them settle or show that nothing comes.
function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>()
  setTimeout(resolve, ms)
  return promise
}
const until = async (fn: () => boolean, ms: number): Promise<void> => {
  const end = Date.now() + ms
  while (!fn() && Date.now() < end) await sleep(10)
}
const settle = (ms = 300): Promise<void> => sleep(ms)
const openFds = (): number => fs.readdirSync('/dev/fd').length

describe('watchTrees', () => {
  it('holds no descriptor per file however many files the tree has', async () => {
    // A descriptor per file is what ran the main process past macOS Chromium's limit for
    // starting sandboxed helpers (the audio service), so every video with sound failed.
    for (let s = 0; s < 20; s++) {
      fs.mkdirSync(path.join(dir, `s${s}`))
      for (let f = 0; f < 50; f++) fs.writeFileSync(path.join(dir, `s${s}`, `${f}.jsonl`), '{}\n')
    }
    const before = openFds()
    watch = watchTrees([dir], () => {}, { depth: 1, label: 'test' })
    await settle()
    expect(openFds() - before).toBeLessThan(20)
  })

  it('reports changes down to its depth and drops deeper ones and ignored paths', async () => {
    fs.mkdirSync(path.join(dir, 'a/b'), { recursive: true })
    const seen: string[] = []
    watch = watchTrees([dir], (p) => seen.push(p), {
      depth: 1,
      ignored: (p) => p.endsWith('.tmp'),
      label: 'test',
    })
    await settle()
    fs.writeFileSync(path.join(dir, 'a/b/deep.jsonl'), '{}\n')
    fs.writeFileSync(path.join(dir, 'a/.x.tmp'), '')
    fs.writeFileSync(path.join(dir, 'a/one.jsonl'), '{}\n')
    await until(() => seen.includes(path.join(dir, 'a/one.jsonl')), 1500)
    await settle()
    expect(seen).toContain(path.join(dir, 'a/one.jsonl'))
    expect(seen).not.toContain(path.join(dir, 'a/b/deep.jsonl'))
    expect(seen).not.toContain(path.join(dir, 'a/.x.tmp'))
  })

  it('picks up a root that appears after it started', async () => {
    const later = path.join(dir, 'later')
    const seen: string[] = []
    watch = watchTrees([later], (p) => seen.push(p), { depth: 0, retryMs: 50, label: 'test' })
    await settle(100)
    fs.mkdirSync(later)
    await until(() => seen.includes(later), 1500)
    await settle()
    fs.writeFileSync(path.join(later, 'x.jsonl'), '{}\n')
    await until(() => seen.includes(path.join(later, 'x.jsonl')), 1500)
    expect(seen).toContain(path.join(later, 'x.jsonl'))
  })

  it('reports a single file replaced by an atomic rename', async () => {
    const file = path.join(dir, 'todos.md')
    fs.writeFileSync(file, 'a')
    const seen: string[] = []
    watch = watchTrees([file], (p) => seen.push(p), { depth: 0, label: 'test' })
    await settle()
    fs.writeFileSync(path.join(dir, '.todos.md.1.tmp'), 'b')
    fs.renameSync(path.join(dir, '.todos.md.1.tmp'), file)
    await until(() => seen.length > 0, 1500)
    expect(seen).toEqual(expect.arrayContaining([file]))
    expect(seen.every((p) => p === file)).toBe(true)
  })
})
