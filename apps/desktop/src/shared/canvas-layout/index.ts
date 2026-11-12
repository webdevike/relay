/**
 * The canvas layout engine, shared by main (canvas.layout) and the renderer. Pure: no Node,
 * DOM or Electron; ELK runs in-thread (elk.bundled.js).
 *
 * layoutBoard(nodes, edges, opts):
 * - `layered`: ELK layered, flow `right` or `down`, orthogonal links on the flow sides
 *   (right/left, or bottom/top), cards `spacing` apart and layers 1.5x that. Return links
 *   (DFS back edges, tone `loop`, self links) come back `loop: true` and run through the gutter
 *   under their row (right of their column for `down`), bottom to bottom (right to right).
 * - Lanes (frames with `lane` and children) are numbered processes: their steps go in one row
 *   in input order (a column for `down`; past LANE_ROW_MAX, as few rows as that allows, evenly
 *   filled: 7 steps 4 and 3), top aligned, `spacing` apart or wider where a link label must fit
 *   (6.5 px a character plus 32). Neighbours link straight; a forward link that skips steps
 *   arcs over the row (top to top), a link back or tone `loop` under it (bottom to bottom,
 *   `loop: true`), in nested 14 px tracks; a forward link on to the next row drops from under
 *   its step through the gap between the rows into its target's top. The lane
 *   grows around the tracks and their label pills: FRAME_PAD round, LANE_HEADER on top, so no
 *   link between its steps leaves it or reaches its heading. Lanes stack as rows (columns for
 *   `down`) in dependency order, all as long as the longest. A topic linked to no step heads
 *   them, from their left edge. Loose cards linked to nothing sit on a shelf 1.5x spacing past
 *   the lanes (under them; right of them for `down`) from their left edge, in input order, top
 *   aligned, wrapping at the lanes' length. Other loose cards go in a column right of the lanes
 *   (a row under them for `down`) in the order of the step they link to, level with it, then
 *   the rest. A link between lanes runs bottom to top through the gutter between them (right to
 *   left for `down`), then down the gap beside its target step and into it from just above.
 *   Steps linked out of their lane leave it to the gutter first. Ordinary frames lay their
 *   children out with the board's algorithm and grow (FRAME_HEADER on top) around them.
 * - `grid`: input order, `columns` (default about square) wide, columns as wide as their
 *   widest card, rows as tall as their tallest (column by column for `down`). `radial`: ELK
 *   radial from the topic (else the card with no incoming link and most outgoing, else the
 *   busiest), spread until no cards touch. `mrtree`: ELK tree from the same root. Separate
 *   groups sit side by side. Their links are routed by facing sides.
 * - `keepPinned`: pinned cards with a place stay (in `kept`, with everything in a pinned
 *   frame); `only`: just those cards (a frame brings its children) move, starting at the top
 *   left of where they were. Cards that stay are obstacles: the moved blocks slide along the
 *   flow past them (or, failing that, all go under them), so nothing overlaps.
 * - Every route is orthogonal, starts on its source's side and ends on its target's, and
 *   passes routeCrossesCards against every card but its two ends and the frames around them
 *   (unless the two cards are walled in, then a plain elbow). Positions, frame sizes and
 *   route points are integers; the same input gives the same output.
 */
export {
  layoutBoard,
  FRAME_HEADER,
  FRAME_MIN_W,
  FRAME_PAD,
  LANE_HEADER,
  LANE_ROW_MAX,
} from './layout'
export { alignNodes, distributeNodes, routeCrossesCards } from './geometry'
export type * from './types'
