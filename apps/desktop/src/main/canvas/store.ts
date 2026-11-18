import * as fs from 'node:fs'
import { createPathQueue } from '@evaos/eva-core'
import { historyLine, type HistoryEntry } from '@relay/canvas-live/history'
import { excerpt } from '@relay/canvas-live/threads'
import { localBoardFiles, type BoardFiles } from './board-files'
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
import { mergeBoards } from '../../shared/canvas-merge'

const SLUG = /^[a-z0-9-]{1,80}$/
const PINS = 'canvas.json'
/** Who a comment written on the Canvas page is from (the host's `HUMAN_COLOR` face). */
const HUMAN = { name: 'Isaac', color: '#0ea5e9' } as const
/** How often a write starts over when other writers keep changing the board under it. */
const MAX_TRIES = 8

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

export type CanvasStoreOptions = {
  config: Pick<ConfigStore, 'readText' | 'writeJson'>
  /** Native EvaOS `canvas.json`, read once when Relay has no pins of its own (live only). */
  nativePins?: string | null
} & (
  | {
      /** The boards folder on this Mac. */
      dir: string
    }
  | {
      /** Where the boards are when not in a folder here (the Relay Host's, on a thin client). */
      files: BoardFiles
    }
)

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

/** Who an agent's comment is from, as its thread shows it. */
export interface ThreadAuthor {
  name: string
  color: string
}

export interface CanvasStore {
  /** Boards newest first, with the pinned flag. */
  list(): Promise<CanvasEntry[]>
  /** `page` is the page to show; a missing or unknown one shows the first. */
  load(slug: string, page?: string): Promise<CanvasLoad>
  /**
   * Writes the Canvas page's board to `page` (default page-1), keeping what the file has that the
   * page does not show (threads, the other pages). With `base` (the page as the board last read or
   * wrote it) the board is merged over what the file has now (mergeBoards: the agent's writes since
   * `base` stay); `merged` says the file now holds more than the board sent, so it reloads.
   */
  save(
    slug: string,
    board: CanvasBoard,
    page?: string,
    base?: CanvasBoard,
  ): Promise<{ saved: boolean; merged: boolean }>
  /**
   * Applies `edit` to `page` as the file has it now and writes the result, as one step no other
   * write of the board (a save, a page or thread change) can land inside. `edit` throws to write
   * nothing; returning the same board writes nothing. `guard` runs again at the commit (the file
   * staged, right before it replaces the board) and throws to write nothing.
   */
  update<T>(
    slug: string,
    page: string | undefined,
    edit: (board: CanvasBoard) => { board: CanvasBoard; value: T },
    guard?: () => void,
  ): Promise<{ value: T; page: string; saved: boolean }>
  /** Page operations; `page` of the result is the page to show next. */
  pages(slug: string, op: PageOp): Promise<{ pages: PageRef[]; page: string }>
  /**
   * A page's comment threads as the file has them, after `op` when given (open a pin, post in a
   * thread, resolve or reopen one). Written into the file's own `threads`, nothing else touched.
   * `agent` writes the message as that agent (canvas.reply), else as Isaac; `guard` runs in the
   * board's queue right before `op` applies and again at the commit, and throws to apply nothing.
   */
  threads(
    slug: string,
    page?: string,
    op?: CanvasThreadOp,
    agent?: ThreadAuthor,
    guard?: () => void,
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
 * written atomically (to the boards folder here, or the host's through `files`), pins in Relay's
 * own `canvas.json`. Every change is made from the file as read and lands only while the file is
 * still that (`change`), so a write from another process or Mac in between is never overwritten
 * by a stale copy. Remembers what it wrote so the watcher can tell Relay's own writes from
 * outside edits.
 */
export function createCanvasStore(opts: CanvasStoreOptions): CanvasStore {
  const { config } = opts
  const files = 'files' in opts ? opts.files : localBoardFiles(opts.dir)
  const queue = createPathQueue()
  /** The last text Relay wrote per board. */
  const written = new Map<string, string>()
  /** Boards Relay deleted whose removal the watcher has not seen yet. */
  const deleted = new Set<string>()

  const named = (slug: string): string => {
    if (!SLUG.test(slug)) throw coded(`Not a board name: ${slug}`, 'invalid-input')
    return slug
  }

  function readText(slug: string): Promise<string | null> {
    return files.read(named(slug))
  }

  /**
   * `guard` throws at the commit (the new text staged, before it lands) to write nothing. With
   * `base` (the text this write was made from; null: no board) it throws `conflict` when the board
   * is no longer that.
   */
  async function writeText(
    slug: string,
    text: string,
    guard?: () => void,
    base?: string | null,
  ): Promise<void> {
    await files.write(
      named(slug),
      text,
      () => {
        guard?.()
        written.set(slug, text)
        deleted.delete(slug)
      },
      base,
    )
  }

  /**
   * Reads the board, makes its next text from what the file has (`next`; text null writes
   * nothing) and writes it only while the file is still what was read. Another writer landing in
   * between (the host for another Mac, the Mini's own desktop) makes it start over from the new
   * file, so no write puts a copy made from an older file over another one's. `guard` runs again
   * at the commit. Runs inside the board's queue.
   */
  async function change<T>(
    slug: string,
    next: (disk: string | null) => { text: string | null; value: T },
    guard?: () => void,
  ): Promise<{ value: T; saved: boolean }> {
    for (let tries = 1; ; tries++) {
      const disk = await readText(slug)
      const { text, value } = next(disk)
      if (text === null) return { value, saved: false }
      if (text === disk) {
        written.set(slug, text)
        return { value, saved: false }
      }
      try {
        await writeText(slug, text, guard, disk)
        return { value, saved: true }
      } catch (e) {
        if ((e as { code?: unknown } | null)?.code !== 'conflict' || tries >= MAX_TRIES) throw e
      }
    }
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
    const found = await files.list()
    const pinned = new Set(pins())
    const entries: CanvasEntry[] = []
    for (const { slug, text, modifiedMs } of found) {
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
    base?: CanvasBoard,
  ): Promise<{ saved: boolean; merged: boolean }> {
    return queue.run(slug, async () => {
      const r = await change(slug, (disk) => {
        let file: Board | null = null
        try {
          file = disk === null ? null : parseBoard(disk)
        } catch {
          file = null
        }
        const shown = base && file ? pageView(file, page) : null
        const next =
          shown && base && shown.page === page ? mergeBoards(base, board, shown.board) : board
        const merged = next !== board && JSON.stringify(next) !== JSON.stringify(board)
        return { text: boardText(overFile(next, file, page)), value: merged }
      })
      return { saved: r.saved, merged: r.value }
    })
  }

  function update<T>(
    slug: string,
    page: string | undefined,
    edit: (board: CanvasBoard) => { board: CanvasBoard; value: T },
    guard?: () => void,
  ): Promise<{ value: T; page: string; saved: boolean }> {
    return queue.run(slug, async () => {
      const r = await change(
        slug,
        (disk) => {
          if (disk === null) throw coded(`No board ${slug}.`, 'not-found')
          const file = parseBoard(disk)
          const shown = pageView(file, page)
          // Reads fall back to the first page; a write meant for a page the file no longer has
          // lands nowhere rather than on another page.
          if (page !== undefined && shown.page !== page) {
            throw coded(`No page ${page} on board ${slug}.`, 'not-found')
          }
          guard?.()
          const { board, value } = edit(shown.board)
          const text = board === shown.board ? null : boardText(overFile(board, file, shown.page))
          return { text, value: { value, page: shown.page } }
        },
        guard,
      )
      return { ...r.value, saved: r.saved }
    })
  }

  /** Adds, renames, moves, duplicates or deletes a page, as one write of the whole board. */
  function pages(slug: string, op: PageOp): Promise<{ pages: PageRef[]; page: string }> {
    // One id for every try, so a retry after another writer makes the same page.
    const fresh = op.id ?? newPageId()
    return queue.run(slug, async () => {
      const r = await change(slug, (disk) => {
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
            if (!addPage(doc, fresh, cleanTitle(op.title ?? '', before.length + 1), op.page)) {
              throw refuse('This board cannot take another page.')
            }
            shown = fresh
            break
          }
          case 'duplicate': {
            if (!duplicatePage(doc, known(op.page), fresh, op.title ?? '')) {
              throw refuse('This board cannot take another page.')
            }
            shown = fresh
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
        return { text, value: { text, shown } }
      })
      const result = pageView(parseBoard(r.value.text), r.value.shown)
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
    agent?: ThreadAuthor,
    guard?: () => void,
  ): Promise<{ threads: CanvasThread[]; opened?: string }> {
    return queue.run(slug, async () => {
      // Set by the try that lands (a closure assignment, so typed past the null start).
      let entry = null as HistoryEntry | null
      const r = await change(
        slug,
        (disk) => {
          if (disk === null) throw coded(`No board ${slug}.`, 'not-found')
          const file = parseBoard(disk)
          const content = pageContent(file, page)
          let list = content.threads
          let opened: string | undefined
          entry = null
          if (!op) return { text: null, value: { list, opened } }
          guard?.()
          const refuse = (what: string): Error => coded(what, 'invalid-input')
          const now = Date.now()
          const message = (text: string): BoardThread['messages'][number] => ({
            id: `c-${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`,
            ...(agent
              ? { kind: 'agent' as const, ...agent }
              : { kind: 'human' as const, ...HUMAN }),
            text: text.trim().slice(0, MAX_THREAD_TEXT),
            ts: now,
          })
          const known = (id: string): BoardThread => {
            const t = list.find((x) => x.id === id)
            if (!t) throw refuse(`No thread ${id}.`)
            return t
          }
          const replace = (t: BoardThread): BoardThread[] =>
            list.map((x) => (x.id === t.id ? t : x))
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
            // A human writing in a resolved thread reopens it, as in a live room; an agent's reply does not.
            const { resolved, ...rest } = t
            const assignee = op.assignee ?? t.assignee
            list = replace({
              ...rest,
              ...(agent && resolved ? { resolved } : {}),
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
            entry = {
              ts: now,
              who: HUMAN.name,
              role: 'human',
              op: 'move',
              kind: 'thread',
              id: t.id,
              label: excerpt(t.messages[0]?.text ?? '', 50),
              page,
            }
          } else {
            const t = known(op.thread)
            const { resolved: _was, ...rest } = t
            list = replace(op.resolved ? { ...rest, resolved: true } : rest)
          }
          return { text: boardText(withThreads(file, page, list)), value: { list, opened } }
        },
        guard,
      )
      if (entry) await files.appendHistory(slug, historyLine(entry))
      const { list, opened } = r.value
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
      const board: Board = {
        version: CANVAS_VERSION,
        title: 'Untitled board',
        nodes: [],
        edges: [],
      }
      for (let n = 1, tries = 1; ; n++) {
        const slug = `untitled-${n}`
        if (await files.exists(slug)) continue
        try {
          // Only while there is still no such board: another Mac may make the same one meanwhile.
          await writeText(slug, boardText(board), undefined, null)
          return { slug }
        } catch (e) {
          if ((e as { code?: unknown } | null)?.code !== 'conflict' || tries++ >= MAX_TRIES) throw e
        }
      }
    })
  }

  /** Native `retitle` for a board that is not open: rewrites the title only. */
  function rename(slug: string, title: string): Promise<{ saved: true }> {
    return queue.run(slug, async () => {
      await change(slug, (text) => {
        if (text === null) throw coded(`No board ${slug}.`, 'not-found')
        // The whole file (every page, threads, keys Relay does not know), not the page view `load` gives.
        return { text: boardText({ ...parseBoard(text), title }), value: null }
      })
      return { saved: true as const }
    })
  }

  function remove(slug: string): Promise<{ deleted: true }> {
    return queue.run(slug, async () => {
      deleted.add(slug)
      written.delete(slug)
      try {
        await files.remove(named(slug))
      } catch (e) {
        deleted.delete(slug)
        throw e
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
    named(slug)
    const rest = pins().filter((p) => p !== slug)
    const next = pinned ? [slug, ...rest] : rest
    config.writeJson(PINS, { pinned: next })
    return { pinned: next }
  }

  return {
    list,
    load,
    save,
    update,
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
