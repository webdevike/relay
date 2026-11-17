import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { app, shell } from 'electron'
import type { StudioState, StudioView } from '@evaos/contract'
import { boardImagesOf, type BoardImage } from '../canvas/canvas-ipc'
import type { MainContext } from '../context'
import { emit, handle } from '../ipc/handle'
import type { RelayCanvas, RelaySource, RelayStudio } from './client'

const EMPTY: StudioState = { jobs: [], uploads: [], backends: [], projects: [], references: [] }
const DOWNLOAD_TIMEOUT_MS = 120_000

export interface StudioIpcDeps {
  fetch?: typeof fetch
  /** Where downloads go (default ~/Downloads; e2e keeps them in the config dir). */
  downloadsDir?: string
  /** Shows a saved file in Finder (skipped in e2e: it would take focus). */
  reveal?: (file: string) => void
}

/** A file name without path parts or characters a file name should not carry. */
function cleanName(name: string): string {
  return path.basename(name).replace(/[^\w.\- ]+/g, '-') || 'studio'
}

/** `dir/name`, or `dir/name (2).ext` and up when that file exists. */
export function freeName(dir: string, name: string): string {
  const safe = cleanName(name)
  const ext = path.extname(safe)
  const stem = safe.slice(0, safe.length - ext.length)
  let file = path.join(dir, safe)
  for (let n = 2; fs.existsSync(file); n++) file = path.join(dir, `${stem} (${n})${ext}`)
  return file
}

/**
 * `name-<hash>.ext`, for the host's boards folder (which cannot be listed from here): the bytes
 * pick the name, so a new image never replaces another and the same one keeps one file.
 */
function hashedName(name: string, bytes: Buffer): string {
  const safe = cleanName(name)
  const ext = path.extname(safe)
  const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 8)
  return `${safe.slice(0, safe.length - ext.length)}-${hash}${ext}`
}

/**
 * `studio.state` (asks the host, answers what is known), `studio.req` (an op as Isaac: a create
 * goes out with origin `desktop`), `studio.download` (an asset into Downloads, shown in Finder
 * once the last of several downloads at once is saved), and `studio.changed` for every change the
 * host pushes and for Relay coming up or going down.
 */
export function registerStudioIpc(
  ctx: MainContext,
  relay: RelaySource & RelayStudio & Pick<RelayCanvas, 'canvasOrigin'>,
  deps: StudioIpcDeps = {},
): () => void {
  const get = deps.fetch ?? fetch
  const view = (state: StudioState | null): StudioView => ({
    ...(state ?? EMPTY),
    up: relay.studioUp(),
    loaded: state !== null,
    segments: { ...relay.studioSegments() },
  })
  // Downloads in flight, and the last file saved while any were: Finder shows it once all land.
  let downloading = 0
  let saved: string | null = null
  handle(ctx, 'studio.state', async () => view(await relay.studioList()))
  handle(ctx, 'studio.req', ({ op }) =>
    relay.studioRequest(op.kind === 'create' ? { ...op, origin: 'desktop' } : op),
  )
  handle(ctx, 'studio.download', async ({ path: assetPath, name }) => {
    const origin = relay.canvasOrigin()
    if (origin === null) {
      throw Object.assign(new Error("Relay isn't running."), { code: 'relay-unavailable' })
    }
    downloading += 1
    try {
      const res = await get(`${origin}${assetPath}`, {
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      })
      if (!res.ok) {
        throw Object.assign(new Error(`Relay answered ${res.status} ${res.statusText}`.trim()), {
          code: 'host-refused',
        })
      }
      const dir =
        deps.downloadsDir ??
        (ctx.env.e2e ? path.join(ctx.env.configDir, 'Downloads') : app.getPath('downloads'))
      fs.mkdirSync(dir, { recursive: true })
      const file = freeName(dir, name)
      fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()))
      saved = file
      return { file }
    } finally {
      downloading -= 1
      if (downloading === 0 && saved !== null) {
        const last = saved
        saved = null
        if (deps.reveal) deps.reveal(last)
        else if (!ctx.env.e2e) shell.showItemInFolder(last)
      }
    }
  })
  handle(ctx, 'studio.canvas', async ({ slug, assets }) => {
    const origin = relay.canvasOrigin()
    if (origin === null) {
      throw Object.assign(new Error("Relay isn't running."), { code: 'relay-unavailable' })
    }
    const sink = boardImagesOf(ctx)
    if (sink === null)
      throw Object.assign(new Error('Canvas is not ready.'), { code: 'unavailable' })
    const outputs = (relay.studio()?.jobs ?? []).flatMap((j) => j.outputs)
    // Image cards read their src relative to the boards folder (canvas/images.ts): this Mac's, or
    // the Mini's on a thin client.
    const { target } = sink
    if ('dir' in target) fs.mkdirSync(path.join(target.dir, 'studio'), { recursive: true })
    const images: BoardImage[] = []
    for (const a of assets) {
      const res = await get(`${origin}${a.path}`, {
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      })
      if (!res.ok) {
        throw Object.assign(new Error(`Relay answered ${res.status} ${res.statusText}`.trim()), {
          code: 'host-refused',
        })
      }
      const bytes = Buffer.from(await res.arrayBuffer())
      let src: string
      if ('dir' in target) {
        const file = freeName(path.join(target.dir, 'studio'), a.name)
        fs.writeFileSync(file, bytes)
        src = `studio/${path.basename(file)}`
      } else {
        src = `studio/${hashedName(a.name, bytes)}`
        await target.writeAsset(src, bytes)
      }
      const known = outputs.find((o) => o.path === a.path)
      images.push({
        src,
        width: known?.width ?? 1,
        height: known?.height ?? 1,
      })
    }
    return { added: await sink.add(slug, images) }
  })
  const offStudio = relay.onStudio((change) => emit(ctx, 'studio.changed', change))
  let up = relay.studioUp()
  const offStatus = relay.onChange(() => {
    if (relay.studioUp() === up) return
    up = !up
    emit(ctx, 'studio.changed', { kind: 'status', up })
  })
  return () => {
    offStudio()
    offStatus()
  }
}
