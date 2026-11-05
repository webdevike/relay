import { z } from 'zod'

/** The board schema version this build reads and writes (native `board::VERSION`). */
export const CANVAS_VERSION = 1

/** A board's file stem: lowercase letters, digits and dashes (native `board::valid_slug`). */
export const CanvasSlugSchema = z.string().regex(/^[a-z0-9-]{1,80}$/)

export const CANVAS_NODE_KINDS = [
  'topic',
  'note',
  'ticket',
  'image',
  'link',
  'frame',
  'suggestion',
  'palette',
  'typography',
  /** A live OpenUI widget: `data.title` is its card title, `data.body` its OpenUI Lang source. */
  'ui',
  /**
   * An interactive prototype: `data.title` is its card title, `data.body` its JSX (the
   * ```mantine-widget contract), `data.system` its design system (`relay`, `ecard`, `mantine`) and
   * `data.viewport` `mobile` for a phone-width screen.
   */
  'proto',
] as const
export const CanvasNodeKindSchema = z.enum(CANVAS_NODE_KINDS)

export const CANVAS_LAYOUTS = ['grid', 'tree', 'flow'] as const
export const CanvasLayoutSchema = z.enum(CANVAS_LAYOUTS)

const Id = z.string().max(500)
const Text = z.string().max(100_000)
const Coord = z.number().finite()

// Objects strip unknown keys and never fill optional fields, so a load and save writes the same text.
export const CanvasSwatchSchema = z.object({
  hex: z.string().max(100),
  name: Text.optional(),
})

export const CanvasNodeDataSchema = z.object({
  title: Text.optional(),
  body: Text.optional(),
  key: Text.optional(),
  status: Text.optional(),
  pr: Text.optional(),
  src: Text.optional(),
  caption: Text.optional(),
  url: Text.optional(),
  tone: Text.optional(),
  colors: z.array(CanvasSwatchSchema).max(500).optional(),
  font: Text.optional(),
  sample: Text.optional(),
  system: Text.optional(),
  viewport: Text.optional(),
})

export const CanvasNodeSchema = z.object({
  id: Id,
  type: CanvasNodeKindSchema,
  x: Coord.optional(),
  y: Coord.optional(),
  w: Coord.optional(),
  h: Coord.optional(),
  parent: Id.optional(),
  data: CanvasNodeDataSchema.optional(),
})

export const CanvasEdgeSchema = z.object({
  id: Id,
  source: Id,
  target: Id,
  sourceHandle: z.string().max(100).optional(),
  targetHandle: z.string().max(100).optional(),
  label: Text.optional(),
  tone: z.string().max(100).optional(),
})

export const CanvasViewportSchema = z.object({ x: Coord, y: Coord, zoom: Coord })

/** A page id (canvas-live `PAGE_ID`): what the board file accepts. */
export const CanvasPageIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/)
export const CanvasPageSchema = z.object({ id: CanvasPageIdSchema, title: z.string().max(500) })
export type CanvasPage = z.output<typeof CanvasPageSchema>

export const CanvasBoardSchema = z.object({
  version: z.number().int().min(0).max(CANVAS_VERSION).default(CANVAS_VERSION),
  title: Text.default(''),
  layout: CanvasLayoutSchema.optional(),
  nodes: z.array(CanvasNodeSchema).max(10_000).default([]),
  edges: z.array(CanvasEdgeSchema).max(50_000).default([]),
  viewport: CanvasViewportSchema.optional(),
})

export const CanvasEntrySchema = z.object({
  slug: CanvasSlugSchema,
  title: Text,
  nodes: z.number().int().min(0),
  modifiedMs: z.number(),
  pinned: z.boolean(),
})

export type CanvasNodeKind = z.output<typeof CanvasNodeKindSchema>
export type CanvasLayout = z.output<typeof CanvasLayoutSchema>
export type CanvasSwatch = z.output<typeof CanvasSwatchSchema>
export type CanvasNodeData = z.output<typeof CanvasNodeDataSchema>
export type CanvasNode = z.output<typeof CanvasNodeSchema>
export type CanvasEdge = z.output<typeof CanvasEdgeSchema>
export type CanvasViewport = z.output<typeof CanvasViewportSchema>
export type CanvasBoard = z.output<typeof CanvasBoardSchema>
export type CanvasEntry = z.output<typeof CanvasEntrySchema>

export const CanvasThreadMessageSchema = z.object({
  id: z.string().min(1).max(200),
  kind: z.enum(['human', 'agent']),
  name: z.string().max(100),
  color: z.string().max(40),
  avatar: z.string().max(500).optional(),
  text: z.string().max(4000),
  ts: z.number(),
})
/** A comment pin and its thread, as a board file keeps it (canvas-live `BoardThread`). */
export const CanvasThreadSchema = z.object({
  id: z.string().min(1).max(60),
  /** The card it is pinned to; x and y are then an offset from the card's top left, else a board point. */
  node: z.string().max(500).optional(),
  x: Coord,
  y: Coord,
  resolved: z.boolean(),
  /** The agent the thread is for: a registry assistant's id, else a joined agent's lowercased name. Absent: the room's canvas self. */
  assignee: z.string().min(1).max(100).optional(),
  messages: z.array(CanvasThreadMessageSchema).max(1000),
})
export type CanvasThreadMessage = z.output<typeof CanvasThreadMessageSchema>
export type CanvasThread = z.output<typeof CanvasThreadSchema>

/** One change to a page's comment threads. */
export const CanvasThreadOpSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('open'),
    node: z.string().max(500).optional(),
    x: Coord,
    y: Coord,
    text: z.string().min(1).max(4000),
    /** The agent the thread is for, from an @mention in the text. */
    assignee: z.string().min(1).max(100).optional(),
  }),
  z.object({
    op: z.literal('post'),
    thread: z.string().min(1).max(60),
    text: z.string().min(1).max(4000),
    /** The agent the thread is now for (the message's @mention, else the one it already had). */
    assignee: z.string().min(1).max(100).optional(),
  }),
  z.object({ op: z.literal('resolve'), thread: z.string().min(1).max(60), resolved: z.boolean() }),
  /** A pin dragged: onto the card `node` (x, y an offset from its top left), else to the board point x, y. */
  z.object({
    op: z.literal('move'),
    thread: z.string().min(1).max(60),
    node: z.string().max(500).optional(),
    x: Coord,
    y: Coord,
  }),
])
export type CanvasThreadOp = z.output<typeof CanvasThreadOpSchema>

export const canvasInvoke = {
  'canvas.list': {
    input: z.object({}).strict(),
    output: z.object({ entries: z.array(CanvasEntrySchema).max(10_000) }),
  },
  'canvas.load': {
    input: z.object({ slug: CanvasSlugSchema, page: CanvasPageIdSchema.optional() }).strict(),
    output: z.object({
      board: CanvasBoardSchema,
      text: z.string(),
      pages: z.array(CanvasPageSchema).min(1).max(100),
      page: CanvasPageIdSchema,
    }),
  },
  'canvas.save': {
    input: z
      .object({
        slug: CanvasSlugSchema,
        board: CanvasBoardSchema,
        page: CanvasPageIdSchema.optional(),
      })
      .strict(),
    output: z.object({ saved: z.boolean() }),
  },
  'canvas.pages': {
    input: z
      .object({
        slug: CanvasSlugSchema,
        op: z.enum(['add', 'rename', 'move', 'duplicate', 'delete']),
        /** The page the op acts on (add: the page the new one goes after, default last). */
        page: CanvasPageIdSchema.optional(),
        title: z.string().max(500).optional(),
        to: z.number().int().min(0).max(100).optional(),
        /** The new page's id for add and duplicate (default: a fresh one). */
        id: CanvasPageIdSchema.optional(),
      })
      .strict(),
    output: z.object({
      pages: z.array(CanvasPageSchema).min(1).max(100),
      /** The page to show after the op: the new page, a neighbor of a deleted one, else the one acted on. */
      page: CanvasPageIdSchema,
    }),
  },
  /**
   * A page's comment threads (the file's own `threads`, kept lossless), after the op when there is
   * one. `opened` names the thread an `open` made.
   */
  'canvas.threads': {
    input: z
      .object({
        slug: CanvasSlugSchema,
        page: CanvasPageIdSchema.optional(),
        op: CanvasThreadOpSchema.optional(),
      })
      .strict(),
    output: z.object({
      threads: z.array(CanvasThreadSchema).max(5000),
      opened: z.string().optional(),
    }),
  },
  'canvas.create': {
    input: z.object({}).strict(),
    output: z.object({ slug: CanvasSlugSchema }),
  },
  'canvas.rename': {
    input: z.object({ slug: CanvasSlugSchema, title: z.string().trim().min(1).max(500) }).strict(),
    output: z.object({ saved: z.literal(true) }),
  },
  'canvas.delete': {
    input: z.object({ slug: CanvasSlugSchema }).strict(),
    output: z.object({ deleted: z.literal(true) }),
  },
  'canvas.pin': {
    input: z.object({ slug: CanvasSlugSchema, pinned: z.boolean() }).strict(),
    output: z.object({ pinned: z.array(CanvasSlugSchema).max(10_000) }),
  },
  'canvas.image': {
    input: z.object({ slug: CanvasSlugSchema, src: z.string().min(1).max(10_000) }).strict(),
    output: z.object({
      dataUrl: z.string().startsWith('data:image/'),
      width: z.number().int().min(0).nullable(),
      height: z.number().int().min(0).nullable(),
    }),
  },
} as const

export const canvasEvents = {
  /** A board file changed outside Relay (`slug`), or boards were added or removed (`null`). */
  'canvas.changed': z.object({ slug: CanvasSlugSchema.nullable() }),
} as const
