import { z } from 'zod'
import type { CanvasRooms } from '@evaos/contract'
import type { MainContext } from '../context'
import { emit, handle } from '../ipc/handle'
import { startCanvasSession } from './canvas-live-agent'
import type { RelayCanvas } from './client'

/** The assistant whose thread holds a session started from the Canvas page's "Ask Nova". */
export const CANVAS_ASSISTANT = 'nova'

const Started = z.object({
  roomId: z.string().min(1),
  agent: z.object({ name: z.string().min(1) }),
})

/** The room page at `path` (host-relative, with its token) on `origin`, as this app's frame loads it. */
export function canvasRoomUrl(origin: string, path: string): string {
  const url = new URL(path, origin)
  url.searchParams.set('embed', 'desktop')
  return url.toString()
}

/**
 * `canvas.live.rooms`, `canvas.live.changed` on every change Relay pushes (and Relay going down),
 * `canvas.live.open`: a fresh way into the live room on a board, for the Canvas page's frame, and
 * `canvas.live.ask`: a session on a board with Nova, handed the comment the page just saved.
 */
export function registerCanvasLiveIpc(
  ctx: MainContext,
  relay: RelayCanvas,
  post: typeof fetch = fetch,
): () => void {
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
  handle(ctx, 'canvas.live.ask', async ({ slug, thread, page, assistant }) => {
    const body = {
      slug,
      thread: { id: thread, ...(page === undefined ? {} : { page }) },
      prompt: 'Isaac left a comment on this board from Relay Desktop; answer it in its thread.',
      caller: { assistant: assistant ?? CANVAS_ASSISTANT },
    }
    let reply: unknown
    try {
      reply = await startCanvasSession(relay, body, post)
    } catch (e) {
      throw Object.assign(e instanceof Error ? e : new Error(String(e)), {
        code: 'canvas-unavailable',
      })
    }
    const started = Started.parse(reply)
    return { roomId: started.roomId, agent: started.agent.name }
  })
  return relay.onCanvasRoomsChange(() => emit(ctx, 'canvas.live.changed', rooms()))
}
