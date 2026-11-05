import * as fs from 'node:fs'
import * as path from 'node:path'
import { createPathQueue } from '@evaos/eva-core'
import { historyLine, type HistoryEntry } from '@relay/canvas-live/history'
import { excerpt } from '@relay/canvas-live/threads'
import { atomicWrite } from '@evaos/eva-core/fs/atomic-write'
import {
  CANVAS_VERSION,
  type CanvasBoard,
  type CanvasEntry,
  type CanvasThread,
  type CanvasThreadOp,
} from '@evaos/contract'
import {
  duplicatePage,
  exportBoard,
  seedDoc,
  type Board,
  type BoardThread,
} from '@relay/canvas-live/board'
import {
  FIRST_PAGE,
  addPage,
  cleanTitle,
  deletePage,
  movePage,
  newPageId,
  pagesOf,
  renamePage,
} from '@relay/canvas-live/pages'
import { MAX_THREAD_TEXT, THREAD_ID, newThreadId } from '@relay/canvas-live/threads'
import * as Y from 'yjs'
import type { ConfigStore } from '../config-store'
import { boardText, coded, overFile, pageView, parseBoard, type PageRef } from './board-text'

const SLUG = /^[a-z0-9-]{1,80}$/
const PINS = 'canvas.json'
/** Who a comment written on the Canvas page is from (the host's `HUMAN_COLOR` face). */
const HUMAN = { name: 'Isaac', color: '#0ea5e9' } as const

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

/** What `load` hands over: the board as one page shows it, plus the page list. */
export interface CanvasLoad {
  board: CanvasBoard
  pages: PageRef[]
  /** The page `board` carries. */
  page: string
  text: string
}

/**
 * One page operation. `page` is the page it acts on (add: the page the new one goes after,
 * default last); `id` picks the new page's id for add and duplicate (default: a fresh one).
 */
export interface PageOp {
  op: 'add' | 'rename' | 'move' | 'duplicate' | 'delete'
  page?: string | undefined
  title?: string | undefined
  to?: number | undefined
  id?: string | undefined
}

export interface CanvasStore {
  readonly dir: string
  /** Boards newest first, with the pinned flag. */
  list(): Promise<CanvasEntry[]>
  /** `page` is the page to show; a missing or unknown one shows the first. */
  load(slug: string, page?: string): Promise<CanvasLoad>
  /**
   * Writes the Canvas page's board to `page` (default page-1), keeping what the file has that the
   * page does not show (threads, the other pages).
   */
  save(slug: string, board: CanvasBoard, page?: string): Promise<{ saved: boolean }>
  /** Page operations; `page` of the result is the page to show next. */
  pages(slug: string, op: PageOp): Promise<{ pages: PageRef[]; page: string }>
  /**
   * A page's comment threads as the file has them, after `op` when given (open a pin, post in a
   * thread, resolve or reopen one). Written into the file's own `threads`, nothing else touched.
   */
  threads(
    slug: string,
    page?: string,
    op?: CanvasThreadOp,
  ): Promise<{ threads: CanvasThread[]; opened?: string }>
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
      let board: Board | null = null
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

  async function load(slug: string, page?: string): Promise<CanvasLoad> {
    const text = await readText(slug)
    if (text === null) throw coded(`No board ${slug}.`, 'not-found')
    return { ...pageView(parseBoard(text), page), text }
  }

  /** Native `save`: writes only when the text differs from the file on disk. */
  function save(
    slug: string,
    board: CanvasBoard,
    page: string = FIRST_PAGE,
  ): Promise<{ saved: boolean }> {
    return queue.run(slug, async () => {
      const disk = await readText(slug)
      let file: Board | null = null
      try {
        file = disk === null ? null : parseBoard(disk)
      } catch {
        file = null
      }
      const text = boardText(overFile(board, file, page))
      if (disk === text) {
        written.set(slug, text)
        return { saved: false }
      }
      await writeText(slug, text)
      return { saved: true }
    })
  }

  /** Adds, renames, moves, duplicates or deletes a page, as one write of the whole board. */
  function pages(slug: string, op: PageOp): Promise<{ pages: PageRef[]; page: string }> {
    return queue.run(slug, async () => {
      const disk = await readText(slug)
      if (disk === null) throw coded(`No board ${slug}.`, 'not-found')
      const doc = new Y.Doc()
      seedDoc(doc, parseBoard(disk))
      const before = pagesOf(doc)
      const at = (id: string | undefined): number => before.findIndex((p) => p.id === id)
      const refuse = (what: string): Error => coded(what, 'invalid-input')
      const known = (id: string | undefined): string => {
        if (id === undefined || at(id) < 0) throw refuse(`No page ${id ?? ''}.`)
        return id
      }
      let shown: string
      switch (op.op) {
        case 'add': {
          const id = op.id ?? newPageId()
          if (!addPage(doc, id, cleanTitle(op.title ?? '', before.length + 1), op.page)) {
            throw refuse('This board cannot take another page.')
          }
          shown = id
          break
        }
        case 'duplicate': {
          const id = op.id ?? newPageId()
          if (!duplicatePage(doc, known(op.page), id, op.title ?? '')) {
            throw refuse('This board cannot take another page.')
          }
          shown = id
          break
        }
        case 'rename': {
          const id = known(op.page)
          if (!renamePage(doc, id, cleanTitle(op.title ?? '', at(id) + 1))) {
            throw refuse(`No page ${id}.`)
          }
          shown = id
          break
        }
        case 'move': {
          const id = known(op.page)
          if (op.to === undefined || !movePage(doc, id, op.to)) throw refuse(`No page ${id}.`)
          shown = id
          break
        }
        case 'delete': {
          const id = known(op.page)
          if (!deletePage(doc, id)) throw refuse('A board keeps at least one page.')
          const left = before.filter((p) => p.id !== id)
          shown = left[Math.min(at(id), left.length - 1)]!.id
          break
        }
      }
      const text = boardText(exportBoard(doc))
      if (text !== disk) await writeText(slug, text)
      else written.set(slug, text)
      const result = pageView(parseBoard(text), shown)
      return { pages: result.pages, page: result.page }
    })
  }

  /** The threads and nodes of `page` in `file`; throws `invalid-input` for a page it does not have. */
  function pageContent(
    file: Board,
    page: string,
  ): { nodes: ReadonlySet<string>; threads: BoardThread[] } {
    if (page === FIRST_PAGE) {
      return { nodes: new Set(file.nodes.map((n) => n.id)), threads: file.threads ?? [] }
    }
    const entry = file.pages?.find((p) => p.id === page)
    if (!entry) throw coded(`No page ${page}.`, 'invalid-input')
    return { nodes: new Set((entry.nodes ?? []).map((n) => n.id)), threads: entry.threads ?? [] }
  }

  /** `file` with `page`'s threads replaced. */
  function withThreads(file: Board, page: string, threads: BoardThread[]): Board {
    if (page === FIRST_PAGE) return { ...file, threads }
    return { ...file, pages: file.pages!.map((p) => (p.id === page ? { ...p, threads } : p)) }
  }

  function threads(
    slug: string,
    page: string = FIRST_PAGE,
    op?: CanvasThreadOp,
  ): Promise<{ threads: CanvasThread[]; opened?: string }> {
    return queue.run(slug, async () => {
      const disk = await readText(slug)
      if (disk === null) throw coded(`No board ${slug}.`, 'not-found')
      const file = parseBoard(disk)
      const content = pageContent(file, page)
      let list = content.threads
      let opened: string | undefined
      if (op) {
        const refuse = (what: string): Error => coded(what, 'invalid-input')
        const now = Date.now()
        const message = (text: string): BoardThread['messages'][number] => ({
          id: `c-${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`,
          kind: 'human',
          ...HUMAN,
          text: text.trim().slice(0, MAX_THREAD_TEXT),
          ts: now,
        })
        const known = (id: string): BoardThread => {
          const t = list.find((x) => x.id === id)
          if (!t) throw refuse(`No thread ${id}.`)
          return t
        }
        const replace = (t: BoardThread): BoardThread[] => list.map((x) => (x.id === t.id ? t : x))
        if (op.op === 'open') {
          if (op.text.trim() === '') throw refuse('A comment needs some text.')
          if (op.node !== undefined && !content.nodes.has(op.node)) {
            throw refuse(`No card ${op.node} on this page.`)
          }
          const id = newThreadId(now)
          if (!THREAD_ID.test(id) || list.some((t) => t.id === id)) throw refuse('Try again.')
          const pin: BoardThread = {
            id,
            ...(op.node === undefined ? {} : { node: op.node }),
            x: op.x,
            y: op.y,
            ...(op.assignee === undefined ? {} : { assignee: op.assignee }),
            messages: [message(op.text)],
          }
          list = [...list, pin]
          opened = id
        } else if (op.op === 'post') {
          const t = known(op.thread)
          if (op.text.trim() === '') throw refuse('A comment needs some text.')
          // A human writing in a resolved thread reopens it, as in a live room.
          const { resolved: _was, ...rest } = t
          const assignee = op.assignee ?? t.assignee
          list = replace({
            ...rest,
            ...(assignee === undefined ? {} : { assignee }),
            messages: [...t.messages, message(op.text)],
          })
        } else if (op.op === 'move') {
          const t = known(op.thread)
          if (op.node !== undefined && !content.nodes.has(op.node)) {
            throw refuse(`No card ${op.node} on this page.`)
          }
          const { node: _node, ...rest } = t
          list = replace({
            ...rest,
            ...(op.node === undefined ? {} : { node: op.node }),
            x: op.x,
            y: op.y,
          })
          // The board's change log, for an agent that comes back to it (the host keeps the rest when a room is live).
          const entry: HistoryEntry = {
            ts: now,
            who: HUMAN.name,
            role: 'human',
            op: 'move',
            kind: 'thread',
            id: t.id,
            label: excerpt(t.messages[0]?.text ?? '', 50),
            page,
          }
          await fs.promises.appendFile(path.join(dir, `${slug}.history.jsonl`), historyLine(entry))
        } else {
          const t = known(op.thread)
          const { resolved: _was, ...rest } = t
          list = replace(op.resolved ? { ...rest, resolved: true } : rest)
        }
        const text = boardText(withThreads(file, page, list))
        if (text !== disk) await writeText(slug, text)
        else written.set(slug, text)
      }
      return {
        threads: list.map((t) => ({
          id: t.id,
          ...(t.node === undefined ? {} : { node: t.node }),
          x: t.x,
          y: t.y,
          resolved: t.resolved === true,
          ...(t.assignee === undefined ? {} : { assignee: t.assignee }),
          messages: t.messages,
        })),
        ...(opened === undefined ? {} : { opened }),
      }
    })
  }

  /** Native `new_board`: the first free `untitled-<n>`, titled "Untitled board". */
  function create(): Promise<{ slug: string }> {
    return queue.run('\0create', async () => {
      let n = 1
      while (fs.existsSync(file(`untitled-${n}`))) n++
      const slug = `untitled-${n}`
      const board: Board = {
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
      const text = await readText(slug)
      if (text === null) throw coded(`No board ${slug}.`, 'not-found')
      // The whole file (every page, threads, keys Relay does not know), not the page view `load` gives.
      await writeText(slug, boardText({ ...parseBoard(text), title }))
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
    pages,
    threads,
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
