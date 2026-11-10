// Relay's agent feed, ported from the native app's relay.rs (the `Feed` half: the protocol state on
// one connection, with no socket in sight). The local Relay host hears every interactive omp
// session through its omp extension, whoever started it: a terminal, a job, herdr, the phone. This
// app connects the way Isaac's phone does and keeps the session list (each session's status, the
// tool it runs or waits on, whether it is a job), and for the sessions it subscribes to, the reply
// as it streams and the questions and approvals the session is blocked on. Commands (a reply, a
// stop, an answer) go out as `cmd` frames, each answered by one `ack` or `nack` (commands.ts).
//
// Boards (the host's dashboards) stream after `board.subscribe`: `board.snapshot` sets them all,
// `board.delta` swaps in or removes one. A thread's reactions come as `reactions.snapshot`, the
// answer to `reactions.get` and pushed after every change. A thread's artifacts come as
// `artifacts.snapshot` (pushed for every thread after each change, whoever asked) and each
// `artifacts.act` is answered by one `artifacts.acted`. Live canvas rooms come as `canvas.rooms`
// (asked for on welcome, pushed after every change); `canvas.open` is answered by `canvas.access`
// or `canvas.unavailable`. Studio sends `studio.state` (the answer to `studio.list`, pushed when
// uploads or backends change), `studio.job` for every change to a job, `studio.removed`,
// `studio.library` (projects and references), `studio.segments` (SAM 2.1 objects of one image), and
// one `studio.res` per `studio.req`. Drops, calls and the inbox escalation are not used by this app;
// their frames are ignored.
import { createHmac } from 'node:crypto'
import * as path from 'node:path'
import { z } from 'zod'
import {
  BOARD_COLUMNS,
  CanvasRoomSchema,
  StudioAssetSchema,
  StudioBackendSchema,
  StudioJobSchema,
  StudioProjectSchema,
  StudioReferenceSchema,
  StudioSegmentsSchema,
  type Board,
  type CanvasRoom,
  type StudioAnswer,
  type StudioJob,
  type StudioLibrary,
  type StudioSegments,
  type StudioState,
} from '@evaos/contract'
import {
  ReactionKeySchema,
  ReactionSchema,
  ReactionThreadSchema,
  ReactorSchema,
  type BubbleReactions,
  type ThreadReactions,
} from '@evaos/chat-core/reactions'
import {
  Artifact,
  ArtifactTab,
  ArtifactThread,
  type Artifact as ArtifactItem,
  type ArtifactTab as ArtifactTabItem,
} from '@evaos/chat-core/artifacts'
import { ActivityItem, type ActivityItem as ActivityRow } from '@evaos/chat-core/activity'

/** How this app shows up in Relay's paired devices (native uses `evaos` / `EvaOS`). */
export const DEVICE_ID = 'relay-desktop'
export const DEVICE_NAME = 'Relay Desktop'

export const RELAY_STATUSES = ['working', 'waiting', 'needs_permission', 'idle', 'ended'] as const
/** `waiting`: omp asked Isaac a question. `needs_permission`: a tool waits for approval. */
export type RelayStatus = (typeof RELAY_STATUSES)[number]

/** Who started a session, as Relay tags it: anything but a job or an assistant thread is manual. */
export type RelayKind = 'manual' | 'job' | 'assistant'

/** An omp session Relay hears from. */
export interface RelaySession {
  /** omp's session id, the end of its session file's name. */
  id: string
  status: RelayStatus
  /** The tool running or waiting for approval. */
  detail: string | null
  canRespond: boolean
  kind: RelayKind
  /** The session's title as Relay lists it, empty until omp names it. */
  title: string
  /** The registry agent's id when `kind` is `assistant`. */
  assistant: string | null
  /** What it did last, as omp words it; while `waiting`, the question it asked. */
  activity: string | null
  /** When `activity` happened (epoch ms), or null. */
  activityAt: number | null
  /** Share of the model's context window in use (0..1) when the host reports it. */
  contextUsed?: number | null
}

// Lenient like native Session::parse: only `id` and a known `status` are required; any other field
// of the wrong type reads as absent rather than dropping the session.
const optText = z.string().optional().catch(undefined)
const SessionSchema = z.object({
  id: z.string(),
  status: z.enum(RELAY_STATUSES),
  statusDetail: optText,
  canRespond: z.boolean().optional().catch(undefined),
  kind: optText,
  title: optText,
  assistant: optText,
  projectPath: optText,
  lastActivity: optText,
  lastActivityAt: z.number().finite().optional().catch(undefined),
  contextUsed: z.number().min(0).max(1).optional().catch(undefined),
})

/** One session as Relay sends it, or null when it has no id or a status this app does not know. */
export function parseSession(value: unknown): RelaySession | null {
  const r = SessionSchema.safeParse(value)
  if (!r.success) return null
  const s = r.data
  const kind = s.kind === 'job' || s.kind === 'assistant' ? s.kind : 'manual'
  // omp's bridge lists an unnamed hand-started session under its folder's name: no title yet.
  const unnamed =
    kind === 'manual' && s.projectPath !== undefined && s.title === path.basename(s.projectPath)
  return {
    id: s.id,
    status: s.status,
    detail: s.statusDetail || null,
    canRespond: s.canRespond ?? false,
    kind,
    title: unnamed ? '' : (s.title ?? ''),
    assistant: s.assistant || null,
    activity: s.lastActivity?.trim() || null,
    activityAt: s.lastActivityAt || null,
    ...(s.contextUsed === undefined ? {} : { contextUsed: s.contextUsed }),
  }
}

/** One option of a question omp's `ask` tool poses. */
export interface RelayChoice {
  label: string
  description: string | null
}

export interface RelayQuestion {
  id: string
  question: string
  header: string | null
  options: RelayChoice[]
  multi: boolean
  /** The option omp recommends. */
  recommended: number | null
}

/** Questions omp's `ask` tool is blocked on, answered from here or where the session runs. */
export interface RelayAsk {
  id: string
  questions: RelayQuestion[]
}

/** A tool call omp is blocked on until it is approved or denied. */
export interface RelayApproval {
  /** omp's tool call id, the handle `agent.approve` and `agent.deny` take. */
  id: string
  tool: string
  /** What omp's approval prompt shows, verbatim: the shell command for `bash`. */
  command: string
  reason: string | null
  /** The destructive pattern Relay matched (force push, `rm -rf`, deploy, prod write). */
  destructive: string | null
}

const filled = z
  .string()
  .optional()
  .catch(undefined)
  .transform((v) => (v ? v : null))
const ChoiceSchema = z.object({ label: z.string().min(1), description: filled })
const QuestionSchema = z.object({
  id: z.string().min(1),
  question: z.string().min(1),
  header: filled,
  // Options without a label are dropped (native Ask::parse); a question left with none is too.
  options: z
    .array(z.unknown())
    .transform((list) => list.flatMap((o) => ChoiceSchema.safeParse(o).data ?? [])),
  multi: z.boolean().optional().catch(undefined),
  recommended: z.number().int().nonnegative().optional().catch(undefined),
})
const AskSchema = z.object({ id: z.string().min(1), questions: z.array(z.unknown()) })

/** An `ask` as Relay and omp send it, or null without an id or a question that has options. */
export function parseAsk(value: unknown): RelayAsk | null {
  const r = AskSchema.safeParse(value)
  if (!r.success) return null
  const questions: RelayQuestion[] = []
  for (const raw of r.data.questions) {
    const q = QuestionSchema.safeParse(raw).data
    if (!q || q.options.length === 0) continue
    questions.push({
      id: q.id,
      question: q.question,
      header: q.header,
      options: q.options,
      multi: q.multi ?? false,
      recommended:
        q.recommended !== undefined && q.recommended < q.options.length ? q.recommended : null,
    })
  }
  return questions.length > 0 ? { id: r.data.id, questions } : null
}

const ApprovalSchema = z.object({
  id: z.string().min(1),
  toolName: z.string().min(1),
  command: z.string().catch(''),
  reason: filled,
  destructive: filled,
})

/** An `approval` as Relay sends it, or null without an id or a tool. */
export function parseApproval(value: unknown): RelayApproval | null {
  const r = ApprovalSchema.safeParse(value)
  if (!r.success) return null
  const a = r.data
  return {
    id: a.id,
    tool: a.toolName,
    command: a.command,
    reason: a.reason,
    destructive: a.destructive,
  }
}

const BoardWidgetSchema = z.object({
  id: z.string().min(1),
  span: z.number().catch(BOARD_COLUMNS).default(BOARD_COLUMNS),
  spec: z.looseObject({}),
  openui: z.string().min(1).optional().catch(undefined),
  mantine: z.string().min(1).optional().catch(undefined),
  height: z.number().int().min(40).max(1200).optional().catch(undefined),
})
const BoardSchema = z.object({
  slug: z.string().min(1),
  title: z.string().min(1),
  workspace: optText,
  icon: optText,
  widgets: z.array(z.unknown()).catch([]),
  updatedAt: z.string().catch(''),
})

/**
 * A board as Relay sends it, or null without a slug or a title. A tile without an id or a spec is
 * dropped; a span outside the grid is clamped to it (native BoardWidget::columns). A live tile
 * keeps its `openui` source next to the static `spec` the host rendered from it; a Mantine tile
 * keeps its `mantine` JSX (and `height`) next to its fallback `spec`.
 */
export function parseBoard(value: unknown): Board | null {
  const r = BoardSchema.safeParse(value)
  if (!r.success) return null
  const b = r.data
  const widgets: Board['widgets'] = []
  for (const raw of b.widgets) {
    const w = BoardWidgetSchema.safeParse(raw).data
    if (!w) continue
    const span = Math.min(BOARD_COLUMNS, Math.max(1, Math.round(w.span)))
    widgets.push({
      id: w.id,
      span,
      spec: w.spec,
      ...(w.openui === undefined ? {} : { openui: w.openui }),
      ...(w.mantine === undefined ? {} : { mantine: w.mantine }),
      ...(w.height === undefined ? {} : { height: w.height }),
    })
  }
  return {
    slug: b.slug,
    title: b.title,
    workspace: b.workspace || null,
    icon: b.icon || null,
    widgets,
    updatedAt: b.updatedAt,
  }
}

const rev = z.number().catch(0)
const list = z.array(z.unknown()).catch([])
const text = z.string().catch('')
const FrameSchema = z.looseObject({ t: z.string().catch('') })
const ChallengeSchema = z.object({ nonce: z.string().catch('') })
const PairFailedSchema = z.object({ reason: z.string().catch('unknown') })
const PairOkSchema = z.object({ secret: z.string().regex(/^[0-9a-fA-F]{64}$/) })
/** A remote host still lists this app, but its secret here is gone (config reset or moved). */
export const LOST_SECRET =
  'Relay Host knows this app but its pairing secret is missing here. Remove this device on the Relay Host to pair again.'
const AgentsSchema = z.object({ rev, sessions: list })
/** The host's name and version, `welcome.state.mac` (and `mac.state`'s `mac`). */
const HostSchema = z.object({ name: z.string().min(1), version: z.string().min(1) })
const WelcomeSchema = z.object({
  state: z
    .object({ agents: z.unknown(), mac: HostSchema.optional().catch(undefined) })
    .catch({ agents: undefined, mac: undefined }),
  features: z.array(z.string()).catch([]).default([]),
})
const MacStateSchema = z.object({ mac: HostSchema.optional().catch(undefined) })
const DeltaSchema = z.object({ rev, upsert: list, remove: list })
const ErrorSchema = z.object({ message: z.string().catch('unknown error') })
const MessageSchema = z.object({
  id: text,
  role: text,
  text,
  streaming: z.boolean().catch(false),
})
const ConversationSchema = z.object({ sessionId: text, messages: list, append: list })
const UpdateSchema = z.object({
  sessionId: text,
  id: text,
  text,
  streaming: z.boolean().catch(false),
})
const SessionFrameSchema = z.object({
  sessionId: text,
  ask: z.unknown().optional(),
  approval: z.unknown().optional(),
})
const ResolvedSchema = z.object({ sessionId: text, id: text })
const AckSchema = z.object({ id: text })
const NackSchema = z.object({
  id: text,
  error: z
    .object({ code: z.string().catch('internal'), message: z.string().catch('') })
    .catch({ code: 'internal', message: '' }),
})
const BoardSnapshotSchema = z.object({ rev, boards: list })
const BoardDeltaSchema = z.object({ rev, board: z.unknown().optional(), removed: optText })
const ReactionsSnapshotSchema = z.object({
  thread: ReactionThreadSchema,
  reactions: z.record(z.string(), z.unknown()).catch({}),
})
const BookmarksSnapshotSchema = z.object({
  thread: ReactionThreadSchema,
  messages: z.array(z.unknown()).catch([]),
})

/**
 * A thread's reactions as Relay sends them (by reaction key, then reactor); a bad key, reactor or
 * reaction is dropped, and a bubble left with none.
 */
export function parseReactions(value: Record<string, unknown>): ThreadReactions {
  const out: ThreadReactions = {}
  for (const [key, raw] of Object.entries(value)) {
    if (!ReactionKeySchema.safeParse(key).success) continue
    const byReactor = z.record(z.string(), z.unknown()).safeParse(raw)
    if (!byReactor.success) continue
    const bubble: BubbleReactions = {}
    for (const [reactor, reaction] of Object.entries(byReactor.data)) {
      const r = ReactionSchema.safeParse(reaction)
      if (r.success && ReactorSchema.safeParse(reactor).success) bubble[reactor] = r.data
    }
    if (Object.keys(bubble).length > 0) out[key] = bubble
  }
  return out
}

const ArtifactsSnapshotSchema = z.object({ thread: ArtifactThread, items: list, tabs: list })
const ActedSchema = z.object({
  rid: z.string().min(1),
  ok: z.boolean(),
  error: z.string().optional().catch(undefined),
  id: z.string().optional().catch(undefined),
})
const CanvasRoomsFrameSchema = z.object({ rev, rooms: list })
const CanvasAccessSchema = z.object({
  slug: z.string().min(1),
  path: z.string().startsWith('/'),
  token: z.string().min(1),
  expiresAt: z.number(),
})
const CanvasUnavailableSchema = z.object({ slug: z.string().min(1), reason: text })
const StudioStateFrameSchema = z.object({
  jobs: list,
  uploads: list,
  backends: list,
  projects: list,
  references: list,
})
const StudioJobFrameSchema = z.object({ job: StudioJobSchema })
const StudioRemovedSchema = z.object({ id: z.string().min(1) })
const StudioLibraryFrameSchema = z.object({ projects: list, references: list })
const StudioResSchema = z.object({
  rid: z.string().min(1),
  ok: z.boolean(),
  error: z.string().optional().catch(undefined),
  job: StudioJobSchema.optional().catch(undefined),
  jobs: z.array(StudioJobSchema).optional().catch(undefined),
  asset: StudioAssetSchema.optional().catch(undefined),
  project: StudioProjectSchema.optional().catch(undefined),
  reference: StudioReferenceSchema.optional().catch(undefined),
  segments: StudioSegmentsSchema.optional().catch(undefined),
  credits: z.number().nonnegative().optional().catch(undefined),
  balance: z.number().optional().catch(undefined),
})
const QueryResSchema = z.object({
  rid: z.string().min(1),
  ok: z.boolean(),
  data: z.unknown().optional(),
  error: z.string().optional().catch(undefined),
})

/** Projects and references as the host sends them; an entry that does not parse is dropped. */
export function parseStudioLibrary(value: {
  projects: readonly unknown[]
  references: readonly unknown[]
}): StudioLibrary {
  return {
    projects: value.projects.flatMap((raw) => StudioProjectSchema.safeParse(raw).data ?? []),
    references: value.references.flatMap((raw) => StudioReferenceSchema.safeParse(raw).data ?? []),
  }
}

/** Studio's state as the host sends it; a job, upload, backend, project or reference that does not parse is dropped. */
export function parseStudioState(value: {
  jobs: readonly unknown[]
  uploads: readonly unknown[]
  backends: readonly unknown[]
  projects: readonly unknown[]
  references: readonly unknown[]
}): StudioState {
  return {
    jobs: value.jobs.flatMap((raw) => StudioJobSchema.safeParse(raw).data ?? []),
    uploads: value.uploads.flatMap((raw) => StudioAssetSchema.safeParse(raw).data ?? []),
    backends: value.backends.flatMap((raw) => StudioBackendSchema.safeParse(raw).data ?? []),
    ...parseStudioLibrary(value),
  }
}

/** A thread's artifacts as Relay sends them; an item or tab that does not parse is dropped. */
export function parseArtifacts(
  items: readonly unknown[],
  tabs: readonly unknown[],
): { items: ArtifactItem[]; tabs: ArtifactTabItem[] } {
  return {
    items: items.flatMap((raw) => Artifact.safeParse(raw).data ?? []),
    tabs: tabs.flatMap((raw) => ArtifactTab.safeParse(raw).data ?? []),
  }
}

/** The activity list as Relay sends it; a row that does not parse is dropped. */
export function parseActivity(items: readonly unknown[]): ActivityRow[] {
  return items.flatMap((raw) => ActivityItem.safeParse(raw).data ?? [])
}

export type Frame = Record<string, unknown>

/** What the app hears from one frame. */
export type FeedEvent =
  | { kind: 'sessions'; sessions: RelaySession[] }
  /** A remote Relay Host asks for the PIN in its log (`retry` after a wrong one). */
  | { kind: 'pin'; retry: boolean }
  /** A remote Relay Host paired this app: keep `secret` for every later connection. */
  | { kind: 'paired'; secret: Uint8Array }
  /** The text so far of an assistant message in a subscribed session; final once `streaming` is false. */
  | { kind: 'stream'; session: string; id: string; text: string; streaming: boolean }
  /** A subscribed session is blocked on these questions. */
  | { kind: 'ask'; session: string; ask: RelayAsk }
  /** That ask was answered or cancelled, here or elsewhere. */
  | { kind: 'askResolved'; session: string; id: string }
  /** A subscribed session is blocked on a tool approval. */
  | { kind: 'approval'; session: string; approval: RelayApproval }
  /** That approval was approved or denied, here, on the phone or at the terminal. */
  | { kind: 'approvalResolved'; session: string; id: string }
  /** Relay carried out command `id`. */
  | { kind: 'ack'; id: string }
  /** Relay refused command `id`, and why. */
  | { kind: 'nack'; id: string; code: string; message: string }
  /** Every board Relay holds, by title, after any change. */
  | { kind: 'boards'; boards: Board[] }
  /** Thread `thread`'s reactions now, by reaction key (a `reactions.snapshot`). */
  | { kind: 'reactions'; thread: string; reactions: ThreadReactions }
  /** Thread `thread`'s bookmarked turns now, by reaction key (a `bookmarks.snapshot`). */
  | { kind: 'bookmarks'; thread: string; messages: string[] }
  /** Thread `thread`'s artifacts and tab bar now (an `artifacts.snapshot`, any thread). */
  | { kind: 'artifacts'; thread: string; items: ArtifactItem[]; tabs: ArtifactTabItem[] }
  /** Everything agents are running now (an `activity.snapshot`, answer or push). */
  | { kind: 'activity'; items: ActivityRow[] }
  /** The host's answer to `artifacts.act` request `rid`; `id` is a new item's or tab's. */
  | { kind: 'acted'; rid: string; ok: boolean; error?: string; id?: string }
  /** Every canvas room the host holds now (a `canvas.rooms`, answer or push); bad rooms dropped. */
  | { kind: 'canvasRooms'; rooms: CanvasRoom[] }
  /** The answer to `canvas.open`: load `path` from the host's http origin. */
  | { kind: 'canvasAccess'; slug: string; path: string; token: string; expiresAt: number }
  /** The answer to `canvas.open` when no room is live on `slug`. */
  | { kind: 'canvasUnavailable'; slug: string; reason: string }
  /** Studio's jobs, uploads, backends, projects and references now (a `studio.state`); bad entries dropped. */
  | { kind: 'studioState'; state: StudioState }
  /** One Studio job changed (created, progressed, finished). */
  | { kind: 'studioJob'; job: StudioJob }
  /** Studio's projects or references changed (a `studio.library`); bad entries dropped. */
  | { kind: 'studioLibrary'; library: StudioLibrary }
  /** SAM 2.1's objects for one image changed (a `studio.segments`). */
  | { kind: 'studioSegments'; segments: StudioSegments }
  /** A Studio job or upload was deleted. */
  | { kind: 'studioRemoved'; id: string }
  /** The host's answer to `studio.req` request `rid`. */
  | { kind: 'studioRes'; rid: string; answer: StudioAnswer }
  /** The host's answer to `query.req` request `rid` (a live widget's data). */
  | { kind: 'queryRes'; rid: string; ok: boolean; data?: unknown; error?: string }

/** What one frame asks to send back, and what the app should hear. */
export interface FeedOutput {
  replies: Frame[]
  events: FeedEvent[]
}

/** Relay turned this app away, or said something that ends the connection. */
export class RelayRefused extends Error {}

/** hex(HMAC-SHA256(secret, nonce)), the answer to Relay's challenge. */
export function proof(secret: Uint8Array, nonce: string): string {
  return createHmac('sha256', secret).update(nonce).digest('hex')
}

/** The handshake's first frame. Relay's handshake only knows phones. */
export function hello(deviceId = DEVICE_ID): Frame {
  return { t: 'hello', v: 1, deviceId, deviceName: DEVICE_NAME, platform: 'ios' }
}

/**
 * The protocol's state on one connection: the handshake, then the session list kept by `rev` and
 * the boards kept by their own `rev`.
 */
export class Feed {
  authenticated = false
  /** What the host answers beyond the base protocol (`welcome.features`; "query": `query.req`). */
  features: readonly string[] = []
  /** The Relay Host's name and version as its welcome (and later `mac.state`) said; null before. */
  host: { name: string; version: string } | null = null
  private rev = 0
  private sessions = new Map<string, RelaySession>()
  private boardRev = 0
  private boards = new Map<string, Board>()

  /**
   * `secret` is null for a remote host not paired yet; `pairs` (remote only) answers `unpaired`
   * with a PIN pairing instead of giving up.
   */
  constructor(
    private secret: Uint8Array | null,
    private readonly pairs = false,
  ) {}

  /**
   * Takes one frame from Relay: what to send back, and what the app should hear. Throws
   * RelayRefused when the connection should end.
   */
  receive(frame: unknown): FeedOutput {
    const replies: Frame[] = []
    const events: FeedEvent[] = []
    const parsed = FrameSchema.safeParse(frame)
    if (!parsed.success) return { replies, events }
    const f = parsed.data
    switch (f.t) {
      case 'challenge':
        if (!this.secret) throw new RelayRefused(LOST_SECRET)
        replies.push({ t: 'auth', proof: proof(this.secret, ChallengeSchema.parse(f).nonce) })
        break
      case 'unpaired':
        if (!this.pairs) throw new RelayRefused("Relay doesn't list this app as a paired device.")
        replies.push({ t: 'pair.request' })
        break
      case 'pair.pending':
        events.push({ kind: 'pin', retry: false })
        break
      case 'pair.failed': {
        const reason = PairFailedSchema.parse(f).reason
        if (reason !== 'wrong_pin') throw new RelayRefused(`Relay pairing failed: ${reason}.`)
        events.push({ kind: 'pin', retry: true })
        break
      }
      case 'pair.ok': {
        // The host authenticates this connection right after; `welcome` follows.
        this.secret = Buffer.from(PairOkSchema.parse(f).secret, 'hex')
        events.push({ kind: 'paired', secret: this.secret })
        break
      }
      case 'welcome': {
        this.authenticated = true
        const w = WelcomeSchema.parse(f)
        this.features = w.features
        this.host = w.state.mac ?? null
        this.reset(w.state.agents)
        events.push(this.list())
        // Boards stream on this connection from here; the snapshot answers. The canvas rooms
        // come once now and are pushed after every change.
        replies.push({ t: 'board.subscribe' })
        replies.push({ t: 'canvas.get' })
        break
      }
      case 'mac.state': {
        const host = MacStateSchema.parse(f).mac
        if (host) this.host = host
        break
      }
      case 'board.snapshot': {
        const s = BoardSnapshotSchema.parse(f)
        this.boardRev = s.rev
        this.boards = new Map()
        for (const raw of s.boards) {
          const b = parseBoard(raw)
          if (b) this.boards.set(b.slug, b)
        }
        events.push(this.boardList())
        break
      }
      case 'board.delta': {
        const d = BoardDeltaSchema.parse(f)
        if (d.rev !== this.boardRev + 1) {
          // Missed one: start over from every board.
          replies.push({ t: 'board.get' })
          break
        }
        this.boardRev = d.rev
        const b = parseBoard(d.board)
        if (b) this.boards.set(b.slug, b)
        if (d.removed) this.boards.delete(d.removed)
        events.push(this.boardList())
        break
      }
      case 'agents.snapshot':
        this.reset(f)
        events.push(this.list())
        break
      case 'agents.delta': {
        const d = DeltaSchema.parse(f)
        if (d.rev !== this.rev + 1) {
          // Missed one: start over from the full list.
          replies.push({ t: 'agents.get' })
          break
        }
        this.rev = d.rev
        for (const raw of d.upsert) {
          const s = parseSession(raw)
          if (s) this.sessions.set(s.id, s)
        }
        for (const id of d.remove) if (typeof id === 'string') this.sessions.delete(id)
        events.push(this.list())
        break
      }
      // The conversation on subscribe and each append after it: only a reply still streaming is
      // news here; the session file has the rest.
      case 'agent.conversation':
      case 'agent.messages': {
        const c = ConversationSchema.parse(f)
        for (const raw of f.t === 'agent.messages' ? c.append : c.messages) {
          const m = MessageSchema.safeParse(raw).data
          if (m?.role !== 'assistant' || !m.streaming) continue
          events.push({
            kind: 'stream',
            session: c.sessionId,
            id: m.id,
            text: m.text,
            streaming: true,
          })
        }
        break
      }
      case 'agent.message.update': {
        const u = UpdateSchema.parse(f)
        events.push({
          kind: 'stream',
          session: u.sessionId,
          id: u.id,
          text: u.text,
          streaming: u.streaming,
        })
        break
      }
      case 'agent.ask': {
        const s = SessionFrameSchema.parse(f)
        const ask = parseAsk(s.ask)
        if (ask) events.push({ kind: 'ask', session: s.sessionId, ask })
        break
      }
      case 'agent.ask.resolved': {
        const r = ResolvedSchema.parse(f)
        events.push({ kind: 'askResolved', session: r.sessionId, id: r.id })
        break
      }
      case 'agent.approval': {
        const s = SessionFrameSchema.parse(f)
        const approval = parseApproval(s.approval)
        if (approval) events.push({ kind: 'approval', session: s.sessionId, approval })
        break
      }
      case 'agent.approval.resolved': {
        const r = ResolvedSchema.parse(f)
        events.push({ kind: 'approvalResolved', session: r.sessionId, id: r.id })
        break
      }
      case 'reactions.snapshot': {
        const s = ReactionsSnapshotSchema.safeParse(f)
        if (s.success) {
          const reactions = parseReactions(s.data.reactions)
          events.push({ kind: 'reactions', thread: s.data.thread, reactions })
        }
        break
      }
      case 'bookmarks.snapshot': {
        const s = BookmarksSnapshotSchema.safeParse(f)
        if (s.success) {
          const messages = s.data.messages.filter(
            (k): k is string => ReactionKeySchema.safeParse(k).success,
          )
          events.push({ kind: 'bookmarks', thread: s.data.thread, messages })
        }
        break
      }
      case 'artifacts.snapshot': {
        const s = ArtifactsSnapshotSchema.safeParse(f)
        if (s.success)
          events.push({
            kind: 'artifacts',
            thread: s.data.thread,
            ...parseArtifacts(s.data.items, s.data.tabs),
          })
        break
      }
      case 'activity.snapshot': {
        const s = z.object({ items: list }).safeParse(f)
        if (s.success) events.push({ kind: 'activity', items: parseActivity(s.data.items) })
        break
      }
      case 'artifacts.acted': {
        const a = ActedSchema.safeParse(f)
        if (a.success) {
          const { rid, ok, error, id } = a.data
          events.push({
            kind: 'acted',
            rid,
            ok,
            ...(error === undefined ? {} : { error }),
            ...(id === undefined ? {} : { id }),
          })
        }
        break
      }
      case 'canvas.rooms': {
        const s = CanvasRoomsFrameSchema.safeParse(f)
        if (s.success) {
          const rooms = s.data.rooms.flatMap((raw) => {
            const r = CanvasRoomSchema.safeParse(raw)
            return r.success ? [r.data] : []
          })
          events.push({ kind: 'canvasRooms', rooms })
        }
        break
      }
      case 'canvas.access': {
        const a = CanvasAccessSchema.safeParse(f)
        if (a.success) events.push({ kind: 'canvasAccess', ...a.data })
        break
      }
      case 'canvas.unavailable': {
        const u = CanvasUnavailableSchema.safeParse(f)
        if (u.success) events.push({ kind: 'canvasUnavailable', ...u.data })
        break
      }
      case 'studio.state': {
        const s = StudioStateFrameSchema.safeParse(f)
        if (s.success) events.push({ kind: 'studioState', state: parseStudioState(s.data) })
        break
      }
      case 'studio.job': {
        const j = StudioJobFrameSchema.safeParse(f)
        if (j.success) events.push({ kind: 'studioJob', job: j.data.job })
        break
      }
      case 'studio.removed': {
        const r = StudioRemovedSchema.safeParse(f)
        if (r.success) events.push({ kind: 'studioRemoved', id: r.data.id })
        break
      }
      case 'studio.library': {
        const l = StudioLibraryFrameSchema.safeParse(f)
        if (l.success) events.push({ kind: 'studioLibrary', library: parseStudioLibrary(l.data) })
        break
      }
      case 'studio.segments': {
        const s = StudioSegmentsSchema.safeParse(f)
        if (s.success) events.push({ kind: 'studioSegments', segments: s.data })
        break
      }
      case 'studio.res': {
        const r = StudioResSchema.safeParse(f)
        if (r.success) {
          const { rid, ...answer } = r.data
          events.push({ kind: 'studioRes', rid, answer })
        }
        break
      }
      case 'query.res': {
        const r = QueryResSchema.safeParse(f)
        if (r.success) events.push({ kind: 'queryRes', ...r.data })
        break
      }
      case 'ack':
        events.push({ kind: 'ack', id: AckSchema.parse(f).id })
        break
      case 'nack': {
        const n = NackSchema.parse(f)
        events.push({
          kind: 'nack',
          id: n.id,
          code: n.error.code,
          message: n.error.message || "Relay couldn't do that.",
        })
        break
      }
      case 'error':
        throw new RelayRefused(`Relay: ${ErrorSchema.parse(f).message}`)
      default:
        break
    }
    return { replies, events }
  }

  private reset(agents: unknown): void {
    const a = AgentsSchema.safeParse(agents)
    this.rev = a.success ? a.data.rev : 0
    this.sessions = new Map()
    for (const raw of a.success ? a.data.sessions : []) {
      const s = parseSession(raw)
      if (s) this.sessions.set(s.id, s)
    }
  }

  private list(): FeedEvent {
    return {
      kind: 'sessions',
      sessions: [...this.sessions.values()].sort((a, b) =>
        a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
      ),
    }
  }

  private boardList(): FeedEvent {
    return {
      kind: 'boards',
      boards: [...this.boards.values()].sort(
        (a, b) => a.title.localeCompare(b.title) || a.slug.localeCompare(b.slug),
      ),
    }
  }
}
