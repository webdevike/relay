import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ChatWatch, classify } from './chat-watch'

let dir: string
let watch: ChatWatch | null = null

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evaos-chat-watch-'))
})
afterEach(async () => {
  await watch?.close()
  watch = null
  fs.rmSync(dir, { recursive: true, force: true })
})

function collect(w: ChatWatch): { batches: string[][]; times: number[] } {
  const batches: string[][] = []
  const times: number[] = []
  w.onChange((f) => {
    batches.push(f)
    times.push(Date.now())
  })
  return { batches, times }
}
const until = async (fn: () => boolean, ms: number): Promise<void> => {
  const end = Date.now() + ms
  while (!fn() && Date.now() < end) await new Promise((r) => setTimeout(r, 10))
}
const ready = (): Promise<void> => new Promise((r) => setTimeout(r, 300))

describe('classify', () => {
  it('accepts top-level jsonl and subagent folders only', () => {
    expect(classify('/s', '/s/a.jsonl')).toBe('/s/a.jsonl')
    expect(classify('/s', '/s/a.txt')).toBeNull()
    expect(classify('/s', '/s/a/x.jsonl')).toBe('/s/a')
    expect(classify('/s', '/s/a/x.md')).toBe('/s/a')
    expect(classify('/s', '/s/a/x.png')).toBeNull()
    expect(classify('/s', '/s/a/b/x.jsonl')).toBeNull()
    expect(classify('/s', '/elsewhere/a.jsonl')).toBeNull()
  })
})

describe('ChatWatch', () => {
  it('watches every sessions dir it is given', async () => {
    const other = path.join(dir, 'other')
    fs.mkdirSync(other)
    watch = new ChatWatch({ dirs: [path.join(dir, 'missing'), other] })
    const got = collect(watch)
    watch.start()
    await ready()
    fs.writeFileSync(path.join(other, 'b.jsonl'), '{}\n')
    await until(() => got.batches.length > 0, 1500)
    expect(got.batches.flat()).toContain(path.join(other, 'b.jsonl'))
  })

  it('reports a new jsonl within the budget', async () => {
    watch = new ChatWatch({ dirs: [dir] })
    const got = collect(watch)
    watch.start()
    await ready()
    const t0 = Date.now()
    fs.writeFileSync(path.join(dir, 'a.jsonl'), '{}\n')
    await until(() => got.batches.length > 0, 1000)
    expect(got.batches.flat()).toContain(path.join(dir, 'a.jsonl'))
    expect(got.times[0]! - t0).toBeLessThan(500)
  })

  it('reports an append through a descriptor held open', async () => {
    const file = path.join(dir, 'held.jsonl')
    fs.writeFileSync(file, '{}\n')
    const old = new Date(Date.now() - 3 * 3600_000)
    fs.utimesSync(file, old, old)
    watch = new ChatWatch({ dirs: [dir] })
    const got = collect(watch)
    watch.start()
    await ready()
    const fd = fs.openSync(file, 'a')
    try {
      const t0 = Date.now()
      fs.writeSync(fd, '{"type":"title","title":"x"}\n')
      await until(() => got.batches.length > 0, 1000)
      expect(got.batches.flat()).toContain(file)
      expect(got.times[0]! - t0).toBeLessThan(500)
    } finally {
      fs.closeSync(fd)
    }
  })

  it('reports a deleted file', async () => {
    const file = path.join(dir, 'gone.jsonl')
    fs.writeFileSync(file, '{}\n')
    watch = new ChatWatch({ dirs: [dir] })
    const got = collect(watch)
    watch.start()
    await ready()
    fs.rmSync(file)
    await until(() => got.batches.length > 0, 1000)
    expect(got.batches.flat()).toContain(file)
  })

  it('ignores other files and folds a burst into one batch', async () => {
    watch = new ChatWatch({ dirs: [dir] })
    const got = collect(watch)
    watch.start()
    await ready()
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'x')
    for (let i = 0; i < 20; i++) fs.writeFileSync(path.join(dir, 'burst.jsonl'), `{"i":${i}}\n`)
    await until(() => got.batches.length > 0, 1000)
    await new Promise((r) => setTimeout(r, 250))
    expect(got.batches).toHaveLength(1)
    expect(got.batches[0]).toEqual([path.join(dir, 'burst.jsonl')])
  })

  it('reports a subagent folder change', async () => {
    fs.mkdirSync(path.join(dir, 'sess'))
    watch = new ChatWatch({ dirs: [dir] })
    const got = collect(watch)
    watch.start()
    await ready()
    fs.writeFileSync(path.join(dir, 'sess', 'a.md'), 'done')
    await until(() => got.batches.length > 0, 1000)
    expect(got.batches.flat()).toContain(path.join(dir, 'sess'))
  })

  it('stops everything on close', async () => {
    watch = new ChatWatch({ dirs: [dir] })
    const got = collect(watch)
    watch.start()
    await ready()
    await watch.close()
    fs.writeFileSync(path.join(dir, 'late.jsonl'), '{}\n')
    await new Promise((r) => setTimeout(r, 500))
    expect(got.batches).toHaveLength(0)
  })
})
