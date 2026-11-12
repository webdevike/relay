import * as fs from 'node:fs'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { CanvasBoard, CanvasNode } from '@evaos/contract'
import type { MainContext } from '../context'
import { emit, handle } from '../ipc/handle'
import { createDownload, createImageReader } from './images'
import { createCanvasStore, type CanvasStore } from './store'
import { startCanvasWatchWith } from './watch'

/** An image file in the boards folder to put on a board: its src relative to the folder, and its size. */
export interface BoardImage {
  src: string
  width: number
  height: number
}

/** Puts images on a board's first page through the board store; resolves with how many. */
export type AddBoardImages = (slug: string, images: readonly BoardImage[]) => Promise<number>

const sinks = new WeakMap<MainContext, AddBoardImages>()
const stores = new WeakMap<MainContext, CanvasStore>()

/** The board image adder of this window's Canvas (null before registerCanvasIpc ran). */
export function boardImagesOf(ctx: MainContext): AddBoardImages | null {
  return sinks.get(ctx) ?? null
}

/** This window's board store, for the agents' canvas drive (null before registerCanvasIpc ran). */
export function canvasStoreOf(ctx: MainContext): CanvasStore | null {
  return stores.get(ctx) ?? null
}

const CARD_W = 320
const GAP = 40

/** Image cards in one row below what the page has, left-aligned with it. */
export function imageCards(
  nodes: readonly CanvasNode[],
  images: readonly BoardImage[],
): CanvasNode[] {
  const placed = nodes.filter(
    (n) => n.x !== undefined && n.y !== undefined && n.parent === undefined,
  )
  const left = placed.length ? Math.min(...placed.map((n) => n.x!)) : 0
  const top = placed.length ? Math.max(...placed.map((n) => n.y! + (n.h ?? 200))) + GAP : 0
  let x = left
  return images.map((img) => {
    const h = Math.round((CARD_W * img.height) / Math.max(1, img.width))
    const node: CanvasNode = {
      id: `image-${randomUUID().slice(0, 8)}`,
      type: 'image',
      x,
      y: top,
      w: CARD_W,
      h,
      data: { src: img.src },
    }
    x += CARD_W + GAP
    return node
  })
}

/**
 * Canvas boards: list, load, save, create, rename, delete, pin, images, and `canvas.changed` for
 * edits made outside Relay. Outside live mode the folder starts as a copy of the fixture boards.
 * Studio's Add to canvas puts images on a board through the same store (boardImagesOf).
 */
export function registerCanvasIpc(ctx: MainContext): void {
  const { canvasDir, canvasSeedDir, nativeCanvasPins, configDir, e2e } = ctx.env
  if (canvasSeedDir && !fs.existsSync(canvasDir) && fs.existsSync(canvasSeedDir)) {
    fs.cpSync(canvasSeedDir, canvasDir, { recursive: true })
  }
  fs.mkdirSync(canvasDir, { recursive: true })

  const store = createCanvasStore({
    dir: canvasDir,
    config: ctx.config,
    nativePins: nativeCanvasPins,
  })
  stores.set(ctx, store)
  const images = createImageReader({
    dir: canvasDir,
    cacheDir: path.join(configDir, 'canvas-cache'),
    download: createDownload({ offline: e2e && process.env.EVAOS_E2E_NETWORK !== '1' }),
  })

  handle(ctx, 'canvas.list', async () => ({ entries: await store.list() }))
  handle(ctx, 'canvas.load', ({ slug, page }) => store.load(slug, page))
  // `handle` hands over the parsed input, so the board's defaults (version, nodes...) are filled.
  handle(ctx, 'canvas.save', ({ slug, board, page }) =>
    store.save(slug, board as CanvasBoard, page),
  )
  handle(ctx, 'canvas.pages', ({ slug, ...op }) => store.pages(slug, op))
  handle(ctx, 'canvas.threads', ({ slug, page, op }) => store.threads(slug, page, op))
  handle(ctx, 'canvas.create', () => store.create())
  handle(ctx, 'canvas.rename', ({ slug, title }) => store.rename(slug, title))
  handle(ctx, 'canvas.delete', ({ slug }) => store.remove(slug))
  handle(ctx, 'canvas.pin', ({ slug, pinned }) => store.pin(slug, pinned))
  handle(ctx, 'canvas.image', ({ src }) => images.read(src))
  sinks.set(ctx, async (slug, added) => {
    const shown = await store.load(slug)
    const board: CanvasBoard = {
      ...shown.board,
      nodes: [...shown.board.nodes, ...imageCards(shown.board.nodes, added)],
    }
    await store.save(slug, board, shown.page)
    // The store's own writes raise no watch event: an open board hears it here and reloads.
    emit(ctx, 'canvas.changed', { slug })
    return added.length
  })

  const watcher = startCanvasWatchWith(canvasDir, store.isOwn, (slug) =>
    emit(ctx, 'canvas.changed', { slug }),
  )
  ctx.onBeforeQuit(() => watcher.close())
}
