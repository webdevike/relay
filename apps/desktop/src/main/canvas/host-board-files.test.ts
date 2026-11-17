import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CANVAS_FILES_FEATURE } from '@relay/protocol'
import { createConfigStore } from '../config-store'
import type { RelayFeatures, RelayFrames } from '../relay/client'
import { parseBoard } from './board-text'
import { createHostBoardFiles, followHostBoards } from './host-board-files'
import { createImageReader } from './images'
import { storeBoardImage } from './paste'
import { createCanvasStore } from './store'

const repo = path.resolve(__dirname, '../../../../..')
const fixtures = path.join(repo, 'fixtures/canvases')
const png = fs.readFileSync(path.join(fixtures, 'moodboard-calm.png'))
const roots: string[] = []
afterEach(() => {
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true })
})

/** A Relay Host serving boards from memory, as apps/linux canvas/files.ts answers them. */
class FakeHost implements RelayFrames, RelayFeatures {
  connected = true
  features = [CANVAS_FILES_FEATURE]
  /** Answers nothing (an old host that dropped the frame). */
  silent = false
  boards = new Map<string, { text: string; modifiedMs: number }>()
  assets = new Map<string, Buffer>()
  history = new Map<string, string>()
  sent: Array<Record<string, unknown>> = []
  private listeners = new Set<(frame: Record<string, unknown>) => void>()
  private clock = 1000

  onFrame(cb: (frame: Record<string, unknown>) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }
  hostHas(feature: string): boolean {
    return this.connected && this.features.includes(feature)
  }
  sendFrame(frame: Record<string, unknown>): boolean {
    if (!this.connected) return false
    this.sent.push(frame)
    if (frame.t === 'canvas.file.req' && !this.silent) {
      const res = this.answer(frame)
      queueMicrotask(() => this.push({ t: 'canvas.file.res', rid: frame.rid, ...res }))
    }
    return true
  }
  push(frame: Record<string, unknown>): void {
    for (const cb of [...this.listeners]) cb(frame)
  }
  private answer(f: Record<string, unknown>): Record<string, unknown> {
    const slug = f.slug as string
    const src = f.src as string
    switch (f.op) {
      case 'list':
        return {
          ok: true,
          files: [...this.boards].map(([s, b]) => ({ slug: s, ...b })),
        }
      case 'read':
        return { ok: true, text: this.boards.get(slug)?.text ?? null }
      case 'exists':
        return { ok: true, exists: this.boards.has(slug) }
      case 'write':
        this.boards.set(slug, { text: f.text as string, modifiedMs: (this.clock += 1000) })
        return { ok: true }
      case 'remove':
        this.boards.delete(slug)
        return { ok: true }
      case 'history':
        this.history.set(slug, (this.history.get(slug) ?? '') + (f.text as string))
        return { ok: true }
      case 'asset.read': {
        const bytes = this.assets.get(src)
        return bytes
          ? { ok: true, data: bytes.toString('base64') }
          : { ok: false, code: 'not-found', error: 'No such file.' }
      }
      case 'asset.write':
        this.assets.set(src, Buffer.from(f.data as string, 'base64'))
        return { ok: true }
      default:
        return { ok: false, code: 'invalid', error: 'Unknown op.' }
    }
  }
}

function setup() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'evaos-canvas-host-')))
  roots.push(root)
  const fake = new FakeHost()
  for (const [slug, ms] of [
    ['moodboard', 1000],
    ['mind-map', 3000],
    ['user-flow', 2000],
  ] as const) {
    const text = fs.readFileSync(path.join(fixtures, `${slug}.json`), 'utf8')
    fake.boards.set(slug, { text, modifiedMs: ms })
  }
  const host = createHostBoardFiles(fake, { origin: 'relay-desktop-test', timeoutMs: 200 })
  const config = createConfigStore(path.join(root, 'config'))
  const store = createCanvasStore({ files: host, config })
  return { root, fake, host, store }
}

describe('host board files', () => {
  it('lists and loads the host boards, pins kept on this Mac', async () => {
    const { store, fake, root } = setup()
    store.pin('user-flow', true)
    const entries = await store.list()
    expect(entries.map((e) => [e.slug, e.title, e.nodes, e.pinned])).toEqual([
      ['mind-map', 'Q4 roadmap', 7, false],
      ['user-flow', 'Sign-in flow', 5, true],
      ['moodboard', 'Calm ops moodboard', 12, false],
    ])
    const { text } = await store.load('user-flow')
    expect(text).toBe(fake.boards.get('user-flow')!.text)
    await expect(store.load('nope')).rejects.toMatchObject({ code: 'not-found' })
    expect(fs.existsSync(path.join(root, 'config/canvas.json'))).toBe(true)
  })

  it('saves, updates, pages, threads, creates, renames and removes on the host', async () => {
    const { store, fake } = setup()
    const { board } = await store.load('mind-map')
    expect(await store.save('mind-map', board)).toEqual({ saved: false })
    const moved = { ...board, nodes: board.nodes.map((n) => ({ ...n, x: 10, y: 20.25 })) }
    expect(await store.save('mind-map', moved)).toEqual({ saved: true })
    expect(fake.boards.get('mind-map')!.text).toContain('"x": 10.0,\n      "y": 20.25,')
    const writes = fake.sent.filter((f) => f.op === 'write')
    expect(writes.every((f) => f.origin === 'relay-desktop-test')).toBe(true)

    const before = fake.boards.get('mind-map')!.text
    await expect(
      store.update(
        'mind-map',
        undefined,
        (b) => ({ board: { ...b, nodes: b.nodes.slice(1) }, value: 1 }),
        (() => {
          let calls = 0
          return () => {
            calls += 1
            if (calls === 2) throw Object.assign(new Error('taken over'), { code: 'paused' })
          }
        })(),
      ),
    ).rejects.toMatchObject({ code: 'paused' })
    expect(fake.boards.get('mind-map')!.text).toBe(before)
    const done = await store.update('mind-map', undefined, (b) => ({
      board: { ...b, nodes: b.nodes.slice(1) },
      value: 'ok',
    }))
    expect(done).toMatchObject({ value: 'ok', saved: true })
    expect(parseBoard(fake.boards.get('mind-map')!.text).nodes).toHaveLength(6)

    const added = await store.pages('mind-map', { op: 'add', title: 'Second', id: 'page-2' })
    expect(added.page).toBe('page-2')
    expect(parseBoard(fake.boards.get('mind-map')!.text).pages?.map((p) => p.id)).toEqual([
      'page-1',
      'page-2',
    ])

    const opened = await store.threads('user-flow', 'page-1', {
      op: 'open',
      text: 'Look here',
      x: 1,
      y: 2,
    })
    expect(opened.opened).toBeDefined()
    expect(parseBoard(fake.boards.get('user-flow')!.text).threads).toHaveLength(1)
    await store.threads('user-flow', 'page-1', { op: 'move', thread: opened.opened!, x: 5, y: 6 })
    expect(fake.history.get('user-flow')).toContain('"op":"move"')

    expect(await store.create()).toEqual({ slug: 'untitled-1' })
    expect(await store.create()).toEqual({ slug: 'untitled-2' })
    expect(parseBoard(fake.boards.get('untitled-1')!.text).title).toBe('Untitled board')
    await store.rename('untitled-1', 'Plans')
    expect(parseBoard(fake.boards.get('untitled-1')!.text).title).toBe('Plans')
    expect(await store.remove('untitled-1')).toEqual({ deleted: true })
    expect(fake.boards.has('untitled-1')).toBe(false)
    expect(fake.sent.find((f) => f.op === 'remove')?.origin).toBe('relay-desktop-test')
  })

  it('says why it cannot reach the boards: offline, an old host, no answer', async () => {
    const { store, fake } = setup()
    fake.connected = false
    await expect(store.list()).rejects.toMatchObject({ code: 'relay-unavailable' })
    fake.connected = true
    fake.features = []
    await expect(store.list()).rejects.toMatchObject({
      code: 'host-outdated',
      message: expect.stringContaining('Update it'),
    })
    fake.features = [CANVAS_FILES_FEATURE]
    fake.silent = true
    await expect(store.load('mind-map')).rejects.toMatchObject({ code: 'timeout' })
  })

  it('reads relative card images through the host and keeps absolute paths local', async () => {
    const { host, fake, root } = setup()
    fake.assets.set('assets/plan/shot.png', png)
    const local = path.join(root, 'local.png')
    fs.writeFileSync(local, png)
    const reader = createImageReader({
      dir: path.join(root, 'nope'),
      cacheDir: path.join(root, 'cache'),
      download: async () => png,
      readAsset: host.readAsset,
    })
    const img = await reader.read('assets/plan/shot.png')
    expect(img.dataUrl.startsWith('data:image/png;base64,')).toBe(true)
    expect(img.width).toBe(png.readUInt32BE(16))
    expect((await reader.read(local)).dataUrl).toBe(img.dataUrl)
    await expect(reader.read('assets/plan/gone.png')).rejects.toMatchObject({
      code: 'not-found',
      message: 'No image at assets/plan/gone.png.',
    })
    expect(fake.sent.filter((f) => f.op === 'asset.read')).toHaveLength(2)
  })

  it('stores a pasted image on the host under its sha name', async () => {
    const { host, fake } = setup()
    const out = await storeBoardImage({
      writeAsset: host.writeAsset,
      slug: 'plan',
      bytes: png,
      rescale: () => {
        throw new Error('no rescale')
      },
    })
    expect(out.src).toMatch(/^assets\/plan\/[0-9a-f]{16}\.png$/)
    expect(fake.assets.get(out.src)?.equals(png)).toBe(true)
    expect(fake.sent.find((f) => f.op === 'asset.write')?.origin).toBe('relay-desktop-test')
  })

  it('follows the host: watches on every connect, drops its own changes', () => {
    const fake = new FakeHost()
    const changed: Array<string | null> = []
    let connects = 0
    const off = followHostBoards(fake, 'relay-desktop-me', {
      changed: (slug) => changed.push(slug),
      connected: () => (connects += 1),
    })
    expect(fake.sent).toEqual([{ t: 'canvas.files.watch' }])
    expect(connects).toBe(1)
    fake.push({ t: 'canvas.files.changed', slug: 'mind-map', origin: 'relay-desktop-me' })
    fake.push({ t: 'canvas.files.changed', slug: 'mind-map', origin: 'relay-desktop-other' })
    fake.push({ t: 'canvas.files.changed', slug: null, origin: null })
    expect(changed).toEqual(['mind-map', null])
    fake.push({ t: 'welcome', features: [CANVAS_FILES_FEATURE] })
    expect(fake.sent).toHaveLength(2)
    expect(changed).toEqual(['mind-map', null, null])
    expect(connects).toBe(2)
    // An old host: the list reloads (and says why), no watch, no migration.
    fake.features = []
    fake.push({ t: 'welcome', features: [] })
    expect(fake.sent).toHaveLength(2)
    expect(connects).toBe(2)
    off()
    fake.push({ t: 'canvas.files.changed', slug: 'x', origin: null })
    expect(changed).toHaveLength(4)
  })
})
