import { beforeEach, describe, expect, it, vi } from 'vitest'

const ipc = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, raw: unknown) => Promise<unknown>>(),
}))
vi.mock('electron', () => ({
  app: { isPackaged: false },
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, raw: unknown) => Promise<unknown>) =>
      ipc.handlers.set(channel, fn),
  },
  BaseWindow: class {},
  WebContentsView: class {},
}))
vi.mock('../window', () => ({ isAppUrl: () => true }))

import type { CanvasRoom } from '@evaos/contract'
import type { MainContext } from '../context'
import type { CanvasAccess, RelayCanvas } from './client'
import { canvasRoomUrl, registerCanvasLiveIpc } from './canvas-live-ipc'
import { canvasCaller, canvasLiveRunners } from './canvas-live-agent'

const ROOM: CanvasRoom = {
  id: 'r1',
  slug: 'mind-map',
  board: 'Mind map',
  live: true,
  agent: { name: 'Nova', color: '#7c5cff' },
  chat: { assistant: 'nova' },
  humans: ['Isaac'],
  startedAt: 1,
}

class FakeCanvas implements RelayCanvas {
  rooms: CanvasRoom[] | null = null
  origin: string | null = 'http://127.0.0.1:7817'
  access: CanvasAccess = { ok: true, path: '/canvas/mind-map/?token=t1', expiresAt: 9 }
  private changes = new Set<() => void>()
  canvasRooms = () => this.rooms
  canvasOrigin = () => this.origin
  openCanvas = () => Promise.resolve(this.access)
  onCanvasRoomsChange(cb: () => void) {
    this.changes.add(cb)
    return () => this.changes.delete(cb)
  }
  set(rooms: CanvasRoom[] | null): void {
    this.rooms = rooms
    for (const cb of this.changes) cb()
  }
}

describe('canvasRoomUrl', () => {
  it('loads the host path on its origin, embedded for the desktop frame', () => {
    expect(canvasRoomUrl('http://127.0.0.1:7817', '/canvas/mind-map/?token=a%2Bb')).toBe(
      'http://127.0.0.1:7817/canvas/mind-map/?token=a%2Bb&embed=desktop',
    )
    expect(canvasRoomUrl('http://127.0.0.1:7817', '/canvas/x/')).toBe(
      'http://127.0.0.1:7817/canvas/x/?embed=desktop',
    )
  })
})

describe('canvas live IPC', () => {
  const sent: Array<[string, unknown]> = []
  const ctx = {
    shell: {
      webContents: { isDestroyed: () => false, send: (c: string, p: unknown) => sent.push([c, p]) },
    },
  } as unknown as MainContext
  const call = (channel: string, input: unknown): Promise<unknown> =>
    ipc.handlers.get(channel)!({ senderFrame: { url: 'app://shell' } }, input)
  beforeEach(() => {
    ipc.handlers.clear()
    sent.length = 0
  })

  it('lists the rooms with the host origin and pushes every change', async () => {
    const relay = new FakeCanvas()
    const off = registerCanvasLiveIpc(ctx, relay)
    expect(await call('canvas.live.rooms', {})).toEqual({
      ok: true,
      value: { rooms: [], relayUp: false, origin: 'http://127.0.0.1:7817' },
    })
    relay.set([ROOM])
    expect(sent).toEqual([
      ['canvas.live.changed', { rooms: [ROOM], relayUp: true, origin: 'http://127.0.0.1:7817' }],
    ])
    off()
    relay.set(null)
    expect(sent).toHaveLength(1)
  })

  it('opens a live room as a frame URL, and says why it cannot', async () => {
    const relay = new FakeCanvas()
    registerCanvasLiveIpc(ctx, relay)
    expect(await call('canvas.live.open', { slug: 'mind-map' })).toEqual({
      ok: true,
      value: { url: 'http://127.0.0.1:7817/canvas/mind-map/?token=t1&embed=desktop' },
    })
    relay.access = { ok: false, error: 'The canvas session ended.' }
    expect(await call('canvas.live.open', { slug: 'mind-map' })).toEqual({
      ok: false,
      error: { code: 'canvas-unavailable', message: 'The canvas session ended.' },
    })
    expect(await call('canvas.live.open', { slug: 'Not a slug' })).toMatchObject({
      ok: false,
      error: { code: 'invalid-input' },
    })
  })

  it("asks Nova: starts the board's session as her thread's, handing over the saved comment", async () => {
    const post = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ roomId: 'r9', slug: 'mind-map', agent: { name: 'Nova' } }), {
          status: 200,
        }),
      ),
    )
    registerCanvasLiveIpc(ctx, new FakeCanvas(), post as unknown as typeof fetch)
    expect(
      await call('canvas.live.ask', { slug: 'mind-map', thread: 't-1', page: 'flows' }),
    ).toEqual({ ok: true, value: { roomId: 'r9', agent: 'Nova' } })
    const [url, init] = post.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('http://127.0.0.1:7817/canvas/sessions')
    expect(JSON.parse(String(init.body))).toMatchObject({
      slug: 'mind-map',
      thread: { id: 't-1', page: 'flows' },
      caller: { assistant: 'nova' },
    })
    await call('canvas.live.ask', { slug: 'mind-map', thread: 't-2' })
    expect(
      JSON.parse(String((post.mock.calls[1] as unknown as [string, RequestInit])[1].body)),
    ).toMatchObject({
      thread: { id: 't-2' },
    })
  })

  it("says the host's refusal, or that Relay is not running, as canvas-unavailable", async () => {
    const refuse = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: 'The nova assistant thread is not running.' }), {
          status: 409,
        }),
      ),
    )
    registerCanvasLiveIpc(ctx, new FakeCanvas(), refuse as unknown as typeof fetch)
    expect(await call('canvas.live.ask', { slug: 'mind-map', thread: 't-1' })).toEqual({
      ok: false,
      error: { code: 'canvas-unavailable', message: 'The nova assistant thread is not running.' },
    })
    ipc.handlers.clear()
    const none = new FakeCanvas()
    none.origin = null
    registerCanvasLiveIpc(ctx, none)
    expect(await call('canvas.live.ask', { slug: 'mind-map', thread: 't-1' })).toMatchObject({
      ok: false,
      error: { code: 'canvas-unavailable' },
    })
  })
})

describe('canvas.live action', () => {
  const FILE = '/Users/i/.omp/agent/sessions/-Eva/2026-10-28T10-00-00-000Z_s1.jsonl'

  it("takes the caller from the request's scope", () => {
    expect(canvasCaller('agent:nova')).toEqual({ assistant: 'nova' })
    expect(canvasCaller('page:agent:nova')).toEqual({ assistant: 'nova' })
    expect(canvasCaller(FILE)).toEqual({ sessionFile: FILE })
    expect(canvasCaller(`chat:${FILE}`)).toEqual({ sessionFile: FILE })
    expect(() => canvasCaller(undefined)).toThrow(/calling session/)
    expect(() => canvasCaller('page:dashboard')).toThrow(/No chat session/)
  })

  it("posts the ask to the host's loopback route and answers its JSON", async () => {
    const post = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ roomId: 'r1', slug: 'mind-map', joinPath: '/canvas/mind-map/' }),
          {
            status: 200,
          },
        ),
      ),
    )
    const run = canvasLiveRunners(new FakeCanvas(), post as unknown as typeof fetch)['canvas.live']
    expect(await run({ slug: 'mind-map', prompt: 'Sketch the flow', scope: FILE })).toEqual({
      roomId: 'r1',
      slug: 'mind-map',
      joinPath: '/canvas/mind-map/',
    })
    const [url, init] = post.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('http://127.0.0.1:7817/canvas/sessions')
    expect(init.method).toBe('POST')
    expect(init.headers).toEqual({ 'content-type': 'application/json' })
    expect(JSON.parse(String(init.body))).toEqual({
      slug: 'mind-map',
      prompt: 'Sketch the flow',
      caller: { sessionFile: FILE },
    })
  })

  it("says the host's refusal word for word, and when there is no host", async () => {
    const refuse = () =>
      Promise.resolve(
        new Response(JSON.stringify({ error: "This chat isn't connected to Relay." }), {
          status: 409,
        }),
      )
    const run = canvasLiveRunners(new FakeCanvas(), refuse as unknown as typeof fetch)[
      'canvas.live'
    ]
    await expect(run({ scope: 'agent:nova' })).rejects.toMatchObject({
      code: 'host-refused',
      message: "This chat isn't connected to Relay.",
    })
    const none = new FakeCanvas()
    none.origin = null
    await expect(
      canvasLiveRunners(none)['canvas.live']({ scope: 'agent:nova' }),
    ).rejects.toMatchObject({
      code: 'relay-unavailable',
    })
  })
})
