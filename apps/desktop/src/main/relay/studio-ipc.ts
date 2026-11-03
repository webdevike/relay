import * as fs from 'node:fs'
import * as path from 'node:path'
import { app, shell } from 'electron'
import type { StudioState, StudioView } from '@evaos/contract'
import type { MainContext } from '../context'
import { emit, handle } from '../ipc/handle'
import type { RelayCanvas, RelaySource, RelayStudio } from './client'

const EMPTY: StudioState = { jobs: [], uploads: [], backends: [] }
const DOWNLOAD_TIMEOUT_MS = 120_000

export interface StudioIpcDeps {
  fetch?: typeof fetch
  /** Where downloads go (default ~/Downloads; e2e keeps them in the config dir). */
  downloadsDir?: string
  /** Shows a saved file in Finder (skipped in e2e: it would take focus). */
  reveal?: (file: string) => void
}

/** `dir/name`, or `dir/name (2).ext` and up when that file exists. */
export function freeName(dir: string, name: string): string {
  const safe = path.basename(name).replace(/[^\w.\- ]+/g, '-') || 'studio'
  const ext = path.extname(safe)
  const stem = safe.slice(0, safe.length - ext.length)
  let file = path.join(dir, safe)
  for (let n = 2; fs.existsSync(file); n++) file = path.join(dir, `${stem} (${n})${ext}`)
  return file
}

/**
 * `studio.state` (asks the host, answers what is known), `studio.req` (an op as Isaac: a create
 * goes out with origin `desktop`), `studio.download` (an asset into Downloads, shown in Finder),
 * and `studio.changed` for every change the host pushes and for Relay coming up or going down.
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
  })
  handle(ctx, 'studio.state', async () => view(await relay.studioList()))
  handle(ctx, 'studio.req', ({ op }) =>
    relay.studioRequest(op.kind === 'create' ? { ...op, origin: 'desktop' } : op),
  )
  handle(ctx, 'studio.download', async ({ path: assetPath, name }) => {
    const origin = relay.canvasOrigin()
    if (origin === null) {
      throw Object.assign(new Error("Relay isn't running."), { code: 'relay-unavailable' })
    }
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
    if (deps.reveal) deps.reveal(file)
    else if (!ctx.env.e2e) shell.showItemInFolder(file)
    return { file }
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
