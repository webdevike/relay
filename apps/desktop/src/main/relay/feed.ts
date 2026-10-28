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
// answer to `reactions.get` and pushed after every change. Drops, calls and the inbox escalation
// are not used by this app; their frames are ignored.
import { createHmac } from 'node:crypto'
import * as path from 'node:path'
import { z } from 'zod'
import { BOARD_COLUMNS, type Board } from '@evaos/contract'
import {
  ReactionKeySchema,
  ReactionSchema,
  ReactionThreadSchema,
  type ThreadReactions,
} from '@evaos/chat-core/reactions'

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
 * dropped; a span outside the grid is clamped to it (native BoardWidget::columns).
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
    widgets.push({ id: w.id, span, spec: w.spec })
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
const AgentsSchema = z.object({ rev, sessions: list })
const WelcomeSchema = z.object({
  state: z.object({ agents: z.unknown() }).catch({ agents: undefined }),
})
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

/** A thread's reactions as Relay sends them; an entry with a bad key or reaction is dropped. */
export function parseReactions(value: Record<string, unknown>): ThreadReactions {
  const out: ThreadReactions = {}
  for (const [key, raw] of Object.entries(value)) {
    const r = ReactionSchema.safeParse(raw)
    if (r.success && ReactionKeySchema.safeParse(key).success) out[key] = r.data
  }
  return out
}

export type Frame = Record<string, unknown>

/** What the app hears from one frame. */
export type FeedEvent =
  | { kind: 'sessions'; sessions: RelaySession[] }
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
export function hello(): Frame {
  return { t: 'hello', v: 1, deviceId: DEVICE_ID, deviceName: DEVICE_NAME, platform: 'ios' }
}

/**
 * The protocol's state on one connection: the handshake, then the session list kept by `rev` and
 * the boards kept by their own `rev`.
 */
export class Feed {
  authenticated = false
  private rev = 0
  private sessions = new Map<string, RelaySession>()
  private boardRev = 0
  private boards = new Map<string, Board>()

  constructor(private readonly secret: Uint8Array) {}

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
        replies.push({ t: 'auth', proof: proof(this.secret, ChallengeSchema.parse(f).nonce) })
        break
      case 'unpaired':
        throw new RelayRefused("Relay doesn't list this app as a paired device.")
      case 'welcome':
        this.authenticated = true
        this.reset(WelcomeSchema.parse(f).state.agents)
        events.push(this.list())
        // Boards stream on this connection from here; the snapshot answers.
        replies.push({ t: 'board.subscribe' })
        break
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
