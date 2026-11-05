import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CanvasBoardSchema } from '@evaos/contract'
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

  it("keeps a live room's comment threads through a Canvas page edit and a rename", async () => {
    const { store, dir } = setup()
    const file = path.join(dir, 'user-flow.json')
    const threads = [
      {
        id: 't1',
        node: parseBoard(fs.readFileSync(file, 'utf8')).nodes[0]!.id,
        x: 12,
        y: 4,
        messages: [
          { id: 'm1', kind: 'human', name: 'Isaac', color: '#228be6', text: 'Tighter?', ts: 1 },
          { id: 'm2', kind: 'agent', name: 'Eva', color: '#7950f2', text: 'Done.', ts: 2 },
        ],
      },
      { id: 't2', x: 300, y: -40, resolved: true, messages: [] },
    ]
    const withThreads = { ...parseBoard(fs.readFileSync(file, 'utf8')), threads } as Parameters<
      typeof boardText
    >[0]
    fs.writeFileSync(file, boardText(withThreads))
    // The page gets the board over IPC, whose schema has no threads, and saves it back edited.
    const { board } = await store.load('user-flow')
    const page = CanvasBoardSchema.parse(board)
    expect(page).not.toHaveProperty('threads')
    const moved = { ...page, nodes: page.nodes.map((n, i) => (i === 0 ? { ...n, x: 999 } : n)) }
    expect(await store.save('user-flow', moved)).toEqual({ saved: true })
    const saved = parseBoard(fs.readFileSync(file, 'utf8'))
    expect(saved.nodes[0]!.x).toBe(999)
    expect(saved.threads).toEqual(threads)
    await store.rename('user-flow', 'Renamed')
    expect(parseBoard(fs.readFileSync(file, 'utf8')).threads).toEqual(threads)
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

  describe('pages', () => {
    const msg = (id: string) => ({
      id,
      kind: 'human',
      name: 'Isaac',
      color: '#228be6',
      text: id,
      ts: 1,
    })
    const thread = (id: string) => ({ id, x: 1, y: 2, messages: [msg(`${id}-m`)] })

    /** user-flow with a second page "page-2" and a comment thread on each page. */
    async function twoPages() {
      const s = setup()
      const file = path.join(s.dir, 'user-flow.json')
      await s.store.pages('user-flow', { op: 'add', id: 'page-2', title: 'Second' })
      const board = parseBoard(fs.readFileSync(file, 'utf8')) as unknown as Record<string, unknown>
      const pages = board.pages as Record<string, unknown>[]
      pages[1] = {
        ...pages[1],
        nodes: [{ id: 'a', type: 'note', x: 5, y: 6, data: { title: 'On two' } }],
        edges: [],
        threads: [thread('t2')],
      }
      fs.writeFileSync(
        file,
        boardText({ ...board, threads: [thread('t1')], pages } as unknown as Parameters<
          typeof boardText
        >[0]),
      )
      return { ...s, file, text: () => fs.readFileSync(file, 'utf8') }
    }

    it('keeps the other page and every thread when a page is saved', async () => {
      const { store, file, text } = await twoPages()
      const start = text()
      const one = await store.load('user-flow')
      const two = await store.load('user-flow', 'page-2')
      expect(one.page).toBe('page-1')
      expect(two.page).toBe('page-2')
      expect(one.pages).toEqual([
        { id: 'page-1', title: 'Page 1' },
        { id: 'page-2', title: 'Second' },
      ])
      expect(two.board.nodes.map((n) => n.id)).toEqual(['a'])
      // Unknown pages show the first.
      expect((await store.load('user-flow', 'nope')).page).toBe('page-1')
      // What the renderer sees (the schema strips threads and pages) saves back unchanged.
      const seen1 = CanvasBoardSchema.parse(one.board)
      const seen2 = CanvasBoardSchema.parse(two.board)
      expect(await store.save('user-flow', seen1)).toEqual({ saved: false })
      expect(await store.save('user-flow', seen2, 'page-2')).toEqual({ saved: false })
      expect(text()).toBe(start)

      const before = parseBoard(start)
      const moved1 = {
        ...seen1,
        nodes: seen1.nodes.map((n, i) => (i === 0 ? { ...n, x: 777 } : n)),
      }
      expect(await store.save('user-flow', moved1)).toEqual({ saved: true })
      const after1 = parseBoard(text())
      expect(after1.nodes[0]!.x).toBe(777)
      expect(after1.threads).toEqual(before.threads)
      expect(after1.pages).toEqual(before.pages)

      const moved2 = {
        ...seen2,
        nodes: seen2.nodes.map((n) => ({ ...n, x: 321 })),
        viewport: { x: 1, y: 2, zoom: 0.5 },
      }
      expect(await store.save('user-flow', moved2, 'page-2')).toEqual({ saved: true })
      const after2 = parseBoard(text())
      expect(after2.nodes).toEqual(after1.nodes)
      expect(after2.threads).toEqual(before.threads)
      expect(after2.pages![0]).toEqual(before.pages![0])
      expect(after2.pages![1]).toMatchObject({
        id: 'page-2',
        title: 'Second',
        nodes: [{ id: 'a', x: 321 }],
        viewport: { x: 1, y: 2, zoom: 0.5 },
        threads: [thread('t2')],
      })
      expect(text()).toBe(boardText(after2))
      await expect(store.save('user-flow', seen2, 'gone')).rejects.toMatchObject({
        code: 'not-found',
      })
      expect(fs.existsSync(file)).toBe(true)
    })

    it('adds, renames, moves, duplicates and deletes pages', async () => {
      const { store, dir } = setup()
      const file = path.join(dir, 'mind-map.json')
      const original = fs.readFileSync(file, 'utf8')
      const titles = async () =>
        parseBoard(fs.readFileSync(file, 'utf8')).pages?.map((p) => `${p.id}:${p.title}`)

      const added = await store.pages('mind-map', { op: 'add' })
      expect(added.pages.map((p) => p.title)).toEqual(['Page 1', 'Page 2'])
      expect(added.page).toBe(added.pages[1]!.id)
      const second = added.page
      expect(store.isOwn('mind-map', fs.readFileSync(file, 'utf8'))).toBe(true)

      const third = await store.pages('mind-map', { op: 'add', page: 'page-1', title: ' Notes ' })
      expect(third.pages.map((p) => p.title)).toEqual(['Page 1', 'Notes', 'Page 2'])

      const renamed = await store.pages('mind-map', { op: 'rename', page: second, title: 'Flow' })
      expect(renamed.pages.map((p) => p.title)).toEqual(['Page 1', 'Notes', 'Flow'])
      expect(renamed.page).toBe(second)

      const moved = await store.pages('mind-map', { op: 'move', page: second, to: 0 })
      expect(moved.pages.map((p) => p.id)).toEqual([second, 'page-1', third.page])

      const copy = await store.pages('mind-map', { op: 'duplicate', page: 'page-1' })
      expect(copy.pages.map((p) => p.title)).toEqual(['Flow', 'Page 1', 'Page 1 copy', 'Notes'])
      expect(copy.page).toBe(copy.pages[2]!.id)
      const dup = await store.load('mind-map', copy.page)
      const orig = await store.load('mind-map', 'page-1')
      expect(dup.board.nodes).toEqual(orig.board.nodes)

      const gone = await store.pages('mind-map', { op: 'delete', page: copy.page })
      expect(gone.pages.map((p) => p.title)).toEqual(['Flow', 'Page 1', 'Notes'])
      expect(gone.page).toBe(third.page)
      expect(await titles()).toHaveLength(3)

      // Page-1 may go; the rest stay, its content sits empty.
      const noFirst = await store.pages('mind-map', { op: 'delete', page: 'page-1' })
      expect(noFirst.pages.map((p) => p.id)).toEqual([second, third.page])
      expect((await store.load('mind-map')).page).toBe(second)

      await store.pages('mind-map', { op: 'delete', page: second })
      await expect(
        store.pages('mind-map', { op: 'delete', page: third.page }),
      ).rejects.toMatchObject({ code: 'invalid-input' })
      await expect(
        store.pages('mind-map', { op: 'rename', page: 'nope', title: 'x' }),
      ).rejects.toMatchObject({
        code: 'invalid-input',
      })
      await expect(store.pages('nope', { op: 'add' })).rejects.toMatchObject({ code: 'not-found' })
      expect(original).not.toBe(fs.readFileSync(file, 'utf8'))
    })

    it('keeps a single page board byte for byte through load, save and a page round trip', async () => {
      const { store, dir } = setup()
      for (const slug of ['mind-map', 'moodboard', 'user-flow']) {
        const file = path.join(dir, `${slug}.json`)
        const original = fs.readFileSync(file, 'utf8')
        const loaded = await store.load(slug)
        expect(loaded.pages).toEqual([{ id: 'page-1', title: 'Page 1' }])
        expect(await store.save(slug, CanvasBoardSchema.parse(loaded.board))).toEqual({
          saved: false,
        })
        expect(fs.readFileSync(file, 'utf8')).toBe(original)
        // Adding a page and deleting it again leaves the board as it was.
        const { page } = await store.pages(slug, { op: 'add' })
        await store.pages(slug, { op: 'delete', page })
        expect(fs.readFileSync(file, 'utf8')).toBe(original)
      }
    })
  })

  it('keeps node kinds and keys it does not know through a Canvas page edit and a page op', async () => {
    const { store, dir } = setup()
    const file = path.join(dir, 'user-flow.json')
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      nodes: Array<Record<string, unknown>>
      edges: Array<Record<string, unknown>>
      [k: string]: unknown
    }
    const first = raw.nodes[0]!
    first['locked'] = true
    first['data'] = { ...(first['data'] as object), html: '<b>live</b>' }
    raw.nodes.splice(1, 0, { id: 'live-copy', type: 'html', x: 5, y: 6, data: { src: 'a.html' } })
    raw.edges.push({
      id: 'to-live',
      source: String(first['id']),
      target: 'live-copy',
      curve: 'step',
    })
    raw['theme'] = 'warm'
    const original = boardText(parseBoard(JSON.stringify(raw)))
    fs.writeFileSync(file, original)

    // The page never sees the kind it cannot draw, nor the keys Relay does not know.
    const { board } = await store.load('user-flow')
    const page = CanvasBoardSchema.parse(board)
    expect(page.nodes.map((n) => n.id)).not.toContain('live-copy')
    expect(page.edges.map((e) => e.id)).not.toContain('to-live')
    expect(await store.save('user-flow', page)).toEqual({ saved: false })
    expect(fs.readFileSync(file, 'utf8')).toBe(original)

    const moved = { ...page, nodes: page.nodes.map((n, i) => (i === 0 ? { ...n, x: 999 } : n)) }
    expect(await store.save('user-flow', moved)).toEqual({ saved: true })
    expect(fs.readFileSync(file, 'utf8')).toBe(
      original.replace(/("id": "[^"]+",\n {6}"type": "[^"]+",\n {6}"x": )[^,]+/, '$1999.0'),
    )
    const { page: added } = await store.pages('user-flow', { op: 'add' })
    await store.pages('user-flow', { op: 'delete', page: added })
    const after = parseBoard(fs.readFileSync(file, 'utf8'))
    expect(after.nodes[1]).toEqual({
      id: 'live-copy',
      type: 'html',
      x: 5,
      y: 6,
      data: { src: 'a.html' },
    })
    expect(after.nodes[0]!.extra).toEqual({ locked: true })
    expect(after.nodes[0]!.data?.extra).toEqual({ html: '<b>live</b>' })
    expect(after.edges.find((e) => e.id === 'to-live')?.extra).toEqual({ curve: 'step' })
    expect(after.extra).toEqual({ theme: 'warm' })
  })

  describe('comment threads', () => {
    it('keeps the agent a thread is for, and moves a pin onto a card or a board spot, logging the move', async () => {
      const { store, dir } = setup()
      const file = path.join(dir, 'mind-map.json')
      const cards = parseBoard(fs.readFileSync(file, 'utf8')).nodes
      const card = cards[0]!.id
      const other = cards[1]!.id
      const opened = await store.threads('mind-map', undefined, {
        op: 'open',
        node: card,
        x: 10,
        y: 10,
        text: '@astra look at this',
        assignee: 'astra',
      })
      const id = opened.opened!
      expect(opened.threads[0]).toMatchObject({ assignee: 'astra' })
      // A reply without a new assignee keeps it; one that names another hands the thread over.
      const kept = await store.threads('mind-map', undefined, {
        op: 'post',
        thread: id,
        text: 'more',
      })
      expect(kept.threads[0]).toMatchObject({ assignee: 'astra' })
      const handed = await store.threads('mind-map', undefined, {
        op: 'post',
        thread: id,
        text: '@nova instead',
        assignee: 'nova',
      })
      expect(handed.threads[0]).toMatchObject({ assignee: 'nova' })
      expect(parseBoard(fs.readFileSync(file, 'utf8')).threads?.[0]?.assignee).toBe('nova')

      const onCard = await store.threads('mind-map', undefined, {
        op: 'move',
        thread: id,
        node: other,
        x: 7,
        y: 9,
      })
      expect(onCard.threads[0]).toMatchObject({ node: other, x: 7, y: 9, assignee: 'nova' })
      const onBoard = await store.threads('mind-map', undefined, {
        op: 'move',
        thread: id,
        x: 500,
        y: 600,
      })
      expect(onBoard.threads[0]!.node).toBeUndefined()
      expect(onBoard.threads[0]).toMatchObject({ x: 500, y: 600 })
      await expect(
        store.threads('mind-map', undefined, { op: 'move', thread: id, node: 'gone', x: 1, y: 1 }),
      ).rejects.toMatchObject({ code: 'invalid-input' })
      const log = fs
        .readFileSync(path.join(dir, 'mind-map.history.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as { op: string; kind: string; id: string; who: string })
      expect(log).toMatchObject([
        { op: 'move', kind: 'thread', id, who: 'Isaac' },
        { op: 'move', kind: 'thread', id, who: 'Isaac' },
      ])
    })

    it('opens a pin on a card, takes replies, resolves and reopens, writing only the file’s threads', async () => {
      const { store, dir } = setup()
      const file = path.join(dir, 'mind-map.json')
      const original = fs.readFileSync(file, 'utf8')
      expect((await store.threads('mind-map')).threads).toEqual([])
      const card = parseBoard(original).nodes[0]!.id

      const first = await store.threads('mind-map', undefined, {
        op: 'open',
        node: card,
        x: 40,
        y: 12,
        text: '  Is this still the plan?  ',
      })
      const id = first.opened!
      expect(first.threads).toMatchObject([
        {
          id,
          node: card,
          x: 40,
          y: 12,
          resolved: false,
          messages: [{ kind: 'human', name: 'Isaac', text: 'Is this still the plan?' }],
        },
      ])
      // Everything else in the file is as it was: only `threads` appears.
      const written = parseBoard(fs.readFileSync(file, 'utf8'))
      expect(boardText({ ...written, threads: undefined })).toBe(original)
      expect(fs.readFileSync(file, 'utf8')).toBe(boardText(written))
      expect(written.threads?.[0]).toMatchObject({ id, node: card, x: 40, y: 12 })

      await store.threads('mind-map', undefined, { op: 'post', thread: id, text: 'Yes' })
      const resolved = await store.threads('mind-map', undefined, {
        op: 'resolve',
        thread: id,
        resolved: true,
      })
      expect(resolved.threads[0]).toMatchObject({ resolved: true })
      expect(resolved.threads[0]!.messages.map((m) => m.text)).toEqual([
        'Is this still the plan?',
        'Yes',
      ])
      // A human writing in a resolved thread reopens it, as in a live room.
      const reopened = await store.threads('mind-map', undefined, {
        op: 'post',
        thread: id,
        text: 'One more thing',
      })
      expect(reopened.threads[0]!.resolved).toBe(false)
      expect(fs.readFileSync(file, 'utf8')).not.toContain('"resolved"')

      // The same board loads and saves as before: a Canvas page edit keeps the threads.
      const { board } = await store.load('mind-map')
      await store.save('mind-map', {
        ...board,
        nodes: board.nodes.map((n, i) => (i === 0 ? { ...n, x: 5 } : n)),
      })
      expect(parseBoard(fs.readFileSync(file, 'utf8')).threads).toHaveLength(1)
      expect(store.isOwn('mind-map', fs.readFileSync(file, 'utf8'))).toBe(true)
    })

    it('pins on a board spot, keeps a live room’s threads in order, and refuses what it cannot place', async () => {
      const { store, dir } = setup()
      const file = path.join(dir, 'user-flow.json')
      const base = parseBoard(fs.readFileSync(file, 'utf8'))
      const room = {
        id: 't-room',
        node: base.nodes[0]!.id,
        x: 1,
        y: 2,
        messages: [
          { id: 'm1', kind: 'agent' as const, name: 'Nova', color: '#f76707', text: 'Hi', ts: 5 },
        ],
      }
      fs.writeFileSync(file, boardText({ ...base, threads: [room] }))
      const spot = await store.threads('user-flow', undefined, {
        op: 'open',
        x: 300,
        y: 400,
        text: 'here',
      })
      expect(spot.threads.map((t) => t.id)).toEqual(['t-room', spot.opened])
      expect(spot.threads[1]!.node).toBeUndefined()
      expect(parseBoard(fs.readFileSync(file, 'utf8')).threads?.[0]).toEqual(room)

      await expect(
        store.threads('user-flow', undefined, { op: 'open', node: 'gone', x: 1, y: 1, text: 'x' }),
      ).rejects.toMatchObject({ code: 'invalid-input' })
      await expect(
        store.threads('user-flow', undefined, { op: 'post', thread: 'nope', text: 'x' }),
      ).rejects.toMatchObject({ code: 'invalid-input' })
      await expect(
        store.threads('user-flow', undefined, { op: 'open', x: 1, y: 1, text: '   ' }),
      ).rejects.toMatchObject({ code: 'invalid-input' })
      await expect(store.threads('user-flow', 'nope')).rejects.toMatchObject({
        code: 'invalid-input',
      })
      await expect(store.threads('missing')).rejects.toMatchObject({ code: 'not-found' })
    })

    it('keeps each page’s threads on that page', async () => {
      const { store, dir } = setup()
      const { page } = await store.pages('mind-map', { op: 'add', id: 'second', title: 'Second' })
      expect(page).toBe('second')
      await store.threads('mind-map', 'second', { op: 'open', x: 9, y: 9, text: 'on page two' })
      const file = parseBoard(fs.readFileSync(path.join(dir, 'mind-map.json'), 'utf8'))
      expect(file.threads).toBeUndefined()
      expect(file.pages?.find((p) => p.id === 'second')?.threads).toHaveLength(1)
      expect((await store.threads('mind-map')).threads).toEqual([])
      expect((await store.threads('mind-map', 'second')).threads).toHaveLength(1)
    })
  })
})
