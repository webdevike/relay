/**
 * The canvas layout engine's contract (see ./index.ts): pure data in, pure data out, no Electron,
 * Node or DOM, so main (canvas.layout) and the renderer (boards opened with no positions) share it.
 * All coordinates are board units (pixels at zoom 1); positions are absolute top lefts, never
 * relative to a parent frame.
 */

export type LayoutAlgorithm = 'layered' | 'grid' | 'radial' | 'mrtree'
export type LayoutDirection = 'right' | 'down'

/** One card as the layout sees it. `w` and `h` are its drawn (measured) size. */
export interface LayoutNode {
  id: string
  w: number
  h: number
  /** Where it sits now (absolute top left), when it has a place. */
  x?: number | undefined
  y?: number | undefined
  /** The frame it sits in. */
  parent?: string | undefined
  /** A frame: grows around its children, which are laid out inside it. */
  frame?: boolean | undefined
  /** A frame drawn as a phase lane (`variant: lane`): lanes stack as rows (columns for `down`). */
  lane?: boolean | undefined
  /** Isaac moved it: it keeps its place when `keepPinned`. */
  pinned?: boolean | undefined
  /** A topic: the root of a radial or tree layout when the graph has no better one. */
  topic?: boolean | undefined
}

export interface LayoutEdge {
  id: string
  source: string
  target: string
  label?: string | undefined
  /** The file's tone; `loop` is kept as the loop-back style. */
  tone?: string | undefined
}

export interface LayoutOptions {
  algorithm: LayoutAlgorithm
  direction: LayoutDirection
  /** Gap between cards, board px. */
  spacing: number
  /** Columns of the `grid` algorithm (default: about a square). */
  columns?: number | undefined
  /** Cards with `pinned` keep their place (and others lay out around them). */
  keepPinned: boolean
  /**
   * The cards to move: these (a frame id brings its children); everything else stays where it
   * is and is an obstacle. Null: the whole board.
   */
  only?: ReadonlySet<string> | null | undefined
}

export interface LaidEdge {
  /** `left`/`right`/`top`/`bottom`: the card side the link leaves and enters. */
  sourceHandle: 'left' | 'right' | 'top' | 'bottom'
  targetHandle: 'left' | 'right' | 'top' | 'bottom'
  /** Orthogonal path from the source side to the target side, absolute. At least two points. */
  route: Array<{ x: number; y: number }>
  /** A return link (it points back against the flow): drawn as a loop-back. */
  loop: boolean
}

export interface LayoutResult {
  /** New absolute top left of every card that moved or was placed (not the kept ones). */
  positions: Map<string, { x: number; y: number }>
  /** The size each frame with children grew to. */
  frameSizes: Map<string, { w: number; h: number }>
  /** Handles and routes for every link between laid-out cards. */
  edges: Map<string, LaidEdge>
  /** Cards that stayed where they were because they were pinned. */
  kept: string[]
}

export type AlignTo = 'left' | 'right' | 'top' | 'bottom' | 'center' | 'middle'
export interface Box {
  x: number
  y: number
  w: number
  h: number
}
