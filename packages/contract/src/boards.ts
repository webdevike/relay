import { z } from 'zod'

/** Columns in a board's grid; a widget's span is out of these. */
export const BOARD_COLUMNS = 12

/** One tile: a Relay ```ui widget spec spanning `span` of the board's 12 columns. */
export const BoardWidgetSchema = z.object({
  id: z.string(),
  span: z.number().int().min(1).max(BOARD_COLUMNS),
  /** The widget tree as Relay stores it; the renderer parses it like a ```ui fence. */
  spec: z.unknown(),
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
})
export type Boards = z.infer<typeof BoardsSchema>

export const boardsInvoke = {
  'boards.list': { input: z.object({}).strict(), output: BoardsSchema },
} as const

export const boardsEvents = {
  'boards.changed': BoardsSchema,
} as const
