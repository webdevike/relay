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

export const canvasInvoke = {
  'canvas.list': {
    input: z.object({}).strict(),
    output: z.object({ entries: z.array(CanvasEntrySchema).max(10_000) }),
  },
  'canvas.load': {
    input: z.object({ slug: CanvasSlugSchema }).strict(),
    output: z.object({ board: CanvasBoardSchema, text: z.string() }),
  },
  'canvas.save': {
    input: z.object({ slug: CanvasSlugSchema, board: CanvasBoardSchema }).strict(),
    output: z.object({ saved: z.boolean() }),
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
