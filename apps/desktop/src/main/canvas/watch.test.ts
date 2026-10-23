import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createConfigStore } from '../config-store'
import { createCanvasStore } from './store'
import { startCanvasWatchWith, type CanvasWatch } from './watch'

const repo = path.resolve(__dirname, '../../../../..')
const roots: string[] = []
const watches: CanvasWatch[] = []
afterEach(async () => {
  for (const w of watches.splice(0)) await w.close()
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true })
})

// Real file-system events from chokidar arrive on the platform clock, so fake timers cannot drive
// them; the waits below only let FSEvents settle or prove that nothing arrives.
function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>()
  setTimeout(resolve, ms)
  return promise
}

async function setup() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'evaos-canvas-watch-')))
  roots.push(root)
  const dir = path.join(root, 'canvases')
  fs.cpSync(path.join(repo, 'fixtures/canvases'), dir, { recursive: true })
  const store = createCanvasStore({ dir, config: createConfigStore(path.join(root, 'config')) })
  const calls: Array<string | null> = []
  watches.push(startCanvasWatchWith(dir, store.isOwn, (s) => calls.push(s), { debounceMs: 150 }))
  // FSEvents can replay the fixture copy made just before start; let that settle.
  await sleep(1500)
  calls.length = 0
  return { dir, store, calls }
}

describe('startCanvasWatchWith', () => {
  it('reports outside edits but never Relay’s own writes', async () => {
    const { dir, store, calls } = await setup()
    const { board } = await store.load('mind-map')
    await store.save('mind-map', { ...board, title: 'Saved by Relay' })
    await store.rename('user-flow', 'Renamed by Relay')
    const { slug } = await store.create()
    await store.remove(slug)
    await sleep(1200)
    expect(calls).toEqual([])

    const file = path.join(dir, 'mind-map.json')
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('Saved by Relay', 'By Eva'))
    await expect.poll(() => calls, { timeout: 4000 }).toEqual(['mind-map'])
  })

  it('reports boards added or removed from outside as a list change', async () => {
    const { dir, calls } = await setup()
    // Native EvaOS and the canvas skill write a temp file and rename it over.
    fs.writeFileSync(path.join(dir, 'new-board.json.tmp-1'), '{"title":"New"}')
    fs.renameSync(path.join(dir, 'new-board.json.tmp-1'), path.join(dir, 'new-board.json'))
    await expect.poll(() => calls, { timeout: 4000 }).toEqual([null])
    calls.length = 0
    fs.rmSync(path.join(dir, 'moodboard.json'))
    await expect.poll(() => calls, { timeout: 4000 }).toEqual([null])
    calls.length = 0
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'x')
    await sleep(800)
    expect(calls).toEqual([])
  })
})
