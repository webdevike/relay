// Relay's agent feed, ported from the native app's relay.rs (the `Feed` half: the protocol state on
// one connection, with no socket in sight). The local Relay host hears every interactive omp
// session through its omp extension, whoever started it: a terminal, a job, the phone. This app
// connects the way Isaac's phone does and keeps the session list: each session's status, the tool
// it runs or waits on, and whether it is a job.
//
// Only the session list is ported. Streams, asks, approvals, boards and commands (replying into a
// session, answering it) are not used by this app yet; their frames are ignored.
import { createHmac } from 'node:crypto'
import { z } from 'zod'

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
})

/** One session as Relay sends it, or null when it has no id or a status this app does not know. */
export function parseSession(value: unknown): RelaySession | null {
  const r = SessionSchema.safeParse(value)
  if (!r.success) return null
  const s = r.data
  return {
    id: s.id,
    status: s.status,
    detail: s.statusDetail || null,
    canRespond: s.canRespond ?? false,
    kind: s.kind === 'job' || s.kind === 'assistant' ? s.kind : 'manual',
    title: s.title ?? '',
    assistant: s.assistant || null,
  }
}

const rev = z.number().catch(0)
const list = z.array(z.unknown()).catch([])
const FrameSchema = z.looseObject({ t: z.string().catch('') })
const ChallengeSchema = z.object({ nonce: z.string().catch('') })
const AgentsSchema = z.object({ rev, sessions: list })
const WelcomeSchema = z.object({
  state: z.object({ agents: z.unknown() }).catch({ agents: undefined }),
})
const DeltaSchema = z.object({ rev, upsert: list, remove: list })
const ErrorSchema = z.object({ message: z.string().catch('unknown error') })

export type Frame = Record<string, unknown>

/** What the app hears from one frame. */
export type FeedEvent = { kind: 'sessions'; sessions: RelaySession[] }

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

/** The protocol's state on one connection: the handshake, then the session list kept by `rev`. */
export class Feed {
  authenticated = false
  private rev = 0
  private sessions = new Map<string, RelaySession>()

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
        break
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
}
