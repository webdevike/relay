import * as fs from 'node:fs'
import * as path from 'node:path'
import type { CanvasBoard } from '@evaos/contract'
import type { MainContext } from '../context'
import { emit, handle } from '../ipc/handle'
import { createDownload, createImageReader } from './images'
import { createCanvasStore } from './store'
import { startCanvasWatchWith } from './watch'

/**
 * Canvas boards: list, load, save, create, rename, delete, pin, images, and `canvas.changed` for
 * edits made outside Relay. Outside live mode the folder starts as a copy of the fixture boards.
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
  handle(ctx, 'canvas.create', () => store.create())
  handle(ctx, 'canvas.rename', ({ slug, title }) => store.rename(slug, title))
  handle(ctx, 'canvas.delete', ({ slug }) => store.remove(slug))
  handle(ctx, 'canvas.pin', ({ slug, pinned }) => store.pin(slug, pinned))
  handle(ctx, 'canvas.image', ({ src }) => images.read(src))

  const watcher = startCanvasWatchWith(canvasDir, store.isOwn, (slug) =>
    emit(ctx, 'canvas.changed', { slug }),
  )
  ctx.onBeforeQuit(() => watcher.close())
}
