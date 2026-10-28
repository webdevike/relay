// Where nodes go when the board file gives no position, ported from EvaOS
// (evaos-electron renderer/canvas/layout.ts + board-model.ts, themselves ports of native
// canvas_view/layout.rs and board.rs). Pure: the web client bundles this for the browser and the
// host uses it for the agent's view of the board, so it imports nothing but types.
//
// Frames are packed first (their children in a masonry of one or two columns under the frame's
// title), so each frame and each loose node is one block; the blocks are then arranged by the
// board's layout:
// - `grid`: loose nodes stacked in the first column, then one column per frame;
// - `tree`: a mind map from the root (the first topic, else the first node nothing points to),
//   first-level branches split right and left, each subtree centered on its parent;
// - `flow`: layers left to right by longest path from the sources, each layer stacked and
//   ordered by its predecessors.

import type { NodeKind } from "./shared";

export type CanvasLayout = "grid" | "tree" | "flow";

/** A node as layout sees it: the board node with its data fields flattened (as the Y.Doc keeps them). */
export interface LayoutNode {
  id: string;
  type: NodeKind;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  parent?: string;
  title?: string;
  body?: string;
  caption?: string;
  sample?: string;
  colors?: { hex: string; name?: string }[];
}

/** A node to place: its size (flow units), whether it is a frame, and the frame it sits in. */
export interface LayoutItem {
  id: string;
  w: number;
  h: number;
  frame: boolean;
  parent: string | null;
  /** A topic; the tree layout roots at the first one. */
  topic: boolean;
}

export type Point = readonly [number, number];
export type Size = readonly [number, number];

/** Top-left positions for every item, and the size each frame with children grew to. */
export interface Placement {
  positions: Map<string, Point>;
  frameSizes: Map<string, Size>;
}

/** Space between blocks and between a frame's children. */
const GAP = 48;
const INNER_GAP = 16;
/** A frame's padding and the band its title takes. */
export const FRAME_PAD = 16;
export const FRAME_HEADER = 36;
/** Horizontal space between tree depths and flow layers. */
const RANK_GAP = 96;
/** Frames in a grid row before it wraps. */
const GRID_COLUMNS = 4;
/** A frame's height when neither the file nor the layout gave one. */
export const FRAME_DEFAULT_H = 220;

/** Width when the file gives none, in flow units (board.rs Kind::default_width). */
export function defaultWidth(kind: NodeKind): number {
  switch (kind) {
    case "note":
      return 220;
    case "frame":
      return 330;
    case "suggestion":
    case "typography":
      return 260;
    case "topic":
    case "ticket":
    case "image":
    case "link":
    case "palette":
      return 240;
  }
}

const utf8 = new TextEncoder();

/** A height estimate for layout before a node has been drawn, from its width and text. */
export function estimateHeight(node: LayoutNode, width: number): number {
  if (node.h !== undefined) return node.h;
  // Rust's str::len counts UTF-8 bytes.
  const lines = (text: string | undefined, pxPerChar: number): number =>
    Math.ceil(((text ? utf8.encode(text).length : 0) * pxPerChar) / Math.max(width - 28, 40));
  switch (node.type) {
    case "topic":
      return 84;
    case "note":
      return 52 + lines(node.body, 6.6) * 18;
    case "ticket":
      return 110;
    case "image":
      return width * 0.75 + 28 + lines(node.title, 7) * 18 + lines(node.caption, 6) * 16;
    case "link":
      return 64 + lines(node.caption, 6) * 16;
    case "frame":
      return FRAME_DEFAULT_H;
    case "suggestion":
      return 76 + lines(node.body, 6.6) * 18;
    case "palette":
      return 60 + Math.max(Math.ceil((node.colors?.length ?? 0) / 4), 1) * 72;
    case "typography":
      return 150 + lines(node.sample, 7) * 20;
  }
}

/**
 * The layout a board uses when its file names none: grid with frames, tree with a topic and
 * links, flow with links, else grid.
 */
export function effectiveLayout(fileLayout: CanvasLayout | undefined, nodes: readonly LayoutNode[], hasEdges: boolean): CanvasLayout {
  if (fileLayout) return fileLayout;
  if (nodes.some((n) => n.type === "frame")) return "grid";
  if (hasEdges && nodes.some((n) => n.type === "topic")) return "tree";
  if (hasEdges) return "flow";
  return "grid";
}

/** Layout inputs: measured sizes where a node has been drawn, else the file's size or an estimate. Frames take their file size. */
function layoutItems(nodes: readonly LayoutNode[], measured: ReadonlyMap<string, { w: number; h: number }>): LayoutItem[] {
  return nodes.map((n) => {
    const drawn = n.type === "frame" ? undefined : measured.get(n.id);
    const w = n.w ?? defaultWidth(n.type);
    return {
      id: n.id,
      w: drawn?.w ?? w,
      h: drawn?.h ?? estimateHeight(n, w),
      frame: n.type === "frame",
      parent: n.parent ?? null,
      topic: n.type === "topic",
    };
  });
}

/**
 * Absolute top-left positions for the nodes that have no `x`/`y`; placed nodes are not in the
 * map. When nothing is placed the whole board is laid out; otherwise a node joining a placed
 * frame goes under its siblings, and the rest are laid out together to the right of what is there.
 */
export function placeUnplaced(
  nodes: readonly LayoutNode[],
  edges: readonly { source: string; target: string }[],
  layout?: CanvasLayout,
  measured: ReadonlyMap<string, { w: number; h: number }> = new Map(),
): Map<string, { x: number; y: number }> {
  const out = new Map<string, { x: number; y: number }>();
  const unplaced = nodes.filter((n) => n.x === undefined || n.y === undefined).map((n) => n.id);
  if (unplaced.length === 0) return out;
  const pairs: [string, string][] = edges.map((e) => [e.source, e.target]);
  const items = layoutItems(nodes, measured);
  const chosen = layout ?? effectiveLayout(undefined, nodes, edges.length > 0);
  const put = (positions: Map<string, Point>): Map<string, { x: number; y: number }> => {
    for (const [id, [x, y]] of positions) out.set(id, { x, y });
    return out;
  };
  if (unplaced.length === nodes.length) return put(place(chosen, items, pairs).positions);

  const isUnplaced = new Set(unplaced);
  const specs = new Map(nodes.map((n) => [n.id, n]));
  const itemOf = new Map(items.map((i) => [i.id, i]));
  const placedAt = (id: string): Point | null => {
    const n = specs.get(id);
    return n?.x !== undefined && n.y !== undefined ? [n.x, n.y] : null;
  };
  const rect = (id: string): [number, number, number, number] | null => {
    const at = placedAt(id);
    const item = itemOf.get(id);
    const spec = specs.get(id);
    if (!at || !item || !spec) return null;
    return [at[0], at[1], spec.w ?? item.w, spec.h ?? item.h];
  };
  const positions = new Map<string, Point>();
  const rest: LayoutItem[] = [];
  for (const item of items) {
    if (!isUnplaced.has(item.id)) continue;
    const frameId = item.parent !== null && !isUnplaced.has(item.parent) ? item.parent : null;
    const frame = frameId === null ? null : rect(frameId);
    if (frameId === null || frame === null) {
      rest.push(item);
      continue;
    }
    const [fx, fy] = frame;
    // Under the lowest sibling already in the frame.
    let bottom = fy + FRAME_HEADER;
    for (const s of items) {
      if (s.parent !== frameId || s.id === item.id) continue;
      const done = positions.get(s.id);
      if (done) bottom = Math.max(bottom, done[1] + s.h);
      else if (!isUnplaced.has(s.id)) {
        const r = rect(s.id);
        if (r) bottom = Math.max(bottom, r[1] + r[3]);
      }
    }
    positions.set(item.id, [fx + FRAME_PAD, bottom + FRAME_PAD]);
  }
  if (rest.length > 0) {
    let right = 0;
    let top = Number.MAX_VALUE;
    for (const n of nodes) {
      if (isUnplaced.has(n.id)) continue;
      const r = rect(n.id);
      if (r) right = Math.max(right, r[0] + r[2]);
      const at = placedAt(n.id);
      if (at) top = Math.min(top, at[1]);
    }
    if (top === Number.MAX_VALUE) top = 0;
    const placement = place(chosen, rest, pairs);
    for (const [id, [x, y]] of placement.positions) positions.set(id, [right + 120 + x, top + y]);
  }
  return put(positions);
}

interface Block {
  id: string;
  w: number;
  h: number;
  /** Children's offsets from the block's top left. */
  children: [string, number, number][];
  frameSize: Size | null;
}

/**
 * Places every item, arranged by `layout`, with the top left of the result at the origin.
 * `edges` are (source, target) pairs; edges to or from a frame's child count for its frame.
 */
export function place(layout: CanvasLayout, items: readonly LayoutItem[], edges: readonly (readonly [string, string])[]): Placement {
  const bs = blocks(items);
  const blockOf = new Map<string, number>();
  bs.forEach((block, ix) => {
    blockOf.set(block.id, ix);
    for (const [child] of block.children) blockOf.set(child, ix);
  });
  const links: [number, number][] = [];
  for (const [s, t] of edges) {
    const a = blockOf.get(s);
    const b = blockOf.get(t);
    if (a !== undefined && b !== undefined && a !== b) links.push([a, b]);
  }
  const origins = layout === "grid" ? grid(bs, items) : layout === "tree" ? tree(bs, items, links) : flow(bs, links);

  // Normalize so the top left is the origin.
  let minX = 0;
  let minY = 0;
  if (origins.length > 0) {
    minX = Math.min(...origins.map((o) => o[0]));
    minY = Math.min(...origins.map((o) => o[1]));
  }
  const placement: Placement = { positions: new Map(), frameSizes: new Map() };
  bs.forEach((block, ix) => {
    const [ox, oy] = origins[ix] ?? [0, 0];
    const x = ox - minX;
    const y = oy - minY;
    placement.positions.set(block.id, [x, y]);
    for (const [child, dx, dy] of block.children) placement.positions.set(child, [x + dx, y + dy]);
    if (block.frameSize) placement.frameSizes.set(block.id, block.frameSize);
  });
  return placement;
}

const at = <T>(list: readonly T[], ix: number): T => list[ix] as T;

/** Packs each frame's children (masonry, two columns from four children up) and makes one block per frame and per loose node, in item order. */
function blocks(items: readonly LayoutItem[]): Block[] {
  const frames = new Set(items.filter((i) => i.frame).map((i) => i.id));
  const inFrame = (item: LayoutItem): boolean => item.parent !== null && frames.has(item.parent) && item.parent !== item.id;
  const out: Block[] = [];
  for (const item of items) {
    if (inFrame(item)) continue;
    const children = items.filter((c) => inFrame(c) && c.parent === item.id);
    if (!item.frame || children.length === 0) {
      out.push({ id: item.id, w: item.w, h: item.h, children: [], frameSize: null });
      continue;
    }
    const cols = children.length >= 4 ? 2 : 1;
    const colW = children.reduce((m, c) => Math.max(m, c.w), 0);
    const heights = new Array<number>(cols).fill(0);
    const placed: [string, number, number][] = [];
    for (const child of children) {
      // The first shortest column.
      let col = 0;
      for (let c = 1; c < cols; c++) if (at(heights, c) < at(heights, col)) col = c;
      placed.push([child.id, FRAME_PAD + col * (colW + INNER_GAP), FRAME_HEADER + at(heights, col)]);
      heights[col] = at(heights, col) + child.h + INNER_GAP;
    }
    const innerH = heights.reduce((m, h) => Math.max(m, h), 0) - INNER_GAP;
    // At least wide enough for a short title.
    const w = Math.max(cols * colW + (cols - 1) * INNER_GAP + FRAME_PAD * 2, 200);
    const h = FRAME_HEADER + Math.max(innerH, 0) + FRAME_PAD;
    out.push({ id: item.id, w, h, children: placed, frameSize: [w, h] });
  }
  return out;
}

/** Loose nodes stacked in the first column, then a column per frame, wrapping after four. */
function grid(bs: readonly Block[], items: readonly LayoutItem[]): [number, number][] {
  const isFrame = (id: string): boolean => items.some((i) => i.id === id && i.frame);
  const columns: number[][] = [];
  const loose = bs.map((_, ix) => ix).filter((ix) => !isFrame(at(bs, ix).id));
  if (loose.length > 0) columns.push(loose);
  for (let ix = 0; ix < bs.length; ix++) if (isFrame(at(bs, ix).id)) columns.push([ix]);

  const origins: [number, number][] = bs.map(() => [0, 0]);
  let x = 0;
  let y = 0;
  let rowH = 0;
  columns.forEach((column, n) => {
    if (n > 0 && n % GRID_COLUMNS === 0) {
      x = 0;
      y += rowH + GAP;
      rowH = 0;
    }
    let cy = y;
    let colW = 0;
    for (const ix of column) {
      origins[ix] = [x, cy];
      cy += at(bs, ix).h + GAP / 2;
      colW = Math.max(colW, at(bs, ix).w);
    }
    rowH = Math.max(rowH, cy - GAP / 2 - y);
    x += colW + GAP;
  });
  return origins;
}

/**
 * A mind map: the root in the middle, first-level branches alternating right and left (the first
 * half right), deeper levels outward, every subtree centered on its parent. Blocks the tree
 * doesn't reach go in a row under it.
 */
function tree(bs: readonly Block[], items: readonly LayoutItem[], links: readonly (readonly [number, number])[]): [number, number][] {
  const n = bs.length;
  const origins: [number, number][] = bs.map(() => [0, 0]);
  if (n === 0) return origins;
  const topic = (ix: number): boolean => items.some((i) => i.id === at(bs, ix).id && i.topic);
  const hasIncoming = new Set(links.map(([, t]) => t));
  let root = -1;
  for (let ix = 0; ix < n && root < 0; ix++) if (topic(ix)) root = ix;
  for (let ix = 0; ix < n && root < 0; ix++) if (!hasIncoming.has(ix)) root = ix;
  if (root < 0) root = 0;

  // Breadth-first tree over the links, either direction.
  const adjacent: number[][] = bs.map(() => []);
  for (const [s, t] of links) {
    at(adjacent, s).push(t);
    at(adjacent, t).push(s);
  }
  const children: number[][] = bs.map(() => []);
  const seen = bs.map(() => false);
  seen[root] = true;
  const queue = [root];
  for (let ix = queue.shift(); ix !== undefined; ix = queue.shift()) {
    for (const next of at(adjacent, ix)) {
      if (!seen[next]) {
        seen[next] = true;
        at(children, ix).push(next);
        queue.push(next);
      }
    }
  }

  const span = (ix: number): number => {
    const kids = at(children, ix).reduce((sum, c) => sum + span(c), 0) + INNER_GAP * 2 * Math.max(at(children, ix).length - 1, 0);
    return Math.max(at(bs, ix).h, kids);
  };
  /** Places the children of `ix` (whose origin is set) on one side, `dir` 1 right, -1 left. */
  const branch = (ix: number, kids: readonly number[], dir: number): void => {
    if (kids.length === 0) return;
    const total = kids.reduce((sum, c) => sum + span(c), 0) + INNER_GAP * 2 * (kids.length - 1);
    const center = at(origins, ix)[1] + at(bs, ix).h / 2;
    let y = center - total / 2;
    for (const kid of kids) {
      const s = span(kid);
      const x = dir > 0 ? at(origins, ix)[0] + at(bs, ix).w + RANK_GAP : at(origins, ix)[0] - RANK_GAP - at(bs, kid).w;
      origins[kid] = [x, y + s / 2 - at(bs, kid).h / 2];
      branch(kid, at(children, kid), dir);
      y += s + INNER_GAP * 2;
    }
  };
  const first = at(children, root);
  const rightCount = Math.ceil(first.length / 2);
  branch(root, first.slice(0, rightCount), 1);
  branch(root, first.slice(rightCount), -1);

  // Anything unreached sits in a row under the tree.
  let bottom = -Number.MAX_VALUE;
  let leftEdge = Number.MAX_VALUE;
  for (let ix = 0; ix < n; ix++) {
    if (!seen[ix]) continue;
    bottom = Math.max(bottom, at(origins, ix)[1] + at(bs, ix).h);
    leftEdge = Math.min(leftEdge, at(origins, ix)[0]);
  }
  let x = leftEdge;
  for (let ix = 0; ix < n; ix++) {
    if (seen[ix]) continue;
    origins[ix] = [x, bottom + GAP];
    x += at(bs, ix).w + GAP;
  }
  return origins;
}

/**
 * Layers left to right: a block's layer is the longest path to it from a block nothing points to
 * (cycles broken where met). Each layer is a column stacked top to bottom, ordered by the average
 * position of its predecessors, and centered on the tallest layer.
 */
function flow(bs: readonly Block[], links: readonly (readonly [number, number])[]): [number, number][] {
  const n = bs.length;
  const indegree = new Array<number>(n).fill(0);
  const out: number[][] = bs.map(() => []);
  for (const [s, t] of links) {
    at(out, s).push(t);
    indegree[t] = at(indegree, t) + 1;
  }
  // Kahn's order; whatever a cycle leaves behind joins in item order.
  const layer = new Array<number>(n).fill(0);
  const queue: number[] = [];
  for (let ix = 0; ix < n; ix++) if (indegree[ix] === 0) queue.push(ix);
  const done = new Array<boolean>(n).fill(false);
  const remaining = [...indegree];
  for (;;) {
    for (let ix = queue.shift(); ix !== undefined; ix = queue.shift()) {
      if (done[ix]) continue;
      done[ix] = true;
      for (const t of at(out, ix)) {
        layer[t] = Math.max(at(layer, t), at(layer, ix) + 1);
        remaining[t] = Math.max(at(remaining, t) - 1, 0);
        if (remaining[t] === 0) queue.push(t);
      }
    }
    const next = done.indexOf(false);
    if (next < 0) break;
    queue.push(next);
  }

  const layers = n === 0 ? 0 : Math.max(...layer) + 1;
  const columns: number[][] = Array.from({ length: layers }, () => []);
  for (let ix = 0; ix < n; ix++) at(columns, at(layer, ix)).push(ix);
  const origins: [number, number][] = bs.map(() => [0, 0]);
  let x = 0;
  for (const column of columns) {
    // Order by where the predecessors already sit.
    const keys = new Map<number, number>();
    for (const ix of column) {
      const ys = links.filter(([, t]) => t === ix).map(([s]) => at(origins, s)[1] + at(bs, s).h / 2);
      keys.set(ix, ys.length === 0 ? Number.MAX_VALUE : ys.reduce((a, b) => a + b, 0) / ys.length);
    }
    column.sort((a, b) => (keys.get(a) ?? 0) - (keys.get(b) ?? 0) || a - b);
    const height = column.reduce((sum, ix) => sum + at(bs, ix).h, 0) + GAP * Math.max(column.length - 1, 0);
    let y = -height / 2;
    const width = column.reduce((m, ix) => Math.max(m, at(bs, ix).w), 0);
    for (const ix of column) {
      origins[ix] = [x, y];
      y += at(bs, ix).h + GAP;
    }
    x += width + RANK_GAP;
  }
  return origins;
}
