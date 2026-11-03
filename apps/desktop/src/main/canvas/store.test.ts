import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createConfigStore } from '../config-store'
import { boardText, parseBoard } from './board-text'
import { createCanvasStore } from './store'

const repo = path.resolve(__dirname, '../../../../..')
const roots: string[] = []
afterEach(() => {
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true })
})

function setup(nativePins: string | null = null) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'evaos-canvas-')))
  roots.push(root)
  const dir = path.join(root, 'canvases')
  fs.cpSync(path.join(repo, 'fixtures/canvases'), dir, { recursive: true })
  const config = createConfigStore(path.join(root, 'config'))
  const touch = (slug: string, s: number): void =>
    fs.utimesSync(path.join(dir, `${slug}.json`), s, s)
  touch('moodboard', 1000)
  touch('mind-map', 3000)
  touch('user-flow', 2000)
  return { root, dir, config, store: createCanvasStore({ dir, config, nativePins }) }
}

describe('canvas store', () => {
  it('lists boards newest first with titles, node counts and pins', async () => {
    const { store, dir } = setup()
    fs.writeFileSync(path.join(dir, 'broken.json'), '{')
    fs.utimesSync(path.join(dir, 'broken.json'), 500, 500)
    fs.writeFileSync(path.join(dir, 'Not A Slug.json'), '{}')
    fs.writeFileSync(path.join(dir, '.mind-map.json.1.tmp'), '{}')
    store.pin('user-flow', true)
    const entries = await store.list()
    expect(entries.map((e) => [e.slug, e.title, e.nodes, e.pinned])).toEqual([
      ['mind-map', 'Q4 roadmap', 7, false],
      ['user-flow', 'Sign-in flow', 5, true],
      ['moodboard', 'Calm ops moodboard', 12, false],
      ['broken', 'broken', 0, false],
    ])
    expect(entries[0]!.modifiedMs).toBe(3_000_000)
  })

  it('lists nothing when the folder is missing', async () => {
    const { root, config } = setup()
    const store = createCanvasStore({ dir: path.join(root, 'nope'), config })
    expect(await store.list()).toEqual([])
  })

  it('loads a board with its text and reports missing or bad files', async () => {
    const { store, dir } = setup()
    const { board, text } = await store.load('user-flow')
    expect(text).toBe(fs.readFileSync(path.join(dir, 'user-flow.json'), 'utf8'))
    expect(board.layout).toBe('flow')
    await expect(store.load('nope')).rejects.toMatchObject({ code: 'not-found' })
    fs.writeFileSync(path.join(dir, 'v2.json'), '{"version": 2}')
    await expect(store.load('v2')).rejects.toMatchObject({ code: 'invalid-data' })
    await expect(store.load('../x')).rejects.toMatchObject({ code: 'invalid-input' })
  })

  it('saves only when the text changes', async () => {
    const { store, dir } = setup()
    const { board, text } = await store.load('mind-map')
    expect(await store.save('mind-map', board)).toEqual({ saved: false })
    const moved = { ...board, nodes: board.nodes.map((n) => ({ ...n, x: 10, y: 20.25 })) }
    expect(await store.save('mind-map', moved)).toEqual({ saved: true })
    const after = fs.readFileSync(path.join(dir, 'mind-map.json'), 'utf8')
    expect(after).not.toBe(text)
    expect(after).toBe(boardText(parseBoard(after)))
    expect(after).toContain('"x": 10.0,\n      "y": 20.25,')
    expect(await store.save('mind-map', moved)).toEqual({ saved: false })
    expect(fs.readdirSync(dir).filter((f) => f.includes('tmp'))).toEqual([])
  })

  it('creates the first free untitled-N', async () => {
    const { store, dir } = setup()
    fs.writeFileSync(path.join(dir, 'untitled-1.json'), '{}')
    expect(await store.create()).toEqual({ slug: 'untitled-2' })
    expect(await store.create()).toEqual({ slug: 'untitled-3' })
    expect(fs.readFileSync(path.join(dir, 'untitled-2.json'), 'utf8')).toBe(
      '{\n  "version": 1,\n  "title": "Untitled board",\n  "nodes": [],\n  "edges": []\n}\n',
    )
  })

  it('renames by rewriting the title only', async () => {
    const { store, dir } = setup()
    const before = fs.readFileSync(path.join(dir, 'user-flow.json'), 'utf8')
    expect(await store.rename('user-flow', 'Login journey')).toEqual({ saved: true })
    const after = fs.readFileSync(path.join(dir, 'user-flow.json'), 'utf8')
    expect(after).toBe(before.replace('"title": "Sign-in flow"', '"title": "Login journey"'))
    await expect(store.rename('nope', 'x')).rejects.toMatchObject({ code: 'not-found' })
  })

  it('deletes a board and its pin', async () => {
    const { store, dir } = setup()
    store.pin('moodboard', true)
    expect(await store.remove('moodboard')).toEqual({ deleted: true })
    expect(fs.existsSync(path.join(dir, 'moodboard.json'))).toBe(false)
    expect(store.pins()).toEqual([])
    expect(await store.remove('moodboard')).toEqual({ deleted: true })
  })

  it('pins newest first and unpins', () => {
    const { store, config } = setup()
    expect(store.pin('moodboard', true)).toEqual({ pinned: ['moodboard'] })
    expect(store.pin('user-flow', true)).toEqual({ pinned: ['user-flow', 'moodboard'] })
    expect(store.pin('moodboard', true)).toEqual({ pinned: ['moodboard', 'user-flow'] })
    expect(store.pin('user-flow', false)).toEqual({ pinned: ['moodboard'] })
    expect(config.readJson('canvas.json', {})).toEqual({ pinned: ['moodboard'] })
  })

  it('seeds pins once from native EvaOS when Relay has none', () => {
    const { root, dir, config } = setup()
    const native = path.join(root, 'native-canvas.json')
    fs.writeFileSync(native, '{"pinned":["user-flow","../bad",3]}')
    const store = createCanvasStore({ dir, config, nativePins: native })
    expect(store.pins()).toEqual(['user-flow'])
    fs.writeFileSync(native, '{"pinned":["moodboard"]}')
    expect(store.pins()).toEqual(['user-flow'])
  })

  it('tells its own writes apart', async () => {
    const { store, dir } = setup()
    const { board } = await store.load('user-flow')
    await store.save('user-flow', { ...board, title: 'Own' })
    expect(
      store.isOwn('user-flow', fs.readFileSync(path.join(dir, 'user-flow.json'), 'utf8')),
    ).toBe(true)
    expect(store.isOwn('user-flow', '{}')).toBe(false)
    await store.remove('user-flow')
    expect(store.isOwn('user-flow', null)).toBe(true)
    expect(store.isOwn('user-flow', null)).toBe(false)
  })
})
