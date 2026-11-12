import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { CanvasBoardAnswer, CanvasBoardCall, CanvasRun } from '@evaos/contract'
import { createConfigStore } from '../config-store'
import type { DriveIdentity } from '../browser/agent-drive'
import { CanvasDrive } from './agent-canvas'
import { createCanvasStore } from './store'

const repo = path.resolve(__dirname, '../../../../..')
const roots: string[] = []
afterEach(() => {
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true })
})

const PENNY: DriveIdentity = {
  id: 'penny',
  name: 'Penny',
  color: '#86efac',
  avatar: null,
  workspace: 'chat:/s/a.jsonl',
}

/**
 * A drive over a copy of the fixture boards; `mounted` says whether a board shows on screen,
 * `onCall` runs inside each board call (to interrupt an action mid-way). A `chat:` scope is a
 * plain chat (Eva, its own workspace); no scope is Penny.
 */
function setup(mounted = true, onCall?: (call: CanvasBoardCall) => Promise<void> | void) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'evaos-canvas-drive-')))
  roots.push(root)
  const dir = path.join(root, 'canvases')
  fs.cpSync(path.join(repo, 'fixtures/canvases'), dir, { recursive: true })
  const store = createCanvasStore({ dir, config: createConfigStore(path.join(root, 'config')) })
  /** What happened, in order: board calls by op, and file writes. */
  const log: string[] = []
  const runs: CanvasRun[][] = []
  /** The boxes the board on screen answers, by card id. */
  const drawn: Record<string, { x: number; y: number; w: number; h: number }> = {}
  const drive = new CanvasDrive({
    store,
    board: async (call: CanvasBoardCall): Promise<CanvasBoardAnswer> => {
      const what =
        call.op === 'cursor'
          ? `cursor ${call.cursor.op}${call.cursor.node ? ` ${call.cursor.node}` : ''}`
          : call.op === 'reveal'
            ? `reveal ${(call.nodes ?? []).join(',')}`
            : call.op
      log.push(what)
      await onCall?.(call)
      if (!mounted) return { mounted: false, ms: 0 }
      return call.op === 'boxes' ? { mounted: true, boxes: drawn } : { mounted: true, ms: 10 }
    },
    changed: (slug) => log.push(`write ${slug}`),
    publish: (r) => runs.push(r),
    identify: async (scope) =>
      scope?.startsWith('chat:')
        ? { id: null, name: 'Eva', color: '#a5b4fc', avatar: null, workspace: scope }
        : PENNY,
    show: async (slug) => {
      log.push(`show ${slug}`)
    },
    sleep: async () => {},
  })
  return { drive, store, log, runs, drawn, dir }
}

describe('canvas drive', () => {
  it('brings each card into view before the cursor goes to it, then the link lands in the file', async () => {
    const { drive, store, log } = setup()
    const a = (await drive.add({ slug: 'mind-map', title: 'One', x: 0, y: 900 })) as { id: string }
    const b = (await drive.add({ slug: 'mind-map', title: 'Two', x: 400, y: 900 })) as {
      id: string
    }
    log.length = 0
    const r = await drive.connect({ slug: 'mind-map', from: a.id, to: b.id, label: 'next' })
    expect(r).toEqual({ id: `${a.id}-${b.id}`, existed: false })
    expect(log).toEqual([
      `reveal ${a.id}`,
      `cursor move ${a.id}`,
      `cursor click ${a.id}`,
      `reveal ${b.id}`,
      `cursor move ${b.id}`,
      `cursor click ${b.id}`,
      'flush',
      'write mind-map',
    ])
    const edges = (await store.load('mind-map')).board.edges
    expect(edges.find((e) => e.id === `${a.id}-${b.id}`)).toMatchObject({ label: 'next' })
    // The same link again is kept, not doubled, and nothing is written.
    log.length = 0
    expect(await drive.connect({ slug: 'mind-map', from: a.id, to: b.id })).toEqual({
      id: `${a.id}-${b.id}`,
      existed: true,
    })
    expect(log).not.toContain('write mind-map')
  })

  it('writes a new card where the cursor clicked, right of the card it is near', async () => {
    const { drive, store, drawn } = setup()
    const near = (await store.load('mind-map')).board.nodes[0]!
    drawn[near.id] = { x: 100, y: 50, w: 240, h: 120 }
    const r = (await drive.add({ slug: 'mind-map', title: 'Idea', near: near.id })) as {
      id: string
      x: number
      y: number
    }
    expect(r).toMatchObject({ x: 420, y: 50 })
    const added = (await store.load('mind-map')).board.nodes.find((n) => n.id === r.id)!
    expect(added).toMatchObject({ type: 'note', x: 420, y: 50, data: { title: 'Idea' } })
  })

  it('still changes a board that is not on screen, without waiting on a cursor', async () => {
    const { drive, store, log } = setup(false)
    const r = (await drive.add({ slug: 'user-flow', title: 'Offline' })) as { id: string }
    expect((await store.load('user-flow')).board.nodes.some((n) => n.id === r.id)).toBe(true)
    expect(log.filter((l) => l.startsWith('cursor click'))).toEqual([])
  })

  it('refuses to act while Isaac holds the board, and goes on after he hands back', async () => {
    const { drive, store, runs } = setup()
    await drive.caption('mind-map', 'Sorting ideas', undefined)
    expect(runs.at(-1)![0]).toMatchObject({
      slug: 'mind-map',
      status: 'working',
      caption: 'Sorting ideas',
      workspace: 'chat:/s/a.jsonl',
    })
    drive.op('mind-map', 'takeOver')
    expect(drive.list()[0]!.status).toBe('paused')
    const before = (await store.load('mind-map')).board.nodes.length
    await expect(drive.add({ slug: 'mind-map', title: 'Nope' })).rejects.toMatchObject({
      code: 'paused-by-isaac',
    })
    expect((await store.load('mind-map')).board.nodes.length).toBe(before)
    const waited = drive.wait('mind-map', 1000)
    drive.op('mind-map', 'handBack')
    expect(await waited).toEqual({ met: true, status: 'working' })
    await drive.add({ slug: 'mind-map', title: 'Now' })
    expect((await store.load('mind-map')).board.nodes.length).toBe(before + 1)
  })

  it('posts a reply as the agent under a comment thread', async () => {
    const { drive, store } = setup()
    const page = (await store.load('mind-map')).page
    const { opened } = await store.threads('mind-map', page, {
      op: 'open',
      x: 10,
      y: 10,
      text: 'Why?',
    })
    await drive.reply({ slug: 'mind-map', thread: opened!, text: 'Because.' })
    const t = (await store.threads('mind-map', page)).threads.find((x) => x.id === opened)!
    expect(t.messages.map((m) => [m.kind, m.name, m.text])).toEqual([
      ['human', 'Isaac', 'Why?'],
      ['agent', 'Penny', 'Because.'],
    ])
  })

  it('names the chat that drives a board, for the notes left on it', async () => {
    const { drive } = setup()
    expect(drive.workspaceOf('mind-map')).toBeNull()
    await drive.caption('mind-map', 'Looking', undefined)
    expect(drive.workspaceOf('mind-map')).toBe('chat:/s/a.jsonl')
  })

  it('lands both of two adds sent at once, each with its own id', async () => {
    const { drive, store } = setup()
    const before = (await store.load('mind-map')).board.nodes.length
    const [a, b] = (await Promise.all([
      drive.add({ slug: 'mind-map', title: 'A' }),
      drive.add({ slug: 'mind-map', title: 'B' }),
    ])) as Array<{ id: string }>
    expect(a!.id).not.toBe(b!.id)
    const titles = (await store.load('mind-map')).board.nodes.map((n) => n.data?.title)
    expect(titles.length).toBe(before + 2)
    expect(titles).toEqual(expect.arrayContaining(['A', 'B']))
  })

  it('lands nothing once Isaac takes over mid-action, even after he hands back', async () => {
    let interrupt: 'takeOver' | 'takeOverAndBack' | null = null
    // Isaac's hand on the board while the action saves its pending edits.
    const s = setup(true, (call) => {
      if (call.op !== 'flush' || !interrupt) return
      s.drive.op('mind-map', 'takeOver')
      if (interrupt === 'takeOverAndBack') s.drive.op('mind-map', 'handBack')
      interrupt = null
    })
    const drive = s.drive
    const before = (await s.store.load('mind-map')).board.nodes.length
    interrupt = 'takeOver'
    await expect(drive.add({ slug: 'mind-map', title: 'Late' })).rejects.toMatchObject({
      code: 'paused-by-isaac',
    })
    drive.op('mind-map', 'handBack')
    // Handed back while the old action still waited: that action is still not the agent's.
    interrupt = 'takeOverAndBack'
    await expect(drive.add({ slug: 'mind-map', title: 'Stale' })).rejects.toMatchObject({
      code: 'stopped',
    })
    expect((await s.store.load('mind-map')).board.nodes.length).toBe(before)
    // A fresh action after hand back lands.
    await drive.add({ slug: 'mind-map', title: 'Fresh' })
    expect((await s.store.load('mind-map')).board.nodes.length).toBe(before + 1)
  })

  it("refuses a second chat mid-run without touching the first chat's run or page", async () => {
    const { drive, store } = setup()
    const page2 = (await store.pages('mind-map', { op: 'add', title: 'Later' })).page
    await drive.caption('mind-map', 'Mine', 'chat:/s/one.jsonl')
    await expect(
      drive.add({ slug: 'mind-map', page: page2, title: 'Theirs', scope: 'chat:/s/two.jsonl' }),
    ).rejects.toMatchObject({ code: 'busy' })
    await expect(
      drive.done('mind-map', 'Took it', 'done', 'chat:/s/two.jsonl'),
    ).rejects.toMatchObject({
      code: 'busy',
    })
    expect(drive.workspaceOf('mind-map')).toBe('chat:/s/one.jsonl')
    const r = (await drive.add({
      slug: 'mind-map',
      title: 'Still mine',
      scope: 'chat:/s/one.jsonl',
    })) as {
      page: string
    }
    expect(r.page).not.toBe(page2)
  })

  it('keeps the run on its page when Isaac takes over while another page loads', async () => {
    const { drive, store } = setup()
    const page2 = (await store.pages('mind-map', { op: 'add', title: 'Later' })).page
    await drive.caption('mind-map', 'Working', undefined)
    const load = store.load
    store.load = async (slug, page) => {
      if (page === page2) drive.op('mind-map', 'takeOver')
      return load(slug, page)
    }
    await expect(
      drive.add({ slug: 'mind-map', page: page2, title: 'Refused' }),
    ).rejects.toMatchObject({ code: 'paused-by-isaac' })
    store.load = load
    drive.op('mind-map', 'handBack')
    const r = (await drive.add({ slug: 'mind-map', title: 'Here' })) as { page: string }
    expect(r.page).not.toBe(page2)
  })

  it('posts no reply and moves no view once Isaac takes over mid-action', async () => {
    let takeOverOn: string | null = null
    const s = setup(true, (call) => {
      if (call.op === takeOverOn) {
        s.drive.op('mind-map', 'takeOver')
        takeOverOn = null
      }
    })
    const { drive, store, log } = s
    const page = (await store.load('mind-map')).page
    const { opened } = await store.threads('mind-map', page, { op: 'open', x: 0, y: 0, text: '?' })
    takeOverOn = 'cursor'
    await expect(
      drive.reply({ slug: 'mind-map', thread: opened!, text: 'Late' }),
    ).rejects.toMatchObject({ code: 'paused-by-isaac' })
    const t = (await store.threads('mind-map', page)).threads.find((x) => x.id === opened)!
    expect(t.messages.map((m) => m.text)).toEqual(['?'])
    drive.op('mind-map', 'handBack')
    takeOverOn = 'boxes'
    log.length = 0
    const first = (await store.load('mind-map')).board.nodes[0]!.id
    await expect(drive.view({ slug: 'mind-map', node: first })).rejects.toMatchObject({
      code: 'paused-by-isaac',
    })
    expect(log).not.toContain('view')
  })

  it('writes nothing when the page it works on is gone from the file', async () => {
    const { store } = setup()
    await expect(
      store.update('mind-map', 'page-gone', (b) => ({ board: { ...b, nodes: [] }, value: null })),
    ).rejects.toMatchObject({ code: 'not-found' })
    expect((await store.load('mind-map')).board.nodes.length).toBeGreaterThan(0)
  })

  it('keeps the file when the run stops being the agent’s after the edit, before the commit', async () => {
    const { store, dir } = setup()
    const file = path.join(dir, 'mind-map.json')
    const before = fs.readFileSync(file, 'utf8')
    let tookOver = false
    await expect(
      store.update(
        'mind-map',
        undefined,
        (b) => {
          // Isaac takes over while the new text is staged.
          tookOver = true
          return { board: { ...b, nodes: [] }, value: null }
        },
        () => {
          if (tookOver) throw Object.assign(new Error('Paused'), { code: 'paused-by-isaac' })
        },
      ),
    ).rejects.toMatchObject({ code: 'paused-by-isaac' })
    expect(fs.readFileSync(file, 'utf8')).toBe(before)
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })

  it('lands a finished carry after its write; a carry Isaac takes over writes and lands nothing', async () => {
    let takeOverOn: string | null = null
    const s = setup(true, (call) => {
      if (call.op === takeOverOn) {
        s.drive.op('mind-map', 'takeOver')
        takeOverOn = null
      }
    })
    const { drive, store, log } = s
    const card = (await store.load('mind-map')).board.nodes[0]!
    log.length = 0
    expect(await drive.move({ slug: 'mind-map', node: card.id, x: 900, y: 700 })).toEqual({
      id: card.id,
      x: 900,
      y: 700,
    })
    expect(log.slice(-4)).toEqual(['drag', 'flush', 'write mind-map', 'landed'])
    takeOverOn = 'drag'
    log.length = 0
    await expect(drive.move({ slug: 'mind-map', node: card.id, x: 0, y: 0 })).rejects.toMatchObject(
      { code: 'paused-by-isaac' },
    )
    expect(log).not.toContain('write mind-map')
    expect(log).not.toContain('landed')
    expect((await store.load('mind-map')).board.nodes[0]).toMatchObject({ x: 900, y: 700 })
  })
})
