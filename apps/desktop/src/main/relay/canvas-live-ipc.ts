import type { CanvasRooms } from '@evaos/contract'
import type { MainContext } from '../context'
import { emit, handle } from '../ipc/handle'
import type { RelayCanvas } from './client'

/** The room page at `path` (host-relative, with its token) on `origin`, as this app's frame loads it. */
export function canvasRoomUrl(origin: string, path: string): string {
  const url = new URL(path, origin)
  url.searchParams.set('embed', 'desktop')
  return url.toString()
}

/**
 * `canvas.live.rooms`, `canvas.live.changed` on every change Relay pushes (and Relay going down),
 * and `canvas.live.open`: a fresh way into the live room on a board, for the Canvas page's frame.
 */
export function registerCanvasLiveIpc(ctx: MainContext, relay: RelayCanvas): () => void {
  const rooms = (): CanvasRooms => {
    const list = relay.canvasRooms()
    return {
      rooms: list === null ? [] : [...list],
      relayUp: list !== null,
      origin: relay.canvasOrigin(),
    }
  }
  handle(ctx, 'canvas.live.rooms', rooms)
  handle(ctx, 'canvas.live.open', async ({ slug }) => {
    const access = await relay.openCanvas(slug)
    const origin = relay.canvasOrigin()
    if (!access.ok || origin === null) {
      const message = access.ok ? "Relay isn't running." : access.error
      throw Object.assign(new Error(message), { code: 'canvas-unavailable' })
    }
    return { url: canvasRoomUrl(origin, access.path) }
  })
  return relay.onCanvasRoomsChange(() => emit(ctx, 'canvas.live.changed', rooms()))
}
