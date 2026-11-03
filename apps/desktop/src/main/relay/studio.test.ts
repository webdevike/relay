import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const ipc = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, raw: unknown) => Promise<unknown>>(),
}))
vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '/nowhere' },
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, raw: unknown) => Promise<unknown>) =>
      ipc.handlers.set(channel, fn),
  },
  shell: { showItemInFolder: () => undefined },
  BaseWindow: class {},
  WebContentsView: class {},
}))
vi.mock('../window', () => ({ isAppUrl: () => true }))

import type {
  AgentParams,
  AgentResult,
  AgentRunners,
  StudioAnswer,
  StudioAspect,
  StudioBackend,
  StudioChange,
  StudioJob,
  StudioOp,
  StudioState,
} from '@evaos/contract'
import type { MainContext } from '../context'
import {
  NO_ANSWER,
  NOT_CONNECTED,
  RelayClient,
  StaticRelay,
  type Dial,
  type RelayStudio,
  type SocketHandlers,
} from './client'
import { STUDIO_LIST_FRAME, studioReqFrame } from './commands'
import { Feed } from './feed'
import type { RelaySession } from './feed'
import { compactJob, studioRunners } from './studio-agent'
import { freeName, registerStudioIpc } from './studio-ipc'

const res = (aspect: StudioAspect, id: string) => ({ id, label: id, aspect })
const backend = (
  b: Partial<StudioBackend> & Pick<StudioBackend, 'id' | 'mode'>,
): StudioBackend => ({
  label: b.id,
  paid: false,
  available: true,
  resolutions: [res('16:9', `${b.id}-wide`), res('1:1', `${b.id}-square`)],
  seconds: [],
  frames: [],
  refs: 0,
  seed: false,
  serial: false,
  ...b,
})
const BACKENDS: StudioBackend[] = [
  backend({
    id: 'ltx',
    mode: 'video',
    seconds: [3, 5],
    frames: ['start', 'mid', 'end'],
    seed: true,
  }),
  backend({ id: 'codex-image', mode: 'image' }),
  backend({ id: 'codex-edit', mode: 'image', refs: 4 }),
  backend({ id: 'kontext', mode: 'image', refs: 1, seed: true, serial: true }),
  backend({ id: 'higgsfield', mode: 'video', paid: true, balance: 500 }),
]
const ASSET = {
  id: 'a1',
  kind: 'image' as const,
  mimeType: 'image/png',
  width: 1024,
  height: 1024,
  size: 2048,
  path: '/studio/a1/tok',
  thumb: '/studio/a1/tok/thumb',
  origin: 'output' as const,
  createdAt: 2,
}
const job = (id: string, extra: Partial<StudioJob> = {}): StudioJob => ({
  id,
  spec: {
    mode: 'image',
    backend: 'codex-image',
    prompt: `Prompt ${id}`,
    aspect: '1:1',
    resolution: 'codex-image-square',
  },
  state: 'done',
  origin: 'desktop',
  createdAt: 1,
  progress: 1,
  outputs: [ASSET],
  ...extra,
})
const STATE: StudioState = { jobs: [job('j1')], uploads: [], backends: BACKENDS }

describe('studio frames', () => {
  it('builds list and req frames', () => {
    expect(STUDIO_LIST_FRAME).toEqual({ t: 'studio.list' })
    expect(studioReqFrame('r1', { kind: 'cancel', id: 'j1' })).toEqual({
      t: 'studio.req',
      rid: 'r1',
      op: { kind: 'cancel', id: 'j1' },
    })
  })

  it('parses state (dropping what does not parse), jobs, removals and answers', () => {
    const feed = new Feed(null, false)
    expect(
      feed.receive({
        t: 'studio.state',
        jobs: [job('j1'), { id: 'bad' }],
        uploads: [ASSET],
        backends: BACKENDS,
      }).events,
    ).toEqual([
      { kind: 'studioState', state: { jobs: [job('j1')], uploads: [ASSET], backends: BACKENDS } },
    ])
    expect(feed.receive({ t: 'studio.job', job: job('j2') }).events).toEqual([
      { kind: 'studioJob', job: job('j2') },
    ])
    expect(feed.receive({ t: 'studio.job', job: { id: 'bad' } }).events).toEqual([])
    expect(feed.receive({ t: 'studio.removed', id: 'j1' }).events).toEqual([
      { kind: 'studioRemoved', id: 'j1' },
    ])
    const [answer] = feed.receive({
      t: 'studio.res',
      rid: 'r1',
      ok: true,
      job: { id: 'bad' },
      credits: 40,
      balance: 460,
    }).events
    expect(answer).toMatchObject({
      kind: 'studioRes',
      rid: 'r1',
      answer: { ok: true, credits: 40, balance: 460 },
    })
    expect(answer?.kind === 'studioRes' && answer.answer.job).toBeUndefined()
  })
})

const dirs: string[] = []
afterEach(() => {
  vi.useRealTimers()
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

class Socket {
  sent: Record<string, unknown>[][] = []
  handlers: SocketHandlers[] = []
  dial: Dial = async (_url, on) => {
    const frames: Record<string, unknown>[] = []
    this.sent.push(frames)
    this.handlers.push(on)
    return {
      send: (text) => void frames.push(JSON.parse(text) as Record<string, unknown>),
      close: () => undefined,
    }
  }
  frames = (): Record<string, unknown>[] => this.sent.at(-1) ?? []
  say = (frame: unknown): void => this.handlers.at(-1)!.message(JSON.stringify(frame))
}

describe('RelayClient studio', () => {
  beforeEach(() => vi.useFakeTimers())
  const welcome = { t: 'welcome', state: { agents: { rev: 0, sessions: [] } } }

  async function connected() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-'))
    dirs.push(dir)
    fs.writeFileSync(path.join(dir, 'serve.json'), JSON.stringify({ port: 7817, pid: 1 }))
    const socket = new Socket()
    const client = new RelayClient({
      configDir: dir,
      dial: socket.dial,
      secret: () => Buffer.alloc(32, 9),
      commandTimeoutMs: 1000,
    })
    client.start()
    await vi.advanceTimersByTimeAsync(0)
    return { client, socket }
  }

  it('asks only once Studio is wanted, again on every connection, and keeps every change', async () => {
    const { client, socket } = await connected()
    socket.say(welcome)
    expect(socket.frames().some((f) => f.t === 'studio.list')).toBe(false)
    const listed = client.studioList()
    expect(socket.frames().filter((f) => f.t === 'studio.list')).toHaveLength(1)
    const heard: StudioChange[] = []
    client.onStudio((c) => heard.push(c))
    socket.say({ t: 'studio.state', ...STATE })
    expect(await listed).toEqual(STATE)
    socket.say({
      t: 'studio.job',
      job: job('j2', { createdAt: 5, state: 'running', progress: 0.5 }),
    })
    expect(client.studio()?.jobs.map((j) => j.id)).toEqual(['j2', 'j1'])
    socket.say({ t: 'studio.job', job: job('j2', { createdAt: 5, progress: 1 }) })
    expect(client.studio()?.jobs[0]?.state).toBe('done')
    socket.say({ t: 'studio.removed', id: 'j1' })
    expect(client.studio()?.jobs.map((j) => j.id)).toEqual(['j2'])
    expect(heard.map((c) => c.kind)).toEqual(['state', 'job', 'job', 'removed'])
    socket.handlers.at(-1)!.closed('gone')
    expect(client.studioUp()).toBe(false)
    expect(client.studio()?.jobs).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(3000)
    socket.say(welcome)
    expect(socket.frames()).toContainEqual({ t: 'studio.list' })
    client.stop()
  })

  it('answers a list with what is known when down or unanswered', async () => {
    const { client, socket } = await connected()
    expect(await client.studioList()).toBeNull()
    socket.say(welcome)
    const slow = client.studioList()
    await vi.advanceTimersByTimeAsync(1000)
    expect(await slow).toBeNull()
    client.stop()
  })

  it('resolves an op with its answer, a timeout, or the dropped connection', async () => {
    const { client, socket } = await connected()
    expect(await client.studioRequest({ kind: 'refresh' })).toEqual({
      ok: false,
      error: NOT_CONNECTED,
    })
    socket.say(welcome)
    const op: StudioOp = { kind: 'quote', spec: job('x').spec }
    const quoted = client.studioRequest(op)
    const frame = socket.frames().at(-1)!
    expect(frame).toMatchObject({ t: 'studio.req', op })
    socket.say({ t: 'studio.res', rid: frame.rid, ok: true, credits: 40, balance: 460 })
    expect(await quoted).toMatchObject({ ok: true, credits: 40, balance: 460 })
    const slow = client.studioRequest({ kind: 'refresh' })
    await vi.advanceTimersByTimeAsync(1000)
    expect(await slow).toEqual({ ok: false, error: NO_ANSWER })
    const lost = client.studioRequest({ kind: 'refresh' })
    socket.handlers.at(-1)!.closed('Lost it')
    expect(await lost).toEqual({ ok: false, error: 'Lost it' })
    client.stop()
  })

  it('StaticRelay never has Studio', async () => {
    const relay = new StaticRelay()
    expect(relay.studioUp()).toBe(false)
    expect(relay.studio()).toBeNull()
    expect(await relay.studioList()).toBeNull()
    expect(await relay.studioRequest()).toEqual({ ok: false, error: NOT_CONNECTED })
  })
})

class FakeStudio implements RelayStudio {
  up = true
  state: StudioState | null = STATE
  ops: StudioOp[] = []
  answer: StudioAnswer = { ok: true }
  origin: string | null = 'http://127.0.0.1:7817'
  lists = 0
  private changes = new Set<() => void>()
  private heard = new Set<(c: StudioChange) => void>()
  sessions = (): ReadonlyMap<string, RelaySession> | null => new Map()
  onChange(cb: () => void) {
    this.changes.add(cb)
    return () => this.changes.delete(cb)
  }
  studioUp = () => this.up
  studio = () => this.state
  studioList = async () => {
    this.lists += 1
    return this.state
  }
  studioRequest = async (op: StudioOp) => {
    this.ops.push(op)
    return this.answer
  }
  onStudio(cb: (c: StudioChange) => void) {
    this.heard.add(cb)
    return () => this.heard.delete(cb)
  }
  canvasOrigin = () => this.origin
  push(change: StudioChange): void {
    for (const cb of [...this.heard]) cb(change)
  }
  setUp(up: boolean): void {
    this.up = up
    for (const cb of this.changes) cb()
  }
}

describe('studio IPC', () => {
  const sent: Array<[string, unknown]> = []
  const ctx = {
    env: { e2e: false, configDir: '/nowhere' },
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

  it('asks the host for state and sends ops as Isaac, a create as desktop', async () => {
    const relay = new FakeStudio()
    registerStudioIpc(ctx, relay)
    expect(await call('studio.state', {})).toEqual({
      ok: true,
      value: { ...STATE, up: true, loaded: true },
    })
    expect(relay.lists).toBe(1)
    relay.state = null
    expect(await call('studio.state', {})).toMatchObject({ value: { loaded: false, jobs: [] } })
    const spec = job('x').spec
    relay.answer = { ok: true, job: job('j9') }
    expect(await call('studio.req', { op: { kind: 'create', spec } })).toEqual({
      ok: true,
      value: { ok: true, job: job('j9') },
    })
    expect(relay.ops.at(-1)).toEqual({ kind: 'create', spec, origin: 'desktop' })
    await call('studio.req', { op: { kind: 'frame', asset: 'a1', at: 'last' } })
    expect(relay.ops.at(-1)).toEqual({ kind: 'frame', asset: 'a1', at: 'last' })
    // The page cannot name an origin, nor send an agent's create.
    await call('studio.req', { op: { kind: 'create', spec, origin: 'agent' } })
    expect(relay.ops.at(-1)).toEqual({ kind: 'create', spec, origin: 'desktop' })
  })

  it('passes every change on, and Relay coming up or going down', () => {
    const relay = new FakeStudio()
    registerStudioIpc(ctx, relay)
    relay.push({ kind: 'removed', id: 'j1' })
    relay.setUp(true)
    relay.setUp(false)
    expect(sent).toEqual([
      ['studio.changed', { kind: 'removed', id: 'j1' }],
      ['studio.changed', { kind: 'status', up: false }],
    ])
  })

  it('downloads an asset into the downloads folder under a free name and reveals it', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-dl-'))
    dirs.push(dir)
    fs.writeFileSync(path.join(dir, 'studio-a1.png'), 'old')
    const relay = new FakeStudio()
    const asked: string[] = []
    const revealed: string[] = []
    // fetch has overloads and statics a test stub need not have; only the URL call is used.
    const fake = (async (url: string) => {
      asked.push(url)
      return new Response('png bytes')
    }) as unknown as typeof fetch
    registerStudioIpc(ctx, relay, {
      fetch: fake,
      downloadsDir: dir,
      reveal: (f) => revealed.push(f),
    })
    const file = path.join(dir, 'studio-a1 (2).png')
    expect(
      await call('studio.download', { path: '/studio/a1/tok', name: 'studio-a1.png' }),
    ).toEqual({
      ok: true,
      value: { file },
    })
    expect(asked).toEqual(['http://127.0.0.1:7817/studio/a1/tok'])
    expect(fs.readFileSync(file, 'utf8')).toBe('png bytes')
    expect(revealed).toEqual([file])
    expect(await call('studio.download', { path: '/drops/x/y', name: 'a.png' })).toMatchObject({
      ok: false,
      error: { code: 'invalid-input' },
    })
    relay.origin = null
    expect(await call('studio.download', { path: '/studio/a1/tok', name: 'a.png' })).toMatchObject({
      ok: false,
      error: { code: 'relay-unavailable' },
    })
  })

  it('keeps a download name inside the folder', () => {
    expect(freeName('/d', '../../etc/passwd')).toBe('/d/passwd')
    expect(freeName('/d', 'a b?.png')).toBe('/d/a b-.png')
  })
})

describe('studio agent actions', () => {
  const setup = () => {
    const relay = new FakeStudio()
    const opened: Array<AgentParams<'studio.open'>> = []
    const runners = studioRunners(relay, async (p): Promise<AgentResult> => {
      opened.push(p)
      return { ok: true, value: { tab: 'page:studio' } }
    })
    relay.answer = { ok: true, job: job('j9', { state: 'queued', progress: 0, outputs: [] }) }
    return { relay, opened, runners }
  }
  const generate = (
    runners: Pick<AgentRunners<'main'>, 'studio.generate'>,
    params: Partial<AgentParams<'studio.generate'>>,
  ) => runners['studio.generate']({ prompt: 'A kite', ...params })

  it('picks the default backend, aspect, resolution and length, and creates as the agent', async () => {
    const { relay, runners } = setup()
    expect(await generate(runners, {})).toMatchObject({ job: { id: 'j9', state: 'queued' } })
    expect(relay.ops.at(-1)).toEqual({
      kind: 'create',
      origin: 'agent',
      spec: {
        mode: 'image',
        backend: 'codex-image',
        prompt: 'A kite',
        aspect: '1:1',
        resolution: 'codex-image-square',
      },
    })
    await generate(runners, { mode: 'video', seed: 7 })
    expect(relay.ops.at(-1)).toMatchObject({
      spec: { backend: 'ltx', aspect: '16:9', resolution: 'ltx-wide', seconds: 3, seed: 7 },
    })
    await generate(runners, { backend: 'ltx' })
    expect(relay.ops.at(-1)).toMatchObject({ spec: { mode: 'video', backend: 'ltx' } })
    await generate(runners, { refs: ['a1'] })
    expect(relay.ops.at(-1)).toMatchObject({ spec: { backend: 'codex-edit', refs: ['a1'] } })
    await generate(runners, { backend: 'kontext', refs: ['a1'], seed: 5 })
    expect(relay.ops.at(-1)).toMatchObject({
      spec: {
        mode: 'image',
        backend: 'kontext',
        refs: ['a1'],
        seed: 5,
        resolution: 'kontext-square',
      },
    })
  })

  it('refuses paid, unavailable and unknown settings with a clear code', async () => {
    const { relay, runners } = setup()
    await expect(generate(runners, { backend: 'higgsfield' })).rejects.toMatchObject({
      code: 'paid-backend',
      message: expect.stringContaining('studio.open'),
    })
    await expect(
      generate(runners, { backend: 'codex-image', mode: 'video' }),
    ).rejects.toMatchObject({
      code: 'invalid-params',
    })
    await expect(generate(runners, { resolution: '9x9' })).rejects.toMatchObject({
      code: 'invalid-params',
      message: expect.stringContaining('codex-image-square'),
    })
    relay.state = {
      ...STATE,
      backends: BACKENDS.map((b) => ({ ...b, available: false, reason: 'No GPU' })),
    }
    await expect(generate(runners, {})).rejects.toMatchObject({
      code: 'backend-unavailable',
      message: 'No GPU',
    })
    expect(relay.ops).toEqual([])
    relay.state = STATE
    relay.answer = { ok: false, error: 'Queue is full' }
    await expect(generate(runners, {})).rejects.toMatchObject({
      code: 'host-refused',
      message: 'Queue is full',
    })
    relay.state = null
    await expect(generate(runners, {})).rejects.toMatchObject({ code: 'relay-unavailable' })
  })

  it('opens the new job in the caller scope when asked', async () => {
    const { runners, opened } = setup()
    expect(await generate(runners, { open: true, scope: 'agent:nova' })).toMatchObject({
      opened: { tab: 'page:studio' },
    })
    expect(opened).toEqual([{ job: 'j9', scope: 'agent:nova' }])
  })

  it('lists jobs with links on the host origin, by state and limit', async () => {
    const { relay, runners } = setup()
    relay.state = {
      ...STATE,
      jobs: [
        job('j3', { state: 'running', progress: 0.5, etaMs: 40_000, outputs: [] }),
        job('j2'),
        job('j1'),
      ],
    }
    const all = await runners['studio.list']({})
    expect(all).toMatchObject({ up: true, backends: BACKENDS })
    expect(await runners['studio.list']({ state: 'done', limit: 1 })).toMatchObject({
      jobs: [
        {
          id: 'j2',
          outputs: [
            {
              id: 'a1',
              url: 'http://127.0.0.1:7817/studio/a1/tok',
              thumb: 'http://127.0.0.1:7817/studio/a1/tok/thumb',
              size: 2048,
            },
          ],
        },
      ],
    })
    expect(compactJob(relay.state.jobs[0]!, null)).toMatchObject({
      eta: 'about 40 s left',
      progress: 0.5,
    })
  })
})
