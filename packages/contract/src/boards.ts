import { z } from 'zod'

/** Columns in a board's grid; a widget's span is out of these. */
export const BOARD_COLUMNS = 12

/** One tile: a Relay ```ui widget spec spanning `span` of the board's 12 columns. */
export const BoardWidgetSchema = z.object({
  id: z.string(),
  span: z.number().int().min(1).max(BOARD_COLUMNS),
  /** The widget tree as Relay stores it; the renderer parses it like a ```ui fence. For a live
   * tile it is the host's static render of `openui` at write time (what older hosts' data shows). */
  spec: z.unknown(),
  /** A live tile's OpenUI Lang source: its `Query(...)` statements fetch host data while shown. */
  openui: z.string().optional(),
})
export type BoardWidget = z.infer<typeof BoardWidgetSchema>

/** A Relay host dashboard (`relay-linux board`), as the host streams it. */
export const BoardSchema = z.object({
  slug: z.string(),
  title: z.string(),
  workspace: z.string().nullable(),
  /** A Tabler icon name the board asks for, else null. */
  icon: z.string().nullable(),
  widgets: z.array(BoardWidgetSchema),
  /** RFC 3339, as the host stamped the last write. */
  updatedAt: z.string(),
})
export type Board = z.infer<typeof BoardSchema>

export const BoardsSchema = z.object({
  /** By title. Empty while Relay is down. */
  boards: z.array(BoardSchema),
  /** Relay is connected and has sent its boards. */
  relayUp: z.boolean(),
  /** The host answers live widgets' queries (`welcome.features` has "query"); false on older
   * hosts, whose live tiles then show their static `spec`. */
  queries: z.boolean(),
})
export type Boards = z.infer<typeof BoardsSchema>

/** One live widget query's answer: the tool's data, or why not. `unsupported`: the host has no
 * query route (an older Relay Host), so the tile should fall back to its static spec. */
export const BoardQueryAnswerSchema = z.object({
  ok: z.boolean(),
  data: z.unknown().optional(),
  error: z.string().optional(),
  unsupported: z.boolean().optional(),
})
export type BoardQueryAnswer = z.infer<typeof BoardQueryAnswerSchema>

export const boardsInvoke = {
  'boards.list': { input: z.object({}).strict(), output: BoardsSchema },
  /** Runs one allowlisted read-only host query tool for a live widget (dashboards, canvas `ui`). */
  'boards.query': {
    input: z
      .object({ tool: z.string().min(1).max(64), args: z.record(z.string(), z.unknown()) })
      .strict(),
    output: BoardQueryAnswerSchema,
  },
} as const

export const boardsEvents = {
  'boards.changed': BoardsSchema,
} as const
