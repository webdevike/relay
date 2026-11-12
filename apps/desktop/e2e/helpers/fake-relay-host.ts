// A stand-in for the local Relay host (relay apps/linux src/session.ts) on a real WebSocket, so e2e
// drives the app's actual Relay client: serve.json gives the port, devices.json the paired secret
// (the app adds its own), the handshake checks the HMAC proof, and the agent frames follow
// relay packages/protocol/src/index.ts. Tests list sessions, stream replies, raise asks and
// approvals, hold live canvas rooms (with a tiny room page on the same port, as the host serves
// its web client), run Studio (its backends and presets, a paid one with models and a balance,
// projects, references, favorites, trash, SAM 2.1 segments, jobs that finish when a test says so,
// assets served at `/studio/<id>/<token>` from fixture files), and
// read every command the app sent. No WebSocket library: the few frame types Relay uses are
// framed here (RFC 6455, text, ping, close).
import { createHash, createHmac, randomBytes } from 'node:crypto'
import * as fs from 'node:fs'
import * as http from 'node:http'
import type { AddressInfo } from 'node:net'
import * as path from 'node:path'
import type { Duplex } from 'node:stream'
import { z } from 'zod'
import { defaultTabs, type PinKind } from '@evaos/chat-core/artifacts'
import { pinId, splitPins } from '@evaos/chat-core/pins'
import { FIXTURES_DIR } from './paths'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

type Json = Record<string, unknown>
const JsonSchema = z.record(z.string(), z.unknown())
const DevicesSchema = z.record(z.string(), z.object({ secretHex: z.string() }).partial())

const MEDIA = path.join(FIXTURES_DIR, 'agent-widgets/media')

const resolutions = (sizes: Record<string, string>): Json[] =>
  Object.entries(sizes).map(([aspect, id]) => ({ id, label: id, aspect }))

/** A ComfyUI-style preset at one megapixel that takes `refs` images. */
const preset = (id: string, name: string, refs: number): Json => ({
  id,
  name,
  mode: 'image',
  resolutions: resolutions({ '16:9': '1mp', '9:16': '1mp', '1:1': '1mp' }),
  seconds: [],
  frames: [],
  refs,
  ...(refs > 0 ? { minRefs: refs } : {}),
})

const MOSS_RESOLUTIONS: Json[] = [
  { id: '768x1344', label: 'Portrait', aspect: '9:16' },
  { id: '1344x768', label: 'Landscape', aspect: '16:9' },
  { id: '1024x1024', label: 'Square', aspect: '1:1' },
]
const MOSS_INPUTS: Json[] = [
  {
    kind: 'choice',
    id: 'turbo',
    label: 'Turbo',
    default: 'on',
    options: [
      { id: 'on', label: 'On (about 2 min)' },
      { id: 'off', label: 'Off (50 steps, slower)' },
    ],
  },
  {
    kind: 'choice',
    id: 'enhance',
    label: 'Prompt enhancer',
    default: 'on',
    options: [
      { id: 'on', label: 'On (local Qwen3 rewrites it)' },
      { id: 'off', label: 'Off (prompt as typed)' },
    ],
  },
]

/** Studio's backends as the host lists them: local video, Codex image ones, MOSS, paid Higgsfield. */
export const STUDIO_BACKENDS: Json[] = [
  {
    id: 'ltx',
    label: 'LTX video',
    mode: 'video',
    paid: false,
    available: true,
    resolutions: resolutions({ '16:9': '768x432', '9:16': '432x768', '1:1': '512x512' }),
    seconds: [4, 5, 8],
    frames: ['start', 'mid', 'end'],
    refs: 0,
    seed: true,
    serial: true,
  },
  {
    id: 'codex-image',
    label: 'Codex image',
    mode: 'image',
    paid: false,
    available: true,
    resolutions: resolutions({ '16:9': '1536x1024', '9:16': '1024x1536', '1:1': '1024x1024' }),
    seconds: [],
    frames: [],
    refs: 0,
    seed: false,
    serial: false,
  },
  {
    id: 'codex-edit',
    label: 'Codex edit',
    mode: 'image',
    paid: false,
    available: true,
    resolutions: resolutions({ '16:9': '1536x1024', '9:16': '1024x1536', '1:1': '1024x1024' }),
    seconds: [],
    frames: [],
    refs: 4,
    seed: false,
    serial: false,
  },
  {
    id: 'moss',
    label: 'MOSS-Image',
    mode: 'image',
    paid: false,
    available: true,
    resolutions: [],
    seconds: [],
    frames: [],
    refs: 0,
    seed: true,
    serial: true,
    models: [
      {
        id: 'moss-image',
        name: 'MOSS-Image',
        mode: 'image',
        description: 'Text and layouts in the image. Local, MLX.',
        resolutions: MOSS_RESOLUTIONS,
        seconds: [],
        frames: [],
        refs: 0,
        inputs: MOSS_INPUTS,
        estimateMs: 120000,
      },
      {
        id: 'Jib_Mix_Moss_V2_H_int8',
        name: 'Jib Mix Moss',
        mode: 'image',
        description: 'Photoreal MOSS-Image fine-tune. Local, MLX.',
        resolutions: MOSS_RESOLUTIONS,
        seconds: [],
        frames: [],
        refs: 0,
        inputs: MOSS_INPUTS,
        estimateMs: 120000,
      },
    ],
  },
  {
    id: 'kontext',
    label: 'FLUX Kontext',
    mode: 'image',
    paid: false,
    available: true,
    resolutions: resolutions({ '16:9': '1024x576', '9:16': '576x1024', '1:1': '1024x1024' }),
    seconds: [],
    frames: [],
    refs: 1,
    seed: true,
    serial: true,
  },
  {
    id: 'comfyui',
    label: 'ComfyUI',
    mode: 'image',
    paid: false,
    available: true,
    resolutions: [],
    seconds: [],
    frames: [],
    refs: 4,
    seed: true,
    serial: true,
    models: [
      {
        id: 'angles',
        name: 'Angles',
        mode: 'image',
        description: 'See the same subject from another camera angle.',
        resolutions: resolutions({ '16:9': '1mp', '9:16': '1mp', '1:1': '1mp' }),
        seconds: [],
        frames: [],
        refs: 1,
        inputs: [
          {
            kind: 'choice',
            id: 'angle',
            label: 'Camera',
            default: 'left45',
            options: [
              { id: 'left45', label: '45 left' },
              { id: 'right45', label: '45 right' },
              { id: 'top', label: 'Top down' },
              { id: 'close', label: 'Close up' },
            ],
          },
          {
            kind: 'number',
            id: 'strength',
            label: 'LoRA strength',
            min: 0.5,
            max: 1.3,
            step: 0.05,
            default: 1,
          },
        ],
      },
      {
        id: 'upscale',
        name: 'Upscale (SeedVR2)',
        mode: 'image',
        description: 'Sharpen and enlarge a picture.',
        resolutions: resolutions({ '16:9': 'auto', '9:16': 'auto', '1:1': 'auto' }),
        seconds: [],
        frames: [],
        refs: 1,
        prompt: false,
        inputs: [
          {
            kind: 'choice',
            id: 'size',
            label: 'Short side',
            default: '2048',
            options: ['1536', '2048', '3072', '4096', '6144'].map((id) => ({
              id,
              label: `${id} px`,
            })),
          },
        ],
      },
      preset('qwen-edit', 'Qwen Image Edit', 1),
      {
        ...preset('relight', 'Relight', 1),
        inputs: [
          {
            kind: 'choice',
            id: 'direction',
            label: 'Light from',
            default: 'front',
            options: [
              'top-left',
              'top',
              'top-right',
              'left',
              'front',
              'right',
              'bottom-left',
              'bottom',
              'bottom-right',
            ].map((id) => ({ id, label: id })),
          },
        ],
      },
      preset('klein-create', 'FLUX.2 klein create', 0),
      preset('klein-edit', 'FLUX.2 klein edit', 1),
      preset('character', 'Character in a scene', 1),
      preset('combine', 'Combine two', 2),
    ],
  },
  {
    id: 'sam',
    label: 'SAM 2.1',
    mode: 'image',
    paid: false,
    available: true,
    resolutions: [],
    seconds: [],
    frames: [],
    refs: 1,
    seed: false,
    serial: true,
    models: [preset('cutout', 'Remove background', 1)],
  },
  {
    id: 'crop',
    label: 'Crop',
    mode: 'image',
    paid: false,
    available: true,
    resolutions: [],
    seconds: [],
    frames: [],
    refs: 1,
    seed: false,
    serial: false,
    models: [preset('crop', 'Crop', 1)],
  },
  {
    id: 'higgsfield',
    label: 'Higgsfield',
    mode: 'video',
    paid: true,
    available: true,
    resolutions: [],
    seconds: [],
    frames: [],
    refs: 0,
    seed: true,
    serial: false,
    balance: 500,
    models: [
      {
        id: 'kling-2-5',
        name: 'Kling 2.5',
        mode: 'video',
        resolutions: [
          { id: '720p', label: '720p', aspect: '16:9' },
          { id: '1080p', label: '1080p', aspect: '16:9' },
          { id: '720p', label: '720p', aspect: '9:16' },
        ],
        seconds: [5, 10],
        frames: ['start', 'end'],
      },
      {
        id: 'hailuo-02',
        name: 'Hailuo 02',
        mode: 'video',
        resolutions: [
          { id: '768p', label: '768p', aspect: '16:9' },
          { id: '768p', label: '768p', aspect: '9:16' },
        ],
        seconds: [6],
        frames: ['start'],
      },
      {
        id: 'soul',
        name: 'Higgsfield Soul',
        mode: 'image',
        resolutions: resolutions({ '16:9': '1536x864', '9:16': '864x1536', '1:1': '1024x1024' }),
        seconds: [],
        frames: [],
        refs: 0,
      },
    ],
  },
]

/** Credits per 5 s of each Higgsfield model at its base resolution (an image: per image). */
const STUDIO_PRICE: Record<string, number> = { 'kling-2-5': 40, 'hailuo-02': 25, soul: 6 }

export interface HostSession {
  id: string
  status: 'working' | 'waiting' | 'needs_permission' | 'idle' | 'ended'
  statusDetail?: string
  canRespond?: boolean
  kind?: 'manual' | 'job' | 'assistant'
  /** The registry agent an `assistant` thread belongs to. */
  assistant?: string
  title?: string
}

/** A command the app sent, with the session's status as the host had it when it arrived. */
export interface Received {
  id: string
  cmd: Json
  status: HostSession['status'] | null
}

class Peer {
  buffer = Buffer.alloc(0)
  nonce = ''
  /** The device id its `hello` named; `device` once its proof checked out. */
  hello = ''
  device: string | null = null
  subs = new Set<string>()
  constructor(readonly socket: Duplex) {}

  send(frame: Json): void {
    const body = Buffer.from(JSON.stringify(frame))
    const head =
      body.length < 126
        ? Buffer.from([0x81, body.length])
        : body.length < 65_536
          ? Buffer.from([0x81, 126, body.length >> 8, body.length & 0xff])
          : Buffer.concat([Buffer.from([0x81, 127]), u64(body.length)])
    this.socket.write(Buffer.concat([head, body]))
  }
}

function u64(n: number): Buffer {
  const b = Buffer.alloc(8)
  b.writeBigUInt64BE(BigInt(n))
  return b
}

export class FakeRelayHost {
  /** Every command, in arrival order. */
  readonly commands: Received[] = []
  /** The next command is refused with this AckError. */
  nackNext: { code: string; message: string } | null = null
  private readonly peers = new Set<Peer>()
  private readonly sessions = new Map<string, HostSession>()
  private readonly asks = new Map<string, Json>()
  private readonly approvals = new Map<string, Json>()
  /** Each thread's reactions by reaction key, as the host keeps them. */
  private readonly reactionsOf = new Map<string, Record<string, Json>>()
  /** Every `reactions.get`, `reaction.set` and `reaction.clear` the app sent, in order. */
  readonly reactionFrames: Json[] = []
  /** Every `render.failed` the app sent (media that failed to show in a bubble), in order. */
  readonly renderFailures: Json[] = []
  /** The host's canvas rooms (CanvasRoomInfo), sent on `canvas.get` and pushed on change. */
  private canvasRooms: Json[] = []
  /** The host's activity list (ActivityItem), sent on `activity.get` and pushed on change. */
  private activityItems: Json[] = []
  /** Each thread's artifact items, answered to `artifacts.get` with the default tab bar. */
  private readonly artifactItems = new Map<string, Json[]>()
  /** Every `artifacts.act` frame the app sent, in order. */
  readonly artifactActs: Json[] = []
  /** Every `canvas.open` slug the app sent, in order. */
  readonly canvasOpens: string[] = []
  /** Every room page the app loaded (path and query), in order. */
  readonly roomPages: string[] = []
  private rev = 0
  /** `welcome.state.mac.version`: what the host says it runs. */
  macVersion = '0'
  /**
   * `welcome.features`: what this host says it answers beyond the base protocol. Takes render
   * reports by default, as the current host does.
   */
  features: string[] = ['render.report']
  /** Every `files.open` path list, every `files.caret` focus and every `files.saved` the app sent, in order. */
  readonly filesOpen: string[][] = []
  readonly carets: Array<Json | null> = []
  readonly saves: Json[] = []
  /** The host's omp stats snapshot (protocol StatsSnapshot), answered to `stats.get`. */
  private statsSnapshot: Json = { updatedAt: null, refreshing: true, profiles: [], ranges: null }
  /** How many `stats.get` frames arrived. */
  statsGets = 0

  /** An agent's write to an open file, as the host's file presence reports it (`files.edit`). */
  fileEdit(edit: Json): void {
    this.broadcast({ t: 'files.edit', ...edit })
  }
  /** Studio's jobs and uploads (newest first), backends, projects and references (oldest first). */
  readonly studio: {
    jobs: Json[]
    uploads: Json[]
    backends: Json[]
    projects: Json[]
    references: Json[]
  } = {
    jobs: [],
    uploads: [],
    backends: structuredClone(STUDIO_BACKENDS),
    projects: [],
    references: [],
  }
  /** SAM 2.1 results by image asset id, as the host keeps them. */
  readonly studioSegments = new Map<string, Json>()
  /** Every `studio.req` op the app sent, in order. */
  readonly studioOps: Json[] = []
  /** How many `studio.list` frames arrived. */
  studioLists = 0
  /** What each asset path serves. */
  private readonly studioFiles = new Map<string, { body: Buffer; type: string }>()
  private studioN = 0

  /** Routes beyond the host's own: a live skill document (skill-room.ts). Each returns whether it took the request. */
  readonly extra: {
    http?: (req: http.IncomingMessage, res: http.ServerResponse) => boolean
    upgrade?: (req: http.IncomingMessage, socket: Duplex) => boolean
  } = {}

  private constructor(
    readonly dir: string,
    private readonly server: http.Server,
  ) {}

  /** Listens on a free port and writes `<dir>/serve.json` like the real host. */
  static async start(dir: string): Promise<FakeRelayHost> {
    fs.mkdirSync(dir, { recursive: true })
    const server = http.createServer((req, res) => host.http(req, res))
    const host = new FakeRelayHost(dir, server)
    server.on('upgrade', (req, socket) => host.upgrade(req, socket))
    const { promise, resolve } = Promise.withResolvers<void>()
    server.listen(0, '127.0.0.1', resolve)
    await promise
    // Listening on a TCP port, so the address is an AddressInfo (a string only for pipes).
    const address = server.address() as AddressInfo
    const { port } = address
    fs.writeFileSync(path.join(dir, 'serve.json'), JSON.stringify({ port, pid: process.pid }))
    return host
  }

  async close(): Promise<void> {
    for (const p of this.peers) p.socket.destroy()
    const { promise, resolve } = Promise.withResolvers<void>()
    this.server.close(() => resolve())
    await promise
  }

  /** The dashboards a `board.subscribe` or `board.get` gets, as one `board.snapshot`. */
  private boards: Json[] = []

  /** Sets the dashboards and pushes them to every device as a fresh snapshot. */
  setBoards(boards: Json[]): void {
    this.boards = boards
    this.broadcast({ t: 'board.snapshot', rev: 1, boards })
  }

  /** Sets the canvas rooms and pushes them to every device, as the host does on any change. */
  setCanvasRooms(rooms: Json[]): void {
    this.canvasRooms = rooms
    this.broadcast({ t: 'canvas.rooms', rev: Date.now(), rooms })
  }

  /** Sets the activity list and pushes it to every device, as the host does on any change. */
  setActivity(items: Json[]): void {
    this.activityItems = items
    this.broadcast({ t: 'activity.snapshot', items })
  }

  /** Sets the stats snapshot and pushes it, as the host does when a refresh starts or ends. */
  setStats(stats: Json): void {
    this.statsSnapshot = stats
    this.broadcast({ t: 'stats.snapshot', stats })
  }

  /** Sets what `thread` holds (its artifact items; the tab bar is the default one) and pushes it. */
  setArtifacts(thread: string, items: Json[]): void {
    this.artifactItems.set(thread, items)
    this.broadcast({ t: 'artifacts.snapshot', thread, items, tabs: defaultTabs() })
  }

  /** Serves `body` at `pathname` (a drop, `/drops/<id>/<token>`), as the host serves shared files. */
  serveFile(pathname: string, body: Buffer, type: string): void {
    this.studioFiles.set(pathname, { body, type })
  }

  /** A new asset served from `body`, as the host keeps outputs and uploads. */
  private studioAsset(
    kind: 'image' | 'video',
    origin: 'output' | 'upload',
    body: Buffer,
    type: string,
  ): Json {
    this.studioN += 1
    const id = `asset-${this.studioN}`
    const assetPath = `/studio/${id}/token-${this.studioN}`
    this.studioFiles.set(assetPath, { body, type })
    this.studioFiles.set(`${assetPath}/thumb`, {
      body:
        kind === 'video' || !type.startsWith('image/')
          ? fs.readFileSync(path.join(MEDIA, 'gallery-2.jpg'))
          : body,
      type: 'image/jpeg',
    })
    return {
      id,
      kind,
      mimeType: type,
      width: 1536,
      height: 1024,
      ...(kind === 'video' ? { durationMs: 5000 } : {}),
      size: body.length,
      path: assetPath,
      thumb: `${assetPath}/thumb`,
      origin,
      createdAt: Date.now(),
    }
  }

  private studioOutput(kind: 'image' | 'video'): Json {
    return kind === 'video'
      ? this.studioAsset(
          'video',
          'output',
          fs.readFileSync(path.join(MEDIA, 'clip.webm')),
          'video/webm',
        )
      : this.studioAsset(
          'image',
          'output',
          fs.readFileSync(path.join(MEDIA, `gallery-${(this.studioN % 3) + 1}.jpg`)),
          'image/jpeg',
        )
  }

  /**
   * A finished job with one output, as if it ran earlier (the library before the test); `extra`
   * gives it lineage, a project or a favorite.
   */
  addStudioJob(
    spec: Json,
    origin = 'desktop',
    extra: { parent?: Json; project?: string; favorite?: boolean } = {},
  ): Json {
    this.studioN += 1
    const output = this.studioOutput(spec.mode === 'video' ? 'video' : 'image')
    if (extra.favorite) output.favorite = true
    const job = {
      id: `job-${this.studioN}`,
      spec,
      state: 'done',
      origin,
      createdAt: Date.now() - 60_000 + this.studioN,
      finishedAt: Date.now(),
      progress: 1,
      seed: 4242,
      outputs: [{ ...output, createdAt: Date.now() - 60_000 + this.studioN }],
      ...(extra.parent ? { parent: extra.parent } : {}),
      ...(extra.project ? { project: extra.project } : {}),
    }
    this.studio.jobs.unshift(job)
    this.broadcast({ t: 'studio.job', job })
    return job
  }

  /** A project, as if made earlier; pushed as `studio.library`. */
  addStudioProject(name: string): Json {
    this.studioN += 1
    const project = { id: `project-${this.studioN}`, name, createdAt: Date.now() }
    this.studio.projects.push(project)
    this.broadcastLibrary()
    return project
  }

  private broadcastLibrary(): void {
    this.broadcast({
      t: 'studio.library',
      projects: this.studio.projects,
      references: this.studio.references,
    })
  }

  /** Every live output asset by id, with its job. */
  private studioOutputs(ids: unknown): Array<{ job: Json; asset: Json }> {
    const want = new Set(z.array(z.string()).parse(ids))
    const out: Array<{ job: Json; asset: Json }> = []
    for (const job of this.studio.jobs) {
      // The live objects (a zod parse would copy them), so a favorite or trash sticks.
      for (const asset of job.outputs as Json[]) {
        if (want.has(String(asset.id))) out.push({ job, asset })
      }
    }
    return out
  }

  /** Three SAM 2.1 objects for an image, their masks and cut-outs served from fixture images. */
  private studioSegmentsOf(asset: string): Json {
    const labels = ['Subject', 'Background', 'Sky']
    const boxes = [
      [0.3, 0.2, 0.4, 0.7],
      [0, 0.4, 1, 0.6],
      [0, 0, 1, 0.35],
    ]
    const segments = labels.map((label, i) => {
      const base = `/studio/seg-${asset}-${i + 1}/token-seg`
      const body = fs.readFileSync(path.join(MEDIA, `gallery-${i + 1}.jpg`))
      this.studioFiles.set(base, { body, type: 'image/jpeg' })
      this.studioFiles.set(`${base}/thumb`, { body, type: 'image/jpeg' })
      return {
        id: `seg-${i + 1}`,
        label,
        box: boxes[i],
        area: i === 0 ? 0.28 : i === 1 ? 0.6 : 0.35,
        mask: base,
        thumb: `${base}/thumb`,
      }
    })
    return { asset, state: 'done', segments }
  }

  /** Finishes a running job (`id`, else the oldest still going) with one output. */
  finishStudio(id?: string): Json {
    const job = id
      ? this.studio.jobs.find((j) => j.id === id)
      : this.studio.jobs.findLast((j) => j.state === 'queued' || j.state === 'running')
    if (!job) throw new Error(`No Studio job to finish${id ? `: ${id}` : ''}`)
    const spec = JsonSchema.parse(job.spec)
    Object.assign(job, {
      state: 'done',
      progress: 1,
      etaMs: undefined,
      note: undefined,
      finishedAt: Date.now(),
      seed: 4242,
      outputs: [this.studioOutput(spec.mode === 'video' ? 'video' : 'image')],
    })
    this.broadcast({ t: 'studio.job', job })
    return job
  }

  private studioPrice(spec: Json): number {
    const base = STUDIO_PRICE[String(spec.model)] ?? 50
    const seconds = typeof spec.seconds === 'number' ? spec.seconds : 5
    return Math.round((base * seconds * (spec.resolution === '1080p' ? 1.5 : 1)) / 5)
  }

  private studioState(): Json {
    return { t: 'studio.state', ...this.studio }
  }

  /**
   * Meetings (relay packages/protocol/src/meetings.ts): the recordings `meetings.list` answers and
   * each one's live lines, answered to an `open` op. Add 'meetings' to `features` to turn it on.
   */
  readonly meetings: { recordings: Json[]; lines: Map<string, Json[]>; notes: Map<string, Json> } =
    { recordings: [], lines: new Map(), notes: new Map() }
  /** Every `meetings.req` op the app sent, in order. */
  readonly meetingOps: Json[] = []

  /** A recording started, moved stage or changed chat: the host's `meeting.recording` push. */
  meetingRecording(recording: Json): void {
    const id = String(recording.id)
    this.meetings.recordings = [recording, ...this.meetings.recordings.filter((r) => r.id !== id)]
    this.broadcast({ t: 'meeting.recording', recording })
  }

  /** Transcript lines a recording added or replaced: the host's `meeting.live` push. */
  meetingLive(id: string, upsert: Json[]): void {
    const have = this.meetings.lines.get(id) ?? []
    const ids = new Set(upsert.map((l) => l.id))
    this.meetings.lines.set(id, [...have.filter((l) => !ids.has(l.id)), ...upsert])
    this.broadcast({ t: 'meeting.live', id, upsert })
  }

  private meetingsReq(peer: Peer, rid: string, op: Json): void {
    this.meetingOps.push(op)
    const id = String(op.id)
    const recording = this.meetings.recordings.find((r) => r.id === id)
    if (op.kind !== 'open' || recording === undefined)
      return peer.send({ t: 'meetings.res', rid, ok: false, error: 'Not in this fake' })
    peer.send({
      t: 'meetings.res',
      rid,
      ok: true,
      snapshot: {
        recording,
        lines: this.meetings.lines.get(id) ?? [],
        astra: null,
        notes: this.meetings.notes.get(id) ?? null,
      },
    })
  }

  private studioReq(peer: Peer, rid: string, op: Json): void {
    this.studioOps.push(op)
    const answer = (a: Json): void => peer.send({ t: 'studio.res', rid, ...a })
    const higgsfield = this.studio.backends.find((b) => b.id === 'higgsfield')!
    switch (op.kind) {
      case 'quote': {
        const spec = JsonSchema.parse(op.spec)
        return answer({ ok: true, credits: this.studioPrice(spec), balance: higgsfield.balance })
      }
      case 'create': {
        const spec = JsonSchema.parse(op.spec)
        const backend = this.studio.backends.find((b) => b.id === spec.backend)
        if (!backend) return answer({ ok: false, error: `No backend ${String(spec.backend)}` })
        if (backend.paid) {
          if (op.origin === 'agent') {
            return answer({ ok: false, error: 'Paid jobs need Isaac to confirm them in Studio.' })
          }
          const price = this.studioPrice(spec)
          if (typeof spec.confirmCredits !== 'number' || spec.confirmCredits < price) {
            return answer({
              ok: false,
              error: `This job costs ${price} credits; confirm it first.`,
            })
          }
          higgsfield.balance = Number(higgsfield.balance) - price
        }
        const count = typeof op.count === 'number' ? op.count : 1
        const batch = `batch-${this.studioN + 1}`
        const jobs: Json[] = []
        for (let index = 0; index < count; index++) {
          this.studioN += 1
          jobs.push({
            id: `job-${this.studioN}`,
            spec: typeof spec.seed === 'number' ? { ...spec, seed: spec.seed + index } : spec,
            state: 'queued',
            origin: op.origin,
            createdAt: Date.now() + index,
            progress: 0,
            etaMs: 30_000,
            note: 'Waiting for the GPU',
            ...(backend.paid ? { credits: spec.confirmCredits } : {}),
            ...(typeof op.project === 'string' ? { project: op.project } : {}),
            ...(op.parent ? { parent: op.parent } : {}),
            ...(count > 1 ? { batch: { id: batch, index, count } } : {}),
            outputs: [],
          })
        }
        this.studio.jobs.unshift(...[...jobs].reverse())
        // As the real host: each job is broadcast as it is saved, then the answer goes out, so an
        // agent's studio.open after studio.generate finds the job already in the page's view.
        for (const job of jobs) this.broadcast({ t: 'studio.job', job })
        answer({ ok: true, job: jobs[0], jobs })
        const first = jobs[0]!
        setTimeout(() => {
          if (first.state !== 'queued') return
          Object.assign(first, {
            state: 'running',
            startedAt: Date.now(),
            progress: 0.4,
            etaMs: 20_000,
            note: 'Step 2 of 4',
          })
          this.broadcast({ t: 'studio.job', job: first })
        }, 150)
        return
      }
      case 'cancel': {
        const job = this.studio.jobs.find((j) => j.id === op.id)
        if (!job) return answer({ ok: false, error: 'No such job.' })
        Object.assign(job, { state: 'cancelled', etaMs: undefined })
        answer({ ok: true, job })
        return this.broadcast({ t: 'studio.job', job })
      }
      case 'delete': {
        const before = this.studio.jobs.length + this.studio.uploads.length
        this.studio.jobs = this.studio.jobs.filter((j) => j.id !== op.id)
        this.studio.uploads = this.studio.uploads.filter((u) => u.id !== op.id)
        if (before === this.studio.jobs.length + this.studio.uploads.length) {
          return answer({ ok: false, error: 'Nothing to delete.' })
        }
        answer({ ok: true })
        return this.broadcast({ t: 'studio.removed', id: op.id })
      }
      case 'upload': {
        const image = z.object({ mimeType: z.string(), data: z.string() }).parse(op.image)
        const asset = this.studioAsset(
          'image',
          'upload',
          Buffer.from(image.data, 'base64'),
          image.mimeType,
        )
        this.studio.uploads.unshift(asset)
        answer({ ok: true, asset })
        return this.broadcast(this.studioState())
      }
      case 'frame': {
        const asset = this.studioAsset(
          'image',
          'upload',
          fs.readFileSync(path.join(MEDIA, 'gallery-3.jpg')),
          'image/jpeg',
        )
        this.studio.uploads.unshift(asset)
        answer({ ok: true, asset })
        return this.broadcast(this.studioState())
      }
      case 'refresh':
        answer({ ok: true })
        return this.broadcast(this.studioState())
      case 'favorite':
      case 'trash':
      case 'restore': {
        const hits = this.studioOutputs(op.assets)
        if (hits.length === 0) return answer({ ok: false, error: 'No such image.' })
        for (const { asset } of hits) {
          if (op.kind === 'favorite') asset.favorite = op.value === true
          else if (op.kind === 'trash') asset.deletedAt = Date.now()
          else delete asset.deletedAt
        }
        answer({ ok: true })
        for (const job of new Set(hits.map((h) => h.job))) this.broadcast({ t: 'studio.job', job })
        return
      }
      case 'move': {
        const hits = this.studioOutputs(op.assets)
        if (hits.length === 0) return answer({ ok: false, error: 'No such image.' })
        for (const job of new Set(hits.map((h) => h.job))) {
          if (op.project === 'unsorted') delete job.project
          else job.project = op.project
          this.broadcast({ t: 'studio.job', job })
        }
        return answer({ ok: true })
      }
      case 'project.create': {
        this.studioN += 1
        const project = {
          id: typeof op.id === 'string' ? op.id : `project-${this.studioN}`,
          name: String(op.name).trim(),
          createdAt: Date.now(),
        }
        this.studio.projects.push(project)
        answer({ ok: true, project })
        return this.broadcastLibrary()
      }
      case 'project.rename': {
        const project = this.studio.projects.find((p) => p.id === op.id)
        if (!project) return answer({ ok: false, error: 'No such project.' })
        project.name = String(op.name).trim()
        answer({ ok: true, project })
        return this.broadcastLibrary()
      }
      case 'project.delete': {
        const before = this.studio.projects.length
        this.studio.projects = this.studio.projects.filter((p) => p.id !== op.id)
        if (before === this.studio.projects.length) {
          return answer({ ok: false, error: 'No such project.' })
        }
        for (const job of this.studio.jobs) {
          if (job.project !== op.id) continue
          delete job.project
          this.broadcast({ t: 'studio.job', job })
        }
        answer({ ok: true })
        return this.broadcastLibrary()
      }
      case 'reference.create': {
        const [hit] = this.studioOutputs([op.asset])
        if (!hit) return answer({ ok: false, error: 'No such image.' })
        const copy = this.studioAsset(
          'image',
          'upload',
          this.studioFiles.get(String(hit.asset.path))!.body,
          String(hit.asset.mimeType),
        )
        const reference = {
          id: `ref-${this.studioN}`,
          kind: op.referenceKind,
          name: String(op.name).trim(),
          asset: copy,
          createdAt: Date.now(),
        }
        this.studio.references.push(reference)
        answer({ ok: true, reference })
        return this.broadcastLibrary()
      }
      case 'reference.delete': {
        this.studio.references = this.studio.references.filter((r) => r.id !== op.id)
        answer({ ok: true })
        return this.broadcastLibrary()
      }
      case 'segment': {
        const asset = String(op.asset)
        const known = this.studioSegments.get(asset)
        if (known) return answer({ ok: true, segments: known })
        answer({ ok: true, segments: { asset, state: 'queued', segments: [] } })
        const done = this.studioSegmentsOf(asset)
        this.studioSegments.set(asset, done)
        return this.broadcast({ t: 'studio.segments', ...done })
      }
      default:
        return answer({ ok: false, error: `Unknown op ${String(op.kind)}` })
    }
  }

  /**
   * Studio's assets at their `/studio/...` paths, and a room page like the host's web client in
   * miniature: it names its board and says it is ready.
   */
  private http(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (this.extra.http?.(req, res)) return
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const asset =
      req.method === 'GET' || req.method === 'HEAD' ? this.studioFiles.get(url.pathname) : undefined
    if (asset) {
      res.writeHead(200, { 'content-type': asset.type, 'content-length': asset.body.length })
      res.end(req.method === 'HEAD' ? undefined : asset.body)
      return
    }
    const slug = /^\/canvas\/([a-z0-9-]+)\/$/.exec(url.pathname)?.[1]
    if (req.method !== 'GET' || !slug || url.searchParams.get('token') !== `fake-${slug}`) {
      res.writeHead(404).end()
      return
    }
    this.roomPages.push(`${url.pathname}${url.search}`)
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(
      `<!doctype html><html><body><h1 data-testid="fake-room">Room ${slug}</h1>` +
        `<script>window.parent.postMessage({ type: 'canvas.ready' }, '*')</script></body></html>`,
    )
  }

  /** Lists (or updates) sessions, as an `agents.delta`. */
  upsert(...sessions: HostSession[]): void {
    for (const s of sessions) this.sessions.set(s.id, { ...this.sessions.get(s.id), ...s })
    this.rev += 1
    this.broadcast({
      t: 'agents.delta',
      rev: this.rev,
      upsert: sessions.map((s) => this.wire(s.id)),
    })
  }

  /** The app is subscribed to this session's stream. */
  subscribed(sessionId: string): boolean {
    return [...this.peers].some((p) => p.subs.has(sessionId))
  }

  /** The text so far of a reply the session streams. */
  stream(sessionId: string, id: string, text: string, streaming: boolean): void {
    this.toSubscribers(sessionId, { t: 'agent.message.update', sessionId, id, text, streaming })
  }

  ask(sessionId: string, ask: Json): void {
    this.asks.set(sessionId, ask)
    this.toSubscribers(sessionId, { t: 'agent.ask', sessionId, ask })
  }

  approval(sessionId: string, approval: Json): void {
    this.approvals.set(sessionId, approval)
    this.toSubscribers(sessionId, { t: 'agent.approval', sessionId, approval })
  }

  /**
   * The replies the app sent, and how omp's bridge takes each: `sendUserMessage` prompts an idle
   * session and steers one that is replying (relay-bridge.ts, `case "reply"`).
   */
  replies(): Array<{ session: string; text: string; mode: 'prompt' | 'steer'; images: number }> {
    return this.commands
      .filter((c) => c.cmd.kind === 'agent.reply')
      .map((c) => ({
        session: String(c.cmd.sessionId),
        text: String(c.cmd.text),
        mode: c.status === 'working' ? 'steer' : 'prompt',
        images: Array.isArray(c.cmd.images) ? c.cmd.images.length : 0,
      }))
  }

  kinds(): string[] {
    return this.commands.map((c) => String(c.cmd.kind))
  }

  /**
   * Sets a thread's reactions, by reaction key then reactor (`isaac` or an assistant's id), as the
   * phone or an assistant would, and pushes its snapshot to every device.
   */
  setReactions(thread: string, reactions: Record<string, Json>): void {
    this.reactionsOf.set(thread, reactions)
    this.broadcast(this.snapshotOf(thread))
  }

  /** Each assistant thread's open asks, as the host keeps them (`assistant.snapshot`'s `asks`); absent: a host that predates them. */
  private readonly openAsksOf = new Map<string, Json[]>()
  /** Every `assistant.get` the app sent, by agent. */
  readonly assistantGets: string[] = []

  /** Sets `agent`'s open asks and pushes the thread's snapshot to every device, as the host does when one opens or closes. */
  setAsks(agent: string, asks: Json[]): void {
    this.openAsksOf.set(agent, asks)
    this.broadcast(this.assistantSnapshot(agent))
  }

  /** The open asks the host holds for `agent`. */
  openAsks(agent: string): Json[] {
    return this.openAsksOf.get(agent) ?? []
  }

  private assistantSnapshot(agent: string): Json {
    return {
      t: 'assistant.snapshot',
      agent,
      snapshot: {
        rev: 1,
        messages: [],
        busy: false,
        sessionId: '',
        ...(this.openAsksOf.has(agent) ? { asks: this.openAsksOf.get(agent) } : {}),
      },
    }
  }

  /** Each thread's bookmarked turns, as a host with the "bookmarks" feature keeps them. */
  private readonly bookmarksOf = new Map<string, string[]>()
  /** Every `bookmarks.get` and `bookmark.set` the app sent, in order. */
  readonly bookmarkFrames: Json[] = []

  /** Sets a thread's bookmarked turns (as the phone would) and pushes the snapshot to every device. */
  setBookmarks(thread: string, messages: string[]): void {
    this.bookmarksOf.set(thread, messages)
    this.broadcast(this.bookmarksSnapshot(thread))
  }

  /** The thread's bookmarks as the host last held them. */
  bookmarks(thread: string): string[] {
    return this.bookmarksOf.get(thread) ?? []
  }

  private bookmarksSnapshot(thread: string): Json {
    return { t: 'bookmarks.snapshot', thread, messages: this.bookmarks(thread) }
  }

  private snapshotOf(thread: string): Json {
    return { t: 'reactions.snapshot', thread, reactions: this.reactionsOf.get(thread) ?? {} }
  }

  private wire(id: string): Json {
    const s = this.sessions.get(id)!
    return {
      id,
      provider: 'omp',
      // Like omp's bridge: an unnamed session goes by its folder's name.
      title: s.title ?? 'eva-root',
      projectPath: '/fixture/eva-root',
      status: s.status,
      ...(s.statusDetail ? { statusDetail: s.statusDetail } : {}),
      lastActivity: '',
      lastActivityAt: Date.now(),
      canRespond: s.canRespond ?? true,
      kind: s.kind ?? 'manual',
      ...(s.assistant ? { assistant: s.assistant } : {}),
    }
  }

  private broadcast(frame: Json): void {
    for (const p of this.peers) if (p.device) p.send(frame)
  }

  /**
   * The pin actions of `artifacts.act` as the host applies them: `pin.add` (the same kind and value
   * is one pin), `pin.remove` and `pin` on or off. Pushes the thread's snapshot. Tests call it for
   * an agent's pin (`by` its id); the app's own frames come through the `artifacts.act` case.
   */
  actArtifacts(thread: string, by: string, action: Json): { ok: boolean; id?: string } {
    let items = [...(this.artifactItems.get(thread) ?? [])]
    let id: string | undefined
    if (action.op === 'pin.add') {
      const kind = z.string().parse(action.kind)
      const value = z.string().parse(action.value)
      const label = z.string().parse(action.label)
      id = pinId(kind as PinKind, value)
      if (!items.some((i) => i.id === id)) {
        const source = typeof action.source === 'string' ? action.source : undefined
        items.unshift({
          id,
          kind: 'pin',
          title: label,
          pin: { kind, label, value, ...(source === undefined ? {} : { source }) },
          mentions: 0,
          firstSeen: Date.now(),
          lastSeen: Date.now(),
          sources: source === undefined ? [] : [source],
          addedBy: by,
          pinned: { by, at: Date.now() },
        })
      }
    } else if (action.op === 'pin.remove' || (action.op === 'pin' && action.pinned === false)) {
      items = items.flatMap((i) =>
        i.id !== action.id ? [i] : i.kind === 'pin' ? [] : [{ ...i, pinned: undefined }],
      )
    } else if (action.op === 'pin') {
      items = items.map((i) => (i.id === action.id ? { ...i, pinned: { by, at: Date.now() } } : i))
    }
    this.setArtifacts(thread, items)
    return { ok: true, ...(id === undefined ? {} : { id }) }
  }

  /**
   * What the host's transcript reader does with a reply's `[[pin: label | value]]` lines: each
   * assistant message's lines become pins by `by`, pinned at the message's time, once, with the
   * message's bubble key as their source. (The real reader is apps/linux src/artifacts; its own
   * tests cover it.) Returns how many pins were made.
   */
  pinsFromTranscript(thread: string, file: string, by: string): number {
    let made = 0
    for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
      if (raw.trim() === '') continue
      const entry = JsonSchema.safeParse(JSON.parse(raw))
      const message = entry.success ? JsonSchema.safeParse(entry.data.message) : null
      if (!message?.success || message.data.role !== 'assistant') continue
      const at = z.number().safeParse(message.data.timestamp)
      const parts = z
        .array(z.object({ type: z.string(), text: z.string().optional() }))
        .safeParse(message.data.content)
      if (!at.success || !parts.success) continue
      for (const part of parts.data) {
        for (const pin of splitPins(part.text ?? '').pins) {
          const id = pinId(pin.kind, pin.value)
          const held = this.artifactItems.get(thread) ?? []
          if (held.some((i) => i.id === id)) continue
          const source = `assistant@${Math.trunc(at.data)}`
          this.artifactItems.set(thread, [
            {
              id,
              kind: 'pin',
              title: pin.label,
              pin: { ...pin, source },
              mentions: 0,
              firstSeen: at.data,
              lastSeen: at.data,
              sources: [source],
              addedBy: by,
              pinned: { by, at: at.data },
            },
            ...held,
          ])
          made++
        }
      }
    }
    this.setArtifacts(thread, this.artifactItems.get(thread) ?? [])
    return made
  }

  private toSubscribers(sessionId: string, frame: Json): void {
    for (const p of this.peers) if (p.subs.has(sessionId)) p.send(frame)
  }

  private upgrade(req: http.IncomingMessage, socket: Duplex): void {
    if (this.extra.upgrade?.(req, socket)) return
    const key = req.headers['sec-websocket-key']
    if (req.url !== '/relay' || typeof key !== 'string') {
      socket.destroy()
      return
    }
    const accept = createHash('sha1')
      .update(key + GUID)
      .digest('base64')
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    )
    const peer = new Peer(socket)
    this.peers.add(peer)
    socket.on('data', (chunk: Buffer) => this.read(peer, chunk))
    socket.on('close', () => this.peers.delete(peer))
    socket.on('error', () => this.peers.delete(peer))
  }

  /** Unmasks every whole client frame in the buffer. */
  private read(peer: Peer, chunk: Buffer): void {
    peer.buffer = Buffer.concat([peer.buffer, chunk])
    for (;;) {
      const b = peer.buffer
      if (b.length < 2) return
      const opcode = b[0]! & 0x0f
      let len = b[1]! & 0x7f
      let at = 2
      if (len === 126) {
        if (b.length < 4) return
        len = b.readUInt16BE(2)
        at = 4
      } else if (len === 127) {
        if (b.length < 10) return
        len = Number(b.readBigUInt64BE(2))
        at = 10
      }
      if (b.length < at + 4 + len) return
      const mask = b.subarray(at, at + 4)
      const body = Buffer.from(b.subarray(at + 4, at + 4 + len))
      for (let i = 0; i < body.length; i++) body[i]! ^= mask[i % 4]!
      peer.buffer = b.subarray(at + 4 + len)
      if (opcode === 0x1) this.receive(peer, JsonSchema.parse(JSON.parse(body.toString('utf8'))))
      else if (opcode === 0x8) peer.socket.end(Buffer.from([0x88, 0]))
      else if (opcode === 0x9)
        peer.socket.write(Buffer.concat([Buffer.from([0x8a, body.length]), body]))
    }
  }

  private receive(peer: Peer, f: Json): void {
    switch (f.t) {
      case 'hello':
        peer.nonce = randomBytes(16).toString('hex')
        peer.device = null
        peer.send({ t: 'challenge', nonce: peer.nonce })
        peer.hello = String(f.deviceId)
        return
      case 'auth': {
        const id = peer.hello
        const secret = this.secretOf(id)
        if (secret === null) return peer.send({ t: 'unpaired' })
        const proof = createHmac('sha256', secret).update(peer.nonce).digest('hex')
        if (proof !== f.proof)
          return peer.send({ t: 'error', code: 'auth_failed', message: 'bad proof' })
        peer.device = id
        peer.send({
          t: 'welcome',
          state: {
            mac: {
              name: 'Fake Mac',
              version: this.macVersion,
              accessibilityGranted: false,
              agentsAvailable: true,
            },
            agents: { rev: this.rev, sessions: [...this.sessions.keys()].map((s) => this.wire(s)) },
          },
          ...(this.features.length > 0 ? { features: this.features } : {}),
        })
        return
      }
      case 'ping':
        return peer.send({ t: 'pong', ts: f.ts, serverTs: Date.now() })
      case 'agents.get':
        return peer.send({
          t: 'agents.snapshot',
          rev: this.rev,
          sessions: [...this.sessions.keys()].map((s) => this.wire(s)),
        })
      case 'assistant.get':
        this.assistantGets.push(String(f.agent))
        return peer.send(this.assistantSnapshot(String(f.agent)))
      case 'reactions.get':
        this.reactionFrames.push(f)
        return peer.send(this.snapshotOf(String(f.thread)))
      case 'render.failed':
        // Fire and forget: the real host logs it and tells the owning agent; no answer.
        this.renderFailures.push(f)
        return
      case 'bookmarks.get':
        this.bookmarkFrames.push(f)
        return peer.send(this.bookmarksSnapshot(String(f.thread)))
      case 'bookmark.set': {
        this.bookmarkFrames.push(f)
        const thread = String(f.thread)
        const message = String(f.message)
        const have = this.bookmarksOf.get(thread) ?? []
        if (have.includes(message) === (f.on === true))
          return peer.send(this.bookmarksSnapshot(thread))
        return this.setBookmarks(
          thread,
          f.on === true ? [...have, message] : have.filter((k) => k !== message),
        )
      }
      case 'board.subscribe':
      case 'board.get':
        return peer.send({ t: 'board.snapshot', rev: 1, boards: this.boards })
      case 'canvas.get':
        return peer.send({ t: 'canvas.rooms', rev: 1, rooms: this.canvasRooms })
      case 'activity.get':
        return peer.send({ t: 'activity.snapshot', items: this.activityItems })
      case 'stats.get':
        this.statsGets++
        return peer.send({ t: 'stats.snapshot', stats: this.statsSnapshot })
      case 'artifacts.get':
        return peer.send({
          t: 'artifacts.snapshot',
          thread: String(f.thread),
          items: this.artifactItems.get(String(f.thread)) ?? [],
          tabs: defaultTabs(),
        })
      case 'artifacts.act': {
        this.artifactActs.push(f)
        const done = this.actArtifacts(String(f.thread), String(f.by), JsonSchema.parse(f.action))
        return peer.send({ t: 'artifacts.acted', rid: f.rid, ...done })
      }
      case 'canvas.open': {
        const slug = String(f.slug)
        this.canvasOpens.push(slug)
        const live = this.canvasRooms.some((r) => r.slug === slug && r.live === true)
        return peer.send(
          live
            ? {
                t: 'canvas.access',
                slug,
                path: `/canvas/${slug}/?token=fake-${slug}`,
                token: `fake-${slug}`,
                expiresAt: Date.now() + 3_600_000,
              }
            : { t: 'canvas.unavailable', slug, reason: 'The canvas session ended.' },
        )
      }
      case 'reaction.set':
      case 'reaction.clear': {
        // A client's frames are always Isaac's; an assistant's reactions stay.
        this.reactionFrames.push(f)
        const thread = String(f.thread)
        const message = String(f.message)
        const { [message]: bubble, ...rest } = this.reactionsOf.get(thread) ?? {}
        const { isaac: _old, ...others } = bubble ?? {}
        const mine =
          f.t === 'reaction.set'
            ? { ...others, isaac: { emoji: f.emoji, excerpt: f.excerpt, at: Date.now() } }
            : others
        return this.setReactions(
          thread,
          Object.keys(mine).length > 0 ? { ...rest, [message]: mine } : rest,
        )
      }
      case 'agent.subscribe': {
        const id = String(f.sessionId)
        peer.subs.add(id)
        peer.send({ t: 'agent.conversation', sessionId: id, rev: 0, messages: [] })
        // Like the host's replayPending: what the session is blocked on right now.
        const ask = this.asks.get(id)
        if (ask) peer.send({ t: 'agent.ask', sessionId: id, ask })
        const approval = this.approvals.get(id)
        if (approval) peer.send({ t: 'agent.approval', sessionId: id, approval })
        return
      }
      case 'agent.unsubscribe':
        peer.subs.delete(String(f.sessionId))
        return
      case 'files.open':
        this.filesOpen.push(z.array(z.string()).parse(f.paths))
        return peer.send({ t: 'files.presence', focus: [] })
      case 'files.caret':
        this.carets.push(f.focus === null ? null : JsonSchema.parse(f.focus))
        return
      case 'files.saved':
        this.saves.push(f)
        return
      case 'studio.list':
        this.studioLists += 1
        return peer.send(this.studioState())
      case 'meetings.list':
        return peer.send({
          t: 'meetings.state',
          now: Date.now(),
          meetings: [],
          recordings: this.meetings.recordings,
          digest: { recentCount: 0, waiting: [], out: [], decisions: [] },
        })
      case 'meetings.req':
        return this.meetingsReq(peer, String(f.rid), JsonSchema.parse(f.op))
      case 'studio.req':
        return this.studioReq(peer, String(f.rid), JsonSchema.parse(f.op))
      case 'cmd':
        return this.command(peer, String(f.id), JsonSchema.parse(f.cmd))
      default:
        return
    }
  }

  private command(peer: Peer, id: string, cmd: Json): void {
    const session = String(cmd.sessionId)
    if (cmd.kind === 'assistant.ask.resolve') {
      const agent = String(cmd.agent)
      this.commands.push({ id, cmd, status: null })
      peer.send({ t: 'ack', id })
      return this.setAsks(
        agent,
        this.openAsks(agent).filter((a) => a.id !== cmd.id),
      )
    }
    this.commands.push({ id, cmd, status: this.sessions.get(session)?.status ?? null })
    const refused = this.nackNext
    if (refused) {
      this.nackNext = null
      return peer.send({ t: 'nack', id, error: refused })
    }
    peer.send({ t: 'ack', id })
    const ask = this.asks.get(session)
    if ((cmd.kind === 'agent.ask.answer' || cmd.kind === 'agent.ask.cancel') && ask) {
      this.asks.delete(session)
      this.toSubscribers(session, { t: 'agent.ask.resolved', sessionId: session, id: ask.id })
    }
    const approval = this.approvals.get(session)
    if ((cmd.kind === 'agent.approve' || cmd.kind === 'agent.deny') && approval) {
      this.approvals.delete(session)
      this.toSubscribers(session, {
        t: 'agent.approval.resolved',
        sessionId: session,
        id: approval.id,
      })
    }
  }

  /** The paired device's secret from `devices.json`, which the app writes for itself. */
  private secretOf(device: string): Buffer | null {
    try {
      const devices = DevicesSchema.parse(
        JSON.parse(fs.readFileSync(path.join(this.dir, 'devices.json'), 'utf8')),
      )
      const hex = devices[device]?.secretHex
      return hex ? Buffer.from(hex, 'hex') : null
    } catch {
      return null
    }
  }
}
