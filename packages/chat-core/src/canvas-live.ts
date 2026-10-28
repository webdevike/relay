import { z } from 'zod'

// A live canvas in a chat, hand-ported from relay packages/protocol (`CanvasSlug`, `CanvasAgent`,
// `CanvasEntry`). An omp session takes its chat into a shared board room on the Relay host; the
// chat gets one row per step, stored in the session file as a `relay-canvas` custom message.

/** The custom message type the Relay bridge writes for canvas rows. */
export const CANVAS_CUSTOM_TYPE = 'relay-canvas'

/** A board's file stem (EvaOS `board::valid_slug`). */
export const CanvasLiveSlugSchema = z.string().regex(/^[a-z0-9-]{1,80}$/)

/** The agent in a room: the session's own name and color; `avatar` is a host path (`/canvas/avatar/<key>`). */
export const CanvasAgentSchema = z.object({
  name: z.string().min(1),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  avatar: z.string().max(300).optional(),
})
export type CanvasAgent = z.infer<typeof CanvasAgentSchema>

/** One canvas row: `start` = Join card, `turn` = a note and the agent's answer, `end` = wrap-up summary. */
export const CanvasChatEntrySchema = z.object({
  kind: z.enum(['start', 'turn', 'end']),
  roomId: z.string().min(1),
  slug: CanvasLiveSlugSchema,
  /** The board's title. */
  board: z.string().max(400),
  agent: CanvasAgentSchema,
  /** `turn`: what the human said at the canvas. */
  human: z.object({ name: z.string().min(1), text: z.string().max(20_000) }).optional(),
  /** `turn`: the agent's reply; `end`: the summary; `start`: the one-line purpose. */
  text: z.string().max(20_000).optional(),
})
export type CanvasChatEntry = z.infer<typeof CanvasChatEntrySchema>

/** A `relay-canvas` custom message's entry, or null when it is another type or does not parse. */
export function canvasEntryOf(customType: unknown, details: unknown): CanvasChatEntry | null {
  if (customType !== CANVAS_CUSTOM_TYPE) return null
  const r = CanvasChatEntrySchema.safeParse(details)
  return r.success ? r.data : null
}
