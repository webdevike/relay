import * as fs from 'node:fs'
import * as path from 'node:path'
import { createPathQueue } from '@evaos/eva-core'
import { atomicWrite } from '@evaos/eva-core/fs/atomic-write'
import { CANVAS_VERSION, type CanvasBoard, type CanvasEntry } from '@evaos/contract'
import type { ConfigStore } from '../config-store'
import { boardText, coded, parseBoard } from './board-text'

const SLUG = /^[a-z0-9-]{1,80}$/
const PINS = 'canvas.json'

/** `<slug>.json` in the boards folder; temp files and other names are not boards. */
export function slugOf(file: string): string | null {
  const m = /^([a-z0-9-]{1,80})\.json$/.exec(path.basename(file))
  return m ? m[1]! : null
}

function isMissing(e: unknown): boolean {
  return (e as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

function readPins(text: string | null): string[] | null {
  if (text === null) return null
  try {
    const pinned = (JSON.parse(text) as { pinned?: unknown } | null)?.pinned
    if (!Array.isArray(pinned)) return []
    return pinned.filter((p): p is string => typeof p === 'string' && SLUG.test(p))
  } catch {
    return []
  }
}

export interface CanvasStoreOptions {
  dir: string
  config: Pick<ConfigStore, 'readText' | 'writeJson'>
  /** Native EvaOS `canvas.json`, read once when Relay has no pins of its own (live only). */
  nativePins?: string | null
}

export interface CanvasStore {
  readonly dir: string
  /** Boards newest first, with the pinned flag. */
  list(): Promise<CanvasEntry[]>
  load(slug: string): Promise<{ board: CanvasBoard; text: string }>
  save(slug: string, board: CanvasBoard): Promise<{ saved: boolean }>
  create(): Promise<{ slug: string }>
  rename(slug: string, title: string): Promise<{ saved: true }>
  remove(slug: string): Promise<{ deleted: true }>
  pin(slug: string, pinned: boolean): { pinned: string[] }
  pins(): string[]
  /** Whether `text` (null: the file is gone) is what Relay itself last left on disk. */
  isOwn(slug: string, text: string | null): boolean
}

/**
 * Board files, mirroring native `board.rs` and the Canvas page: one `<slug>.json` per board,
 * written atomically, pins in Relay's own `canvas.json`. Remembers what it wrote so the watcher
 * can tell Relay's own writes from outside edits.
 */
export function createCanvasStore(opts: CanvasStoreOptions): CanvasStore {
  const { dir, config } = opts
  const queue = createPathQueue()
  /** The last text Relay wrote per board. */
  const written = new Map<string, string>()
  /** Boards Relay deleted whose removal the watcher has not seen yet. */
  const deleted = new Set<string>()

  const file = (slug: string): string => {
    if (!SLUG.test(slug)) throw coded(`Not a board name: ${slug}`, 'invalid-input')
    return path.join(dir, `${slug}.json`)
  }

  async function readText(slug: string): Promise<string | null> {
    try {
      return await fs.promises.readFile(file(slug), 'utf8')
    } catch (e) {
      if (isMissing(e)) return null
      throw e
    }
  }

  async function writeText(slug: string, text: string): Promise<void> {
    written.set(slug, text)
    deleted.delete(slug)
    await atomicWrite(file(slug), text)
  }

  function pins(): string[] {
    const own = readPins(config.readText(PINS))
    if (own !== null) return own
    let seeded: string[] = []
    if (opts.nativePins) {
      try {
        seeded = readPins(fs.readFileSync(opts.nativePins, 'utf8')) ?? []
      } catch {
        seeded = []
      }
    }
    config.writeJson(PINS, { pinned: seeded })
    return seeded
  }

  async function list(): Promise<CanvasEntry[]> {
    let names: string[]
    try {
      names = await fs.promises.readdir(dir)
    } catch (e) {
      if (isMissing(e)) return []
      throw e
    }
    const pinned = new Set(pins())
    const entries: CanvasEntry[] = []
    for (const name of names) {
      const slug = slugOf(name)
      if (!slug) continue
      let modifiedMs: number
      let text: string
      try {
        const abs = path.join(dir, name)
        modifiedMs = (await fs.promises.stat(abs)).mtimeMs
        text = await fs.promises.readFile(abs, 'utf8')
      } catch {
        continue
      }
      let board: CanvasBoard | null = null
      try {
        board = parseBoard(text)
      } catch {
        board = null
      }
      entries.push({
        slug,
        title: board && board.title !== '' ? board.title : slug,
        nodes: board?.nodes.length ?? 0,
        modifiedMs,
        pinned: pinned.has(slug),
      })
    }
    entries.sort((a, b) => b.modifiedMs - a.modifiedMs || (a.slug < b.slug ? -1 : 1))
    return entries
  }

  async function load(slug: string): Promise<{ board: CanvasBoard; text: string }> {
    const text = await readText(slug)
    if (text === null) throw coded(`No board ${slug}.`, 'not-found')
    return { board: parseBoard(text), text }
  }

  /** Native `save`: writes only when the text differs from the file on disk. */
  function save(slug: string, board: CanvasBoard): Promise<{ saved: boolean }> {
    return queue.run(slug, async () => {
      const text = boardText(board)
      if ((await readText(slug)) === text) {
        written.set(slug, text)
        return { saved: false }
      }
      await writeText(slug, text)
      return { saved: true }
    })
  }

  /** Native `new_board`: the first free `untitled-<n>`, titled "Untitled board". */
  function create(): Promise<{ slug: string }> {
    return queue.run('\0create', async () => {
      let n = 1
      while (fs.existsSync(file(`untitled-${n}`))) n++
      const slug = `untitled-${n}`
      const board: CanvasBoard = {
        version: CANVAS_VERSION,
        title: 'Untitled board',
        nodes: [],
        edges: [],
      }
      await writeText(slug, boardText(board))
      return { slug }
    })
  }

  /** Native `retitle` for a board that is not open: rewrites the title only. */
  function rename(slug: string, title: string): Promise<{ saved: true }> {
    return queue.run(slug, async () => {
      const { board } = await load(slug)
      await writeText(slug, boardText({ ...board, title }))
      return { saved: true as const }
    })
  }

  function remove(slug: string): Promise<{ deleted: true }> {
    return queue.run(slug, async () => {
      deleted.add(slug)
      written.delete(slug)
      try {
        await fs.promises.unlink(file(slug))
      } catch (e) {
        if (!isMissing(e)) {
          deleted.delete(slug)
          throw e
        }
      }
      const current = pins()
      if (current.includes(slug)) {
        config.writeJson(PINS, { pinned: current.filter((p) => p !== slug) })
      }
      return { deleted: true as const }
    })
  }

  /** Native `toggle_pin`: a new pin goes first. */
  function pin(slug: string, pinned: boolean): { pinned: string[] } {
    file(slug)
    const rest = pins().filter((p) => p !== slug)
    const next = pinned ? [slug, ...rest] : rest
    config.writeJson(PINS, { pinned: next })
    return { pinned: next }
  }

  return {
    dir,
    list,
    load,
    save,
    create,
    rename,
    remove,
    pin,
    pins,
    isOwn(slug: string, text: string | null): boolean {
      if (text === null) {
        const own = deleted.has(slug)
        deleted.delete(slug)
        return own
      }
      return written.get(slug) === text
    },
  }
}
