import { z } from 'zod'

/**
 * Agent presence: one layer for every surface a chat's agent works on in front of Isaac (a web
 * page in the shared browser, a canvas board; later Relay Assist's whole-screen overlay). Each
 * surface shows the same things: the agent's run (status, caption, ring, a one-row work card in
 * its chat), its cursor (face, eased glide, dotted route ahead, fading trail, click ripple), and
 * notes Isaac leaves on the surface that go to the chat that owns it (docs/agent-presence.md).
 */

/**
 * Where an agent's run stands. `working`: it acts (ring, cursor, caption); `paused`: Isaac took
 * over (his own input there, or Take over), the agent waits for Hand back; `ask`: a purchase,
 * send, submit or delete waits for his Allow; `done`/`stopped`: finished (`caption` says how);
 * `idle`: nobody drives it right now (the agent's face only).
 */
export const AgentRunStatusSchema = z.enum(['working', 'paused', 'ask', 'done', 'stopped', 'idle'])
export type AgentRunStatus = z.output<typeof AgentRunStatusSchema>

/** The agent a surface belongs to and what it is doing there. */
export const AgentRunSchema = z.object({
  /** The assistant (`penny`), for its face and color; null for a session that is no assistant's. */
  id: z.string().max(120).nullable(),
  name: z.string().max(120),
  /** Its accent color (`#86efac`). */
  color: z.string().max(32),
  status: AgentRunStatusSchema,
  /** One line: what it is doing (or, done or stopped, how it ended). */
  caption: z.string().max(200),
  /** Opened in the background (a page grouped quietly at the end of the strip). */
  background: z.boolean(),
  /** The action waiting for Isaac's Allow while `ask`. */
  ask: z.object({ id: z.string().max(64), label: z.string().max(200) }).nullable(),
  /** When it started its current run (ms epoch), for the elapsed time on its work card. */
  since: z.number(),
  /** When it ended (done or stopped), else null. */
  ended: z.number().nullable(),
})
export type AgentRun = z.output<typeof AgentRunSchema>

/** Who an agent is, as its surfaces show it. */
export const AgentIdentitySchema = AgentRunSchema.pick({ id: true, name: true, color: true })
export type AgentIdentity = z.output<typeof AgentIdentitySchema>

/**
 * Isaac's controls on an agent's run: `takeOver` pauses it, `handBack` resumes it, `allow` and
 * `deny` answer the action waiting in `ask`, `dismiss` clears a finished caption.
 */
export const AgentRunOpSchema = z.enum(['takeOver', 'handBack', 'allow', 'deny', 'dismiss'])
export type AgentRunOp = z.output<typeof AgentRunOpSchema>

/** A box on a surface, in its own pixels (a page's viewport CSS px, a board's flow units). */
export const NoteRegionSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  w: z.number().finite().min(0),
  h: z.number().finite().min(0),
})
export type NoteRegion = z.output<typeof NoteRegionSchema>

/** The element a page note points at, as the page describes it. */
export const NoteElementSchema = z.object({
  tag: z.string().max(40),
  role: z.string().max(60).optional(),
  label: z.string().max(200).optional(),
  text: z.string().max(400).optional(),
  selector: z.string().max(400).optional(),
})
export type NoteElement = z.output<typeof NoteElementSchema>

/**
 * A note Isaac leaves on a surface for the chat that owns it. It goes into that chat as his own
 * message with what it points at, so the chat's assistant answers there and acts with its cursor.
 */
export const AgentNoteSchema = z.discriminatedUnion('surface', [
  z.object({
    surface: z.literal('canvas'),
    text: z.string().min(1).max(4000),
    slug: z.string().max(80),
    /** The board's title. */
    board: z.string().max(500),
    page: z.string().max(40),
    /** The comment thread it opened or replied in. */
    thread: z.string().max(60),
    /** The card it is pinned to, else a spot on the board. */
    node: z.object({ id: z.string().max(500), title: z.string().max(200).optional() }).optional(),
    at: z.object({ x: z.number().finite(), y: z.number().finite() }),
    /** A reply in an existing thread (not its first comment). */
    reply: z.boolean(),
    /** The assistant the comment @mentions: it goes to that assistant's thread. */
    assignee: z.string().max(100).optional(),
  }),
  z.object({
    surface: z.literal('browser'),
    text: z.string().min(1).max(4000),
    url: z.string().max(4000),
    title: z.string().max(500),
    tabId: z.string().max(16),
    /** What was marked: one element (its box) or a dragged region, in viewport CSS px. */
    element: NoteElementSchema.optional(),
    region: NoteRegionSchema,
    /** The marked area's screenshot (PNG file), when one was taken. */
    image: z.string().max(4000).optional(),
  }),
])
export type AgentNote = z.output<typeof AgentNoteSchema>

/** Who a note goes to: an assistant's thread, or a chat by its session file. */
export const NoteOwnerSchema = z.union([
  z.object({ assistant: z.string().max(120) }),
  z.object({ file: z.string().max(4000) }),
])
export type NoteOwner = z.output<typeof NoteOwnerSchema>

/** Where a note went: the chat's name, or null when no chat owns the surface. */
const NoteSentSchema = z.object({ sent: z.boolean(), to: z.string().max(200).nullable() })

export const agentPresenceInvoke = {
  /**
   * Sends Isaac's note to the chat that owns the surface: the agent run's chat, else the chat of
   * the workspace it was left in (`workspace`, a browser scope: `chat:<file>`, `page:agent:<id>`).
   */
  'agent.note': {
    input: z.object({ note: AgentNoteSchema, workspace: z.string().max(4000).nullable() }).strict(),
    output: NoteSentSchema,
  },
} as const

const short = (s: string, max: number): string =>
  s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s

const quoted = (s: string, max = 80): string => `"${short(s.replace(/\s+/g, ' ').trim(), max)}"`

/** The chat a workspace belongs to (`chat:<file>`, `page:agent:<id>`); null for any other page. */
export function ownerOfWorkspace(workspace: string | null | undefined): NoteOwner | null {
  if (!workspace) return null
  if (workspace.startsWith('chat:') && workspace.length > 'chat:'.length) {
    return { file: workspace.slice('chat:'.length) }
  }
  if (workspace.startsWith('page:agent:') && workspace.length > 'page:agent:'.length) {
    return { assistant: workspace.slice('page:agent:'.length) }
  }
  return null
}

/** The deep link back to a canvas note's spot: the board, at the card when it has one. */
export function noteLink(note: Extract<AgentNote, { surface: 'canvas' }>): string {
  const q = [`canvas=${encodeURIComponent(note.slug)}`]
  if (note.node) q.push(`node=${encodeURIComponent(note.node.id)}`)
  return `relay://open/canvas?${q.join('&')}`
}

/**
 * The message a note becomes in the owning chat: one header line naming the spot (board, page,
 * card or point; page, element or region), Isaac's words, then the way back to it.
 */
export function noteText(note: AgentNote): string {
  if (note.surface === 'canvas') {
    const board = note.board.trim() ? `${quoted(note.board)} (${note.slug})` : note.slug
    const on = note.node
      ? `card ${note.node.title ? `${quoted(note.node.title)} ` : ''}(${note.node.id})`
      : `the spot ${Math.round(note.at.x)},${Math.round(note.at.y)}`
    const what = note.reply ? 'Reply in comment thread' : 'Comment'
    return [
      `[${what} ${note.thread} on board ${board}, page ${note.page}, ${on}]`,
      note.text.trim(),
      noteLink(note),
    ].join('\n')
  }
  const r = note.region
  const el = note.element
  const target = el
    ? [
        `<${el.tag}>`,
        el.role ? `role ${el.role}` : null,
        el.label ? `label ${quoted(el.label)}` : el.text ? quoted(el.text) : null,
        el.selector ? `selector ${el.selector}` : null,
      ]
        .filter((p): p is string => p !== null)
        .join(', ')
    : `the region ${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.w)}x${Math.round(r.h)}`
  return [
    `[Note on web page ${note.tabId} ${quoted(note.title || note.url)}: ${target}]`,
    note.text.trim(),
    note.url,
    ...(note.image ? [`Screenshot of the marked area: ${note.image}`] : []),
  ].join('\n')
}
