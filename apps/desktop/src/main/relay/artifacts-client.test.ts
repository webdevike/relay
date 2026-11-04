import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  NO_ANSWER,
  NOT_CONNECTED,
  RelayClient,
  StaticRelay,
  type Dial,
  type SocketHandlers,
} from './client'
import { artifactsActFrame, artifactsGetFrame } from './commands'
import { Feed, parseArtifacts } from './feed'

const ITEM = {
  id: 'linear:ENG-6528',
  kind: 'linear',
  title: 'eGift Order Hub is malformed',
  mentions: 82,
  firstSeen: 1,
  lastSeen: 2,
  sources: ['user@2'],
  addedBy: 'extractor',
}
const TAB = {
  id: 'links',
  title: 'Links',
  createdBy: 'default',
  createdAt: 0,
  rule: { kind: ['linear'] },
  hidden: false,
}

describe('artifacts frames', () => {
  it('builds get and act frames', () => {
    expect(artifactsGetFrame('assistant:astra')).toEqual({
      t: 'artifacts.get',
      thread: 'assistant:astra',
    })
    expect(
      artifactsActFrame('assistant:astra', 'r1', 'isaac', { op: 'pin', id: 'url:x', pinned: true }),
    ).toEqual({
      t: 'artifacts.act',
      thread: 'assistant:astra',
      rid: 'r1',
      by: 'isaac',
      action: { op: 'pin', id: 'url:x', pinned: true },
    })
  })

  it('parses snapshots, dropping items and tabs that do not parse, and acted answers', () => {
    expect(parseArtifacts([ITEM, { id: 'x' }], [TAB, { id: 'Bad Id' }])).toEqual({
      items: [ITEM],
      tabs: [TAB],
    })
    const feed = new Feed(Buffer.alloc(32))
    expect(
      feed.receive({
        t: 'artifacts.snapshot',
        thread: 'assistant:astra',
        items: [ITEM],
        tabs: [TAB],
      }).events,
    ).toEqual([{ kind: 'artifacts', thread: 'assistant:astra', items: [ITEM], tabs: [TAB] }])
    expect(
      feed.receive({ t: 'artifacts.snapshot', thread: 'Bad thread', items: [], tabs: [] }).events,
    ).toEqual([])
    expect(
      feed.receive({ t: 'artifacts.acted', rid: 'r1', ok: false, error: 'Isaac hid that tab.' })
        .events,
    ).toEqual([{ kind: 'acted', rid: 'r1', ok: false, error: 'Isaac hid that tab.' }])
    expect(
      feed.receive({ t: 'artifacts.acted', rid: 'r2', ok: true, id: 'open-prs' }).events,
    ).toEqual([{ kind: 'acted', rid: 'r2', ok: true, id: 'open-prs' }])
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

describe('RelayClient artifacts', () => {
  beforeEach(() => vi.useFakeTimers())

  async function connected() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-'))
    dirs.push(dir)
    fs.writeFileSync(path.join(dir, 'serve.json'), JSON.stringify({ port: 7817, pid: 1 }))
    const socket = new Socket()
    const client = new RelayClient({
      configDir: dir,
      dial: socket.dial,
      secret: () => Buffer.alloc(32, 9),
      actTimeoutMs: 1000,
    })
    client.start()
    await vi.advanceTimersByTimeAsync(0)
    return { client, socket }
  }
  const welcome = { t: 'welcome', state: { agents: { rev: 0, sessions: [] } } }

  it('asks for watched threads on every connection and keeps every snapshot it hears', async () => {
    const { client, socket } = await connected()
    client.watchArtifacts('assistant:astra')
    expect(socket.frames().some((f) => f.t === 'artifacts.get')).toBe(false)
    socket.say(welcome)
    expect(socket.frames()).toContainEqual({ t: 'artifacts.get', thread: 'assistant:astra' })
    const heard = vi.fn()
    client.onArtifacts(heard)
    socket.say({ t: 'artifacts.snapshot', thread: 'assistant:nova', items: [ITEM], tabs: [TAB] })
    expect(heard).toHaveBeenCalledWith('assistant:nova')
    expect(client.artifacts('assistant:nova')).toEqual({ items: [ITEM], tabs: [TAB] })
    expect([...client.artifactThreads().keys()]).toEqual(['assistant:nova'])
    client.unwatchArtifacts('assistant:astra')
    socket.handlers.at(-1)!.closed('gone')
    await vi.advanceTimersByTimeAsync(3000)
    socket.say(welcome)
    expect(socket.frames().some((f) => f.t === 'artifacts.get')).toBe(false)
    // Kept while down and after: the snapshot is the host's latest word.
    expect(client.artifacts('assistant:nova')).not.toBeNull()
    client.stop()
  })

  it('asks for the activity list on every connection and keeps the latest snapshot, dropping bad rows', async () => {
    const { client, socket } = await connected()
    client.watchActivity()
    socket.say(welcome)
    expect(socket.frames()).toContainEqual({ t: 'activity.get' })
    const heard = vi.fn()
    client.onActivity(heard)
    const row = {
      id: 'harness:w1:p3',
      kind: 'harness',
      owner: 'other',
      title: 'demo-claude',
      status: 'working',
      intent: 'claude in harness-demo',
      startedAt: 1,
      updatedAt: 2,
      open: { to: 'terminal', pane: 'w1:p3' },
    }
    socket.say({ t: 'activity.snapshot', items: [row, { ...row, id: 'bad', open: { to: 'nowhere' } }] })
    expect(heard).toHaveBeenCalledTimes(1)
    expect(client.activity().map((i) => i.id)).toEqual(['harness:w1:p3'])
    client.stop()
  })

  it('resolves an act with its acted answer, a timeout, or the dropped connection', async () => {
    const { client, socket } = await connected()
    expect(
      await client.actArtifacts('assistant:astra', 'isaac', {
        op: 'pin',
        id: 'url:x',
        pinned: true,
      }),
    ).toEqual({
      ok: false,
      error: NOT_CONNECTED,
    })
    socket.say(welcome)
    const answered = client.actArtifacts('assistant:astra', 'astra', {
      op: 'tab.add',
      title: 'Open PRs',
      rule: { kind: ['gh-pr'] },
    })
    const frame = socket.frames().at(-1)!
    expect(frame).toMatchObject({ t: 'artifacts.act', thread: 'assistant:astra', by: 'astra' })
    socket.say({ t: 'artifacts.acted', rid: frame.rid, ok: true, id: 'open-prs' })
    expect(await answered).toEqual({ ok: true, id: 'open-prs' })
    const slow = client.actArtifacts('assistant:astra', 'isaac', { op: 'tab.remove', tab: 'x' })
    await vi.advanceTimersByTimeAsync(1000)
    expect(await slow).toEqual({ ok: false, error: NO_ANSWER })
    const lost = client.actArtifacts('assistant:astra', 'isaac', { op: 'tab.remove', tab: 'x' })
    socket.handlers.at(-1)!.closed('Lost it')
    expect(await lost).toEqual({ ok: false, error: 'Lost it' })
    client.stop()
  })
})

describe('StaticRelay artifacts', () => {
  it('never acts, and serves snapshots a test sets', async () => {
    const relay = new StaticRelay()
    const heard = vi.fn()
    relay.onArtifacts(heard)
    expect(relay.artifactsUp()).toBe(false)
    expect(await relay.actArtifacts()).toEqual({ ok: false, error: NOT_CONNECTED })
    relay.setArtifacts('assistant:nova', { items: [], tabs: [] })
    expect(heard).toHaveBeenCalledWith('assistant:nova')
    expect(relay.artifacts('assistant:nova')).toEqual({ items: [], tabs: [] })
  })
})
