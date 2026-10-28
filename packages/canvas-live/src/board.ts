// The EvaOS board JSON (`<canvases>/<slug>.json`) and its live Y.Doc. The file is the record:
// a room seeds its doc from it, exports back through `boardText` (byte for byte what EvaOS
// writes, so an unchanged board never rewrites its file in any app), and merges outside writes
// into the doc by node id. Pure: no fs, so the web client may import it too.
//
// Ports evaos-electron main/canvas/board-text.ts (native `board::parse` / `board::to_text`) and
// the board schema of packages/contract/src/canvas.ts.

import * as Y from "yjs";
import type { CanvasLayout } from "./layout";
import { DOC_KEYS, NODE_KINDS, PLAIN_DATA_KEYS, type NodeKind, type TextField } from "./shared";

/** The board schema version this build reads and writes (native `board::VERSION`). */
export const CANVAS_VERSION = 1;

export interface BoardSwatch {
  hex: string;
  name?: string;
}

export interface BoardNodeData {
  title?: string;
  body?: string;
  key?: string;
  status?: string;
  pr?: string;
  src?: string;
  caption?: string;
  url?: string;
  tone?: string;
  colors?: BoardSwatch[];
  font?: string;
  sample?: string;
}

export interface BoardNode {
  id: string;
  type: NodeKind;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  parent?: string;
  data?: BoardNodeData;
}

export interface BoardEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string;
  targetHandle?: string;
  label?: string;
  tone?: string;
}

export interface BoardViewport {
  x: number;
  y: number;
  zoom: number;
}

export interface Board {
  version: number;
  title: string;
  layout?: CanvasLayout;
  nodes: BoardNode[];
  edges: BoardEdge[];
  viewport?: BoardViewport;
}

export class BoardError extends Error {}

const LAYOUTS: readonly string[] = ["grid", "tree", "flow"];
const DATA_KEYS = ["title", "body", ...PLAIN_DATA_KEYS] as const;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function str(v: unknown, where: string, max = 100_000): string {
  if (typeof v !== "string" || v.length > max) throw new BoardError(`${where}: expected a string`);
  return v;
}
function optStr(v: unknown, where: string, max = 100_000): string | undefined {
  return v === undefined ? undefined : str(v, where, max);
}
function coord(v: unknown, where: string): number | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v)) throw new BoardError(`${where}: expected a finite number`);
  return v;
}

/** Copies the defined entries of `fields` in order (the shape `exactOptionalPropertyTypes` wants). */
function defined<T extends object>(fields: { [K in keyof T]: T[K] | undefined }): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) out[k] = v;
  return out as T;
}

function parseData(v: unknown, where: string): BoardNodeData | undefined {
  if (v === undefined) return undefined;
  if (!isObj(v)) throw new BoardError(`${where}: expected an object`);
  let colors: BoardSwatch[] | undefined;
  if (v["colors"] !== undefined) {
    if (!Array.isArray(v["colors"]) || v["colors"].length > 500) throw new BoardError(`${where}.colors: expected a list`);
    colors = v["colors"].map((c, i) => {
      if (!isObj(c)) throw new BoardError(`${where}.colors[${i}]: expected an object`);
      return defined<BoardSwatch>({ hex: str(c["hex"], `${where}.colors[${i}].hex`, 100), name: optStr(c["name"], `${where}.colors[${i}].name`) });
    });
  }
  const out: Record<string, unknown> = {};
  for (const key of DATA_KEYS) {
    if (key === "colors") {
      if (colors !== undefined) out[key] = colors;
    } else {
      const s = optStr(v[key], `${where}.${key}`);
      if (s !== undefined) out[key] = s;
    }
  }
  return out;
}

/** Native `board::parse`: JSON, unknown fields dropped, a newer `version` refused. Throws `BoardError`. */
export function parseBoard(text: string): Board {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new BoardError(e instanceof Error ? e.message : String(e));
  }
  if (!isObj(raw)) throw new BoardError("board: expected an object");
  const version = raw["version"] ?? CANVAS_VERSION;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 0) throw new BoardError("version: expected an integer");
  if (version > CANVAS_VERSION) throw new BoardError(`version ${version} is newer than this Relay reads (${CANVAS_VERSION})`);
  const layout = raw["layout"];
  if (layout !== undefined && (typeof layout !== "string" || !LAYOUTS.includes(layout))) throw new BoardError("layout: expected grid, tree or flow");
  const nodesRaw = raw["nodes"] ?? [];
  const edgesRaw = raw["edges"] ?? [];
  if (!Array.isArray(nodesRaw) || nodesRaw.length > 10_000) throw new BoardError("nodes: expected a list");
  if (!Array.isArray(edgesRaw) || edgesRaw.length > 50_000) throw new BoardError("edges: expected a list");
  const nodes = nodesRaw.map((n, i): BoardNode => {
    const where = `nodes[${i}]`;
    if (!isObj(n)) throw new BoardError(`${where}: expected an object`);
    const type = n["type"];
    if (typeof type !== "string" || !(NODE_KINDS as readonly string[]).includes(type)) throw new BoardError(`${where}.type: unknown kind`);
    return defined<BoardNode>({
      id: str(n["id"], `${where}.id`, 500),
      type: type as NodeKind,
      x: coord(n["x"], `${where}.x`),
      y: coord(n["y"], `${where}.y`),
      w: coord(n["w"], `${where}.w`),
      h: coord(n["h"], `${where}.h`),
      parent: optStr(n["parent"], `${where}.parent`, 500),
      data: parseData(n["data"], `${where}.data`),
    });
  });
  const edges = edgesRaw.map((e, i): BoardEdge => {
    const where = `edges[${i}]`;
    if (!isObj(e)) throw new BoardError(`${where}: expected an object`);
    return defined<BoardEdge>({
      id: str(e["id"], `${where}.id`, 500),
      source: str(e["source"], `${where}.source`, 500),
      target: str(e["target"], `${where}.target`, 500),
      sourceHandle: optStr(e["sourceHandle"], `${where}.sourceHandle`, 100),
      targetHandle: optStr(e["targetHandle"], `${where}.targetHandle`, 100),
      label: optStr(e["label"], `${where}.label`),
      tone: optStr(e["tone"], `${where}.tone`, 100),
    });
  });
  let viewport: BoardViewport | undefined;
  const vp = raw["viewport"];
  if (vp !== undefined) {
    if (!isObj(vp)) throw new BoardError("viewport: expected an object");
    const x = coord(vp["x"], "viewport.x");
    const y = coord(vp["y"], "viewport.y");
    const zoom = coord(vp["zoom"], "viewport.zoom");
    if (x === undefined || y === undefined || zoom === undefined) throw new BoardError("viewport: expected x, y and zoom");
    viewport = { x, y, zoom };
  }
  return defined<Board>({
    version,
    title: optStr(raw["title"], "title") ?? "",
    layout: layout as CanvasLayout | undefined,
    nodes,
    edges,
    viewport,
  });
}

// ------------------------------------------------------------------------------------------------
// boardText: serde_json's pretty printer with ryu f32 numbers and a fixed key order.
// ------------------------------------------------------------------------------------------------

/**
 * A number as serde_json writes an `f32`: the shortest decimal that reads back as the same f32,
 * laid out the way ryu's `format32` does (`0.0`, `115.0`, `0.31`, `1e30`, `1.5e-7`).
 */
export function f32Text(value: number): string {
  const f = Math.fround(value);
  if (!Number.isFinite(f)) throw new BoardError(`${value} does not fit a board coordinate`);
  if (f === 0) return Object.is(f, -0) ? "-0.0" : "0.0";
  let shortest = f.toPrecision(9);
  for (let p = 1; p < 9; p++) {
    const s = f.toPrecision(p);
    if (Math.fround(Number(s)) === f) {
      shortest = s;
      break;
    }
  }
  const [mant = "", exp = "0"] = Math.abs(Number(shortest)).toExponential().split("e");
  const digits = mant.replace(".", "");
  const length = digits.length;
  const kk = Number(exp) + 1; // 10^(kk-1) <= |v| < 10^kk
  const k = kk - length;
  const sign = f < 0 ? "-" : "";
  if (k >= 0 && kk <= 13) return `${sign}${digits}${"0".repeat(k)}.0`;
  if (kk > 0 && kk <= 13) return `${sign}${digits.slice(0, kk)}.${digits.slice(kk)}`;
  if (kk > -6 && kk <= 0) return `${sign}0.${"0".repeat(-kk)}${digits}`;
  if (length === 1) return `${sign}${digits}e${kk - 1}`;
  return `${sign}${digits[0] ?? ""}.${digits.slice(1)}e${kk - 1}`;
}

/** A JSON value whose numbers are already formatted; objects keep their key order. */
type Json = string | Raw | Obj | Json[];
class Raw {
  constructor(readonly text: string) {}
}
class Obj {
  constructor(readonly fields: [string, Json | undefined][]) {}
}

const f32 = (n: number | undefined): Raw | undefined => (n === undefined ? undefined : new Raw(f32Text(n)));

/** Native `Data::is_empty`: no field set and no swatches means no `data` key at all. */
function dataObj(d: BoardNodeData | undefined): Obj | undefined {
  if (!d) return undefined;
  const colors =
    d.colors && d.colors.length > 0
      ? d.colors.map(
          (c) =>
            new Obj([
              ["hex", c.hex],
              ["name", c.name],
            ]),
        )
      : undefined;
  const obj = new Obj([
    ["title", d.title],
    ["body", d.body],
    ["key", d.key],
    ["status", d.status],
    ["pr", d.pr],
    ["src", d.src],
    ["caption", d.caption],
    ["url", d.url],
    ["tone", d.tone],
    ["colors", colors],
    ["font", d.font],
    ["sample", d.sample],
  ]);
  return obj.fields.some(([, v]) => v !== undefined) ? obj : undefined;
}

const nodeObj = (n: BoardNode): Obj =>
  new Obj([
    ["id", n.id],
    ["type", n.type],
    ["x", f32(n.x)],
    ["y", f32(n.y)],
    ["w", f32(n.w)],
    ["h", f32(n.h)],
    ["parent", n.parent],
    ["data", dataObj(n.data)],
  ]);

const edgeObj = (e: BoardEdge): Obj =>
  new Obj([
    ["id", e.id],
    ["source", e.source],
    ["target", e.target],
    ["sourceHandle", e.sourceHandle],
    ["targetHandle", e.targetHandle],
    ["label", e.label],
    ["tone", e.tone],
  ]);

/** serde_json's pretty printer: two-space indent, `"key": value`, `[]` / `{}` when empty. */
function write(value: Json, indent: string): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (value instanceof Raw) return value.text;
  const inner = `${indent}  `;
  if (value instanceof Obj) {
    const rows = value.fields.flatMap(([k, v]) => (v === undefined ? [] : [`${inner}${JSON.stringify(k)}: ${write(v, inner)}`]));
    return rows.length === 0 ? "{}" : `{\n${rows.join(",\n")}\n${indent}}`;
  }
  if (value.length === 0) return "[]";
  return `[\n${value.map((v) => `${inner}${write(v, inner)}`).join(",\n")}\n${indent}]`;
}

/**
 * Native `board::to_text`: the same board always gives the same text, byte for byte what native
 * EvaOS writes, so an unchanged board never rewrites its file in either app.
 */
export function boardText(board: Board): string {
  const vp = board.viewport;
  const root = new Obj([
    ["version", new Raw(String(board.version))],
    ["title", board.title],
    ["layout", board.layout],
    ["nodes", board.nodes.map(nodeObj)],
    ["edges", board.edges.map(edgeObj)],
    [
      "viewport",
      vp &&
        new Obj([
          ["x", f32(vp.x)],
          ["y", f32(vp.y)],
          ["zoom", f32(vp.zoom)],
        ]),
    ],
  ]);
  return `${write(root, "")}\n`;
}

// ------------------------------------------------------------------------------------------------
// Board <-> Y.Doc (layout in shared.ts)
// ------------------------------------------------------------------------------------------------

type NodeMap = Y.Map<unknown>;
const GEOMETRY = ["x", "y", "w", "h"] as const;
const EDGE_KEYS = ["source", "target", "sourceHandle", "targetHandle", "label", "tone"] as const;

export const nodesOf = (doc: Y.Doc): Y.Map<NodeMap> => doc.getMap<NodeMap>(DOC_KEYS.nodes);
export const edgesOf = (doc: Y.Doc): Y.Map<Y.Map<unknown>> => doc.getMap<Y.Map<unknown>>(DOC_KEYS.edges);
export const metaOf = (doc: Y.Doc): Y.Map<unknown> => doc.getMap<unknown>(DOC_KEYS.meta);

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Data keys the node's file entry had (`title`/`body` export when listed, even empty). */
function dataKeys(d: BoardNodeData | undefined): string[] {
  return d ? DATA_KEYS.filter((k) => d[k] !== undefined) : [];
}

function nodeMap(n: BoardNode): NodeMap {
  const m = new Y.Map<unknown>();
  m.set("type", n.type);
  for (const k of GEOMETRY) if (n[k] !== undefined) m.set(k, n[k]);
  if (n.parent !== undefined) m.set("parent", n.parent);
  m.set("title", new Y.Text(n.data?.title ?? ""));
  m.set("body", new Y.Text(n.data?.body ?? ""));
  for (const k of PLAIN_DATA_KEYS) {
    const v = n.data?.[k];
    if (v !== undefined) m.set(k, v);
  }
  m.set("fields", dataKeys(n.data));
  return m;
}

function edgeMap(e: BoardEdge): Y.Map<unknown> {
  const m = new Y.Map<unknown>();
  for (const k of EDGE_KEYS) if (e[k] !== undefined) m.set(k, e[k]);
  return m;
}

function setMeta(meta: Y.Map<unknown>, board: Board): void {
  if (meta.get("version") !== board.version) meta.set("version", board.version);
  if (meta.get("title") !== board.title) meta.set("title", board.title);
  for (const k of ["layout", "viewport"] as const) {
    const v = board[k];
    if (v === undefined) {
      if (meta.has(k)) meta.delete(k);
    } else if (!sameJson(meta.get(k), v)) meta.set(k, v);
  }
}

/** Replaces the doc's board (nodes, edges, meta title/layout/viewport) with `board`, in one transaction. */
export function seedDoc(doc: Y.Doc, board: Board, origin: unknown = "seed"): void {
  const nodes = nodesOf(doc);
  const edges = edgesOf(doc);
  doc.transact(() => {
    nodes.clear();
    edges.clear();
    setMeta(metaOf(doc), board);
    for (const n of board.nodes) nodes.set(n.id, nodeMap(n));
    for (const e of board.edges) edges.set(e.id, edgeMap(e));
  }, origin);
}

const textOf = (m: NodeMap, field: TextField): string => {
  const t = m.get(field);
  return t instanceof Y.Text ? t.toJSON() : typeof t === "string" ? t : "";
};

/** One node of the doc as a board node (title/body exported when non-empty or the file had them). */
export function exportNode(id: string, m: NodeMap): BoardNode {
  const fields = m.get("fields");
  const listed = new Set(Array.isArray(fields) ? (fields as unknown[]).filter((f): f is string => typeof f === "string") : []);
  const data: Record<string, unknown> = {};
  for (const k of DATA_KEYS) {
    if (k === "title" || k === "body") {
      const s = textOf(m, k);
      if (s !== "" || listed.has(k)) data[k] = s;
      continue;
    }
    const v = m.get(k);
    if (v !== undefined) data[k] = v;
  }
  const type = m.get("type");
  const num = (k: string): number | undefined => {
    const v = m.get(k);
    return typeof v === "number" && Number.isFinite(v) ? v : undefined;
  };
  const parent = m.get("parent");
  return defined<BoardNode>({
    id,
    type: (NODE_KINDS as readonly unknown[]).includes(type) ? (type as NodeKind) : "note",
    x: num("x"),
    y: num("y"),
    w: num("w"),
    h: num("h"),
    parent: typeof parent === "string" ? parent : undefined,
    data: Object.keys(data).length > 0 ? (data) : undefined,
  });
}

/** The doc's board in file shape; `boardText(exportBoard(doc))` is what the room writes. */
export function exportBoard(doc: Y.Doc): Board {
  const meta = metaOf(doc);
  const nodes: BoardNode[] = [];
  for (const [id, m] of nodesOf(doc)) nodes.push(exportNode(id, m));
  const edges: BoardEdge[] = [];
  for (const [id, m] of edgesOf(doc)) {
    const s = (k: string): string | undefined => {
      const v = m.get(k);
      return typeof v === "string" ? v : undefined;
    };
    edges.push(
      defined<BoardEdge>({
        id,
        source: s("source") ?? "",
        target: s("target") ?? "",
        sourceHandle: s("sourceHandle"),
        targetHandle: s("targetHandle"),
        label: s("label"),
        tone: s("tone"),
      }),
    );
  }
  const version = meta.get("version");
  const layout = meta.get("layout");
  const viewport = meta.get("viewport");
  return defined<Board>({
    version: typeof version === "number" ? version : CANVAS_VERSION,
    title: typeof meta.get("title") === "string" ? (meta.get("title") as string) : "",
    layout: typeof layout === "string" && LAYOUTS.includes(layout) ? (layout as CanvasLayout) : undefined,
    nodes,
    edges,
    viewport: isObj(viewport) ? (viewport as unknown as BoardViewport) : undefined,
  });
}

/** The single splice turning `a` into `b`: common prefix `p` and suffix `s` kept. */
function splice(a: string, b: string): { p: number; s: number } {
  let p = 0;
  const max = Math.min(a.length, b.length);
  while (p < max && a.charCodeAt(p) === b.charCodeAt(p)) p++;
  let s = 0;
  while (s < max - p && a.charCodeAt(a.length - 1 - s) === b.charCodeAt(b.length - 1 - s)) s++;
  return { p, s };
}

/**
 * Applies a writer's change of a field from `from` to `to` as the smallest single splice, so
 * concurrent typing elsewhere in the field survives. When the live text has moved on from `from`
 * (the room typed since), the writer's splice is rebased past the room's edit when the two don't
 * overlap; when they do, the writer's text wins.
 */
export function spliceText(text: Y.Text, from: string, to: string): void {
  if (from === to) return;
  const current = text.toJSON();
  const w = splice(from, to);
  let start = w.p;
  let end = from.length - w.s;
  let insert = to.slice(w.p, to.length - w.s);
  if (current !== from) {
    const room = splice(from, current);
    if (start >= from.length - room.s && end > room.p) {
      // Entirely after the room's edit: shift by what the room added or removed.
      start += current.length - from.length;
      end += current.length - from.length;
    } else if (end > room.p) {
      // Overlapping edits: the writer's text wins for the span both touched.
      const all = splice(current, to);
      start = all.p;
      end = current.length - all.s;
      insert = to.slice(all.p, to.length - all.s);
    }
  }
  const apply = (): void => {
    if (end > start) text.delete(start, end - start);
    if (insert) text.insert(start, insert);
  };
  if (text.doc) text.doc.transact(apply);
  else apply();
}

/**
 * Merges a board written by someone else into the doc by id: nodes and edges added, removed and
 * updated, title/body through `spliceText`. With `base` (the board as this room last wrote or
 * read it) only what the writer changed relative to `base` is applied, so a stale writer never
 * undoes edits made in the room since; without it, the doc is brought to `board`.
 */
export function mergeBoardIntoDoc(doc: Y.Doc, board: Board, origin: unknown, base?: Board): void {
  const nodes = nodesOf(doc);
  const edges = edgesOf(doc);
  const baseBoard = base ?? exportBoard(doc);
  const baseNodes = new Map(baseBoard.nodes.map((n) => [n.id, n]));
  const baseEdges = new Map(baseBoard.edges.map((e) => [e.id, e]));
  doc.transact(() => {
    const meta = metaOf(doc);
    if (board.title !== baseBoard.title) meta.set("title", board.title);
    if (board.version !== baseBoard.version) meta.set("version", board.version);
    for (const k of ["layout", "viewport"] as const) {
      if (sameJson(board[k], baseBoard[k])) continue;
      if (board[k] === undefined) meta.delete(k);
      else meta.set(k, board[k]);
    }

    const incomingIds = new Set(board.nodes.map((n) => n.id));
    for (const id of baseNodes.keys()) if (!incomingIds.has(id) && nodes.has(id)) nodes.delete(id);
    for (const n of board.nodes) {
      const was = baseNodes.get(n.id);
      const m = nodes.get(n.id);
      if (m === undefined) {
        // New from the writer, or deleted in the room since `base` and still in a stale file: only re-add the former.
        if (was === undefined || base === undefined) nodes.set(n.id, nodeMap(n));
        continue;
      }
      if (n.type !== was?.type && m.get("type") !== n.type) m.set("type", n.type);
      for (const k of GEOMETRY) {
        if (was !== undefined && n[k] === was[k]) continue;
        if (n[k] === undefined) m.delete(k);
        else if (m.get(k) !== n[k]) m.set(k, n[k]);
      }
      if (was === undefined || n.parent !== was.parent) {
        if (n.parent === undefined) m.delete("parent");
        else m.set("parent", n.parent);
      }
      for (const k of ["title", "body"] as const) {
        const to = n.data?.[k] ?? "";
        const from = was === undefined ? textOf(m, k) : (was.data?.[k] ?? "");
        if (to === from) continue;
        const t = m.get(k);
        if (t instanceof Y.Text) spliceText(t, from, to);
        else m.set(k, new Y.Text(to));
      }
      for (const k of PLAIN_DATA_KEYS) {
        const v = n.data?.[k];
        if (was !== undefined && sameJson(v, was.data?.[k])) continue;
        if (v === undefined) m.delete(k);
        else if (!sameJson(m.get(k), v)) m.set(k, v);
      }
      const keys = dataKeys(n.data);
      if (was === undefined || !sameJson(keys, dataKeys(was.data))) {
        if (!sameJson(m.get("fields"), keys)) m.set("fields", keys);
      }
    }

    const incomingEdges = new Set(board.edges.map((e) => e.id));
    for (const id of baseEdges.keys()) if (!incomingEdges.has(id) && edges.has(id)) edges.delete(id);
    for (const e of board.edges) {
      const was = baseEdges.get(e.id);
      const m = edges.get(e.id);
      if (m === undefined) {
        if (was === undefined || base === undefined) edges.set(e.id, edgeMap(e));
        continue;
      }
      for (const k of EDGE_KEYS) {
        if (was !== undefined && e[k] === was[k]) continue;
        const v = e[k];
        if (v === undefined) m.delete(k);
        else if (m.get(k) !== v) m.set(k, v);
      }
    }
  }, origin);
}
