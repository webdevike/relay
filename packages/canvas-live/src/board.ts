// The EvaOS board JSON (`<canvases>/<slug>.json`) and its live Y.Doc. The file is the record:
// a room seeds its doc from it, exports back through `boardText` (byte for byte what EvaOS
// writes, so an unchanged board never rewrites its file in any app), and merges outside writes
// into the doc by node id. Pure: no fs, so the web client may import it too.
//
// Ports evaos-electron main/canvas/board-text.ts (native `board::parse` / `board::to_text`) and
// the board schema of packages/contract/src/canvas.ts.

import * as Y from "yjs";
import type { CanvasLayout } from "./layout";
import { DOC_KEYS, PLAIN_DATA_KEYS, type NodeKind, type TextField } from "./shared";
import { FIRST_PAGE, FIRST_PAGE_TITLE, isSinglePage, MAX_PAGES, PAGE_ID, pageKey, pageMaps, pagesOf, setPages, type PageInfo, type PageMaps } from "./pages";
import { snapThreads, THREAD_ID, threadMap, type ThreadAnchor, type ThreadMap, type ThreadMsg } from "./threads";

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
  /** A `proto` node's design system (`relay`, `ecard`, `mantine`). */
  system?: string;
  /** A `proto` node's screen: `mobile`, else desktop. */
  viewport?: string;
  /** Data keys this build does not know, kept as the file had them so no writer loses them. */
  extra?: Record<string, unknown>;
}

export interface BoardNode {
  id: string;
  /** One of NODE_KINDS, or a kind a newer writer added: kept as it is (shown as a plain card). */
  type: NodeKind | (string & {});
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  parent?: string;
  data?: BoardNodeData;
  /** Node keys this build does not know, kept as the file had them. */
  extra?: Record<string, unknown>;
}

export interface BoardEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string;
  targetHandle?: string;
  label?: string;
  tone?: string;
  /** Edge keys this build does not know, kept as the file had them. */
  extra?: Record<string, unknown>;
}

export interface BoardViewport {
  x: number;
  y: number;
  zoom: number;
}

/** A comment pin and its thread (threads.ts): `node` + offset, or a board point; messages oldest first. */
export interface BoardThread {
  id: string;
  node?: string;
  x: number;
  y: number;
  resolved?: boolean;
  messages: ThreadMsg[];
}

/**
 * One page of a board with pages. page-1's entry is only its id and title: its content is the
 * board's top-level nodes, edges, threads and viewport. Every other page carries its own.
 */
export interface BoardPage {
  id: string;
  title: string;
  nodes?: BoardNode[];
  edges?: BoardEdge[];
  viewport?: BoardViewport;
  threads?: BoardThread[];
}

export interface Board {
  version: number;
  title: string;
  layout?: CanvasLayout;
  /** page-1's nodes (the whole board when it has no other pages). */
  nodes: BoardNode[];
  edges: BoardEdge[];
  viewport?: BoardViewport;
  /** Absent in files written before comment pins (and by writers that drop them): the room's threads are then left as they are. */
  threads?: BoardThread[];
  /** Every page in order, when the board has more than page-1 (or renamed it). Absent: the room's pages are left as they are. */
  pages?: BoardPage[];
  /** Top-level keys this build does not know, kept as the file had them. */
  extra?: Record<string, unknown>;
}

export class BoardError extends Error {}

const LAYOUTS: readonly string[] = ["grid", "tree", "flow"];
const DATA_KEYS = ["title", "body", ...PLAIN_DATA_KEYS] as const;
const NODE_KEYS: readonly string[] = ["id", "type", "x", "y", "w", "h", "parent", "data"];
const EDGE_FILE_KEYS: readonly string[] = ["id", "source", "target", "sourceHandle", "targetHandle", "label", "tone"];
const BOARD_KEYS: readonly string[] = ["version", "title", "layout", "nodes", "edges", "viewport", "threads", "pages"];
/** A node kind: one of NODE_KINDS, or one a newer writer added. */
const KIND = /^[A-Za-z][\w-]{0,99}$/;

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

/**
 * The keys of `v` not in `known`, in file order; undefined when there are none. Kept on the
 * board so a writer that does not know them (an older Relay, the desktop) never drops them.
 */
function extraOf(v: Record<string, unknown>, known: readonly string[]): Record<string, unknown> | undefined {
  let out: Record<string, unknown> | undefined;
  for (const [k, val] of Object.entries(v)) {
    if (known.includes(k)) continue;
    out ??= {};
    out[k] = val;
  }
  return out;
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
  const extra = extraOf(v, DATA_KEYS);
  if (extra !== undefined) out["extra"] = extra;
  return out;
}

function parseThreads(v: unknown, prefix: string): BoardThread[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.length > 2_000) throw new BoardError(`${prefix}threads: expected a list`);
  return v.map((t, i): BoardThread => {
    const where = `${prefix}threads[${i}]`;
    if (!isObj(t)) throw new BoardError(`${where}: expected an object`);
    const id = str(t["id"], `${where}.id`, 60);
    if (!THREAD_ID.test(id)) throw new BoardError(`${where}.id: expected letters, digits, ".", "_" or "-"`);
    const x = coord(t["x"], `${where}.x`);
    const y = coord(t["y"], `${where}.y`);
    if (x === undefined || y === undefined) throw new BoardError(`${where}: expected x and y`);
    const resolved = t["resolved"];
    if (resolved !== undefined && typeof resolved !== "boolean") throw new BoardError(`${where}.resolved: expected true or false`);
    const raw = t["messages"] ?? [];
    if (!Array.isArray(raw) || raw.length > 500) throw new BoardError(`${where}.messages: expected a list`);
    const messages = raw.map((m, j): ThreadMsg => {
      const at = `${where}.messages[${j}]`;
      if (!isObj(m)) throw new BoardError(`${at}: expected an object`);
      const kind = m["kind"];
      if (kind !== "human" && kind !== "agent") throw new BoardError(`${at}.kind: expected human or agent`);
      const ts = coord(m["ts"], `${at}.ts`);
      return defined<ThreadMsg>({
        id: str(m["id"], `${at}.id`, 200),
        kind,
        name: str(m["name"], `${at}.name`, 200),
        color: str(m["color"], `${at}.color`, 100),
        avatar: optStr(m["avatar"], `${at}.avatar`, 500),
        text: str(m["text"], `${at}.text`, 10_000),
        ts: ts ?? 0,
      });
    });
    return defined<BoardThread>({ id, node: optStr(t["node"], `${where}.node`, 500), x, y, resolved: resolved === true ? true : undefined, messages });
  });
}

/** A page's content: nodes, edges, viewport and threads (`prefix` names where, for errors). */
function parseContent(raw: Record<string, unknown>, prefix: string): Pick<Board, "nodes" | "edges" | "viewport" | "threads"> {
  const nodesRaw = raw["nodes"] ?? [];
  const edgesRaw = raw["edges"] ?? [];
  if (!Array.isArray(nodesRaw) || nodesRaw.length > 10_000) throw new BoardError(`${prefix}nodes: expected a list`);
  if (!Array.isArray(edgesRaw) || edgesRaw.length > 50_000) throw new BoardError(`${prefix}edges: expected a list`);
  const nodes = nodesRaw.map((n, i): BoardNode => {
    const where = `${prefix}nodes[${i}]`;
    if (!isObj(n)) throw new BoardError(`${where}: expected an object`);
    const type = n["type"];
    if (typeof type !== "string" || !KIND.test(type)) throw new BoardError(`${where}.type: expected a kind (a word)`);
    return defined<BoardNode>({
      id: str(n["id"], `${where}.id`, 500),
      type,
      x: coord(n["x"], `${where}.x`),
      y: coord(n["y"], `${where}.y`),
      w: coord(n["w"], `${where}.w`),
      h: coord(n["h"], `${where}.h`),
      parent: optStr(n["parent"], `${where}.parent`, 500),
      data: parseData(n["data"], `${where}.data`),
      extra: extraOf(n, NODE_KEYS),
    });
  });
  const edges = edgesRaw.map((e, i): BoardEdge => {
    const where = `${prefix}edges[${i}]`;
    if (!isObj(e)) throw new BoardError(`${where}: expected an object`);
    return defined<BoardEdge>({
      id: str(e["id"], `${where}.id`, 500),
      source: str(e["source"], `${where}.source`, 500),
      target: str(e["target"], `${where}.target`, 500),
      sourceHandle: optStr(e["sourceHandle"], `${where}.sourceHandle`, 100),
      targetHandle: optStr(e["targetHandle"], `${where}.targetHandle`, 100),
      label: optStr(e["label"], `${where}.label`),
      tone: optStr(e["tone"], `${where}.tone`, 100),
      extra: extraOf(e, EDGE_FILE_KEYS),
    });
  });
  let viewport: BoardViewport | undefined;
  const vp = raw["viewport"];
  if (vp !== undefined) {
    if (!isObj(vp)) throw new BoardError(`${prefix}viewport: expected an object`);
    const x = coord(vp["x"], `${prefix}viewport.x`);
    const y = coord(vp["y"], `${prefix}viewport.y`);
    const zoom = coord(vp["zoom"], `${prefix}viewport.zoom`);
    if (x === undefined || y === undefined || zoom === undefined) throw new BoardError(`${prefix}viewport: expected x, y and zoom`);
    viewport = { x, y, zoom };
  }
  return defined<Pick<Board, "nodes" | "edges" | "viewport" | "threads">>({ nodes, edges, viewport, threads: parseThreads(raw["threads"], prefix) });
}

/**
 * `pages`: every page in order. page-1's entry is its id and title (its content is the top level);
 * a list without page-1 while the top level has content gets page-1 back in front, so nothing on
 * it is lost.
 */
function parsePages(v: unknown, top: Pick<Board, "nodes" | "edges" | "threads">): BoardPage[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.length > MAX_PAGES) throw new BoardError("pages: expected a list");
  const seen = new Set<string>();
  const pages = v.map((p, i): BoardPage => {
    const where = `pages[${i}]`;
    if (!isObj(p)) throw new BoardError(`${where}: expected an object`);
    const id = str(p["id"], `${where}.id`, 40);
    if (!PAGE_ID.test(id)) throw new BoardError(`${where}.id: expected lowercase letters, digits and "-"`);
    if (seen.has(id)) throw new BoardError(`${where}.id: ${id} is used twice`);
    seen.add(id);
    const title = str(p["title"] ?? "", `${where}.title`, 500);
    return id === FIRST_PAGE ? { id, title } : { id, title, ...parseContent(p, `${where}.`) };
  });
  if (pages.length === 0) return undefined;
  if (!seen.has(FIRST_PAGE) && (top.nodes.length > 0 || top.edges.length > 0 || (top.threads?.length ?? 0) > 0)) pages.unshift({ id: FIRST_PAGE, title: FIRST_PAGE_TITLE });
  return pages;
}

/**
 * Native `board::parse` (a newer `version` refused), except that nothing is dropped: node kinds,
 * keys and data keys this build does not know are kept (`extra`, a node's `type` as written) and
 * written back by `boardText`. Throws `BoardError`.
 */
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
  const top = parseContent(raw, "");
  return defined<Board>({
    version,
    title: optStr(raw["title"], "title") ?? "",
    layout: layout as CanvasLayout | undefined,
    ...top,
    pages: parsePages(raw["pages"], top),
    extra: extraOf(raw, BOARD_KEYS),
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
    ["system", d.system],
    ["viewport", d.viewport],
    ...extraFields(d.extra),
  ]);
  return obj.fields.some(([, v]) => v !== undefined) ? obj : undefined;
}

/** Any JSON value from the file, as it was (numbers as JavaScript prints them, which read back the same). */
function anyJson(v: unknown): Json {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.map(anyJson);
  if (isObj(v)) return new Obj(Object.entries(v).map(([k, x]): [string, Json] => [k, anyJson(x)]));
  return new Raw(JSON.stringify(v ?? null));
}

/** Keys this build does not know, written after the ones it does, in the order the file had them. */
const extraFields = (extra: Record<string, unknown> | undefined): [string, Json][] => (extra === undefined ? [] : Object.entries(extra).map(([k, v]): [string, Json] => [k, anyJson(v)]));

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
    ...extraFields(n.extra),
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
    ...extraFields(e.extra),
  ]);

const threadObj = (t: BoardThread): Obj =>
  new Obj([
    ["id", t.id],
    ["node", t.node],
    ["x", f32(t.x)],
    ["y", f32(t.y)],
    ["resolved", t.resolved === true ? new Raw("true") : undefined],
    [
      "messages",
      t.messages.map(
        (m) =>
          new Obj([
            ["id", m.id],
            ["kind", m.kind],
            ["name", m.name],
            ["color", m.color],
            ["avatar", m.avatar],
            ["text", m.text],
            ["ts", new Raw(String(Math.round(m.ts)))],
          ]),
      ),
    ],
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

const viewportObj = (vp: BoardViewport | undefined): Obj | undefined =>
  vp &&
  new Obj([
    ["x", f32(vp.x)],
    ["y", f32(vp.y)],
    ["zoom", f32(vp.zoom)],
  ]);

const threadsJson = (threads: BoardThread[] | undefined): Json | undefined => (threads !== undefined && threads.length > 0 ? threads.map(threadObj) : undefined);

const pageObj = (p: BoardPage): Obj =>
  p.id === FIRST_PAGE
    ? new Obj([
        ["id", p.id],
        ["title", p.title],
      ])
    : new Obj([
        ["id", p.id],
        ["title", p.title],
        ["nodes", (p.nodes ?? []).map(nodeObj)],
        ["edges", (p.edges ?? []).map(edgeObj)],
        ["viewport", viewportObj(p.viewport)],
        ["threads", threadsJson(p.threads)],
      ]);

/**
 * Native `board::to_text`: the same board always gives the same text, byte for byte what native
 * EvaOS writes, so an unchanged board never rewrites its file in either app. Relay's own fields
 * come last and only when there is something in them, so a board without them is unchanged:
 * `threads` (page-1's comment pins), then `pages` (every page in order; page-1's entry is just its
 * id and title, its content being the top level).
 */
export function boardText(board: Board): string {
  const root = new Obj([
    ["version", new Raw(String(board.version))],
    ["title", board.title],
    ["layout", board.layout],
    ["nodes", board.nodes.map(nodeObj)],
    ["edges", board.edges.map(edgeObj)],
    ["viewport", viewportObj(board.viewport)],
    ["threads", threadsJson(board.threads)],
    ["pages", board.pages !== undefined && !isSinglePage(board.pages) ? board.pages.map(pageObj) : undefined],
    ...extraFields(board.extra),
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

/** Sets a plain value on `m` (removed when undefined), only when it changed. */
function setPlain(m: Y.Map<unknown>, k: string, v: unknown): void {
  if (v === undefined) {
    if (m.has(k)) m.delete(k);
  } else if (!sameJson(m.get(k), v)) m.set(k, v);
}

/** A plain JSON object kept on a map (`extra`, `dataExtra`), or undefined. */
function plainObj(v: unknown): Record<string, unknown> | undefined {
  return isObj(v) && Object.keys(v).length > 0 ? v : undefined;
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
  if (n.extra !== undefined) m.set("extra", n.extra);
  if (n.data?.extra !== undefined) m.set("dataExtra", n.data.extra);
  return m;
}

function edgeMap(e: BoardEdge): Y.Map<unknown> {
  const m = new Y.Map<unknown>();
  for (const k of EDGE_KEYS) if (e[k] !== undefined) m.set(k, e[k]);
  if (e.extra !== undefined) m.set("extra", e.extra);
  return m;
}

function boardThreadMap(t: BoardThread): ThreadMap {
  const anchor: ThreadAnchor = t.node === undefined ? { x: t.x, y: t.y } : { node: t.node, x: t.x, y: t.y };
  return threadMap(anchor, t.resolved === true, t.messages);
}

/** A page's content in file shape. */
type PageContent = Pick<Board, "nodes" | "edges" | "viewport" | "threads">;

const EMPTY: PageContent = { nodes: [], edges: [] };

function setMeta(meta: Y.Map<unknown>, board: Board): void {
  if (meta.get("version") !== board.version) meta.set("version", board.version);
  if (meta.get("title") !== board.title) meta.set("title", board.title);
  if (board.layout === undefined) {
    if (meta.has("layout")) meta.delete("layout");
  } else if (meta.get("layout") !== board.layout) meta.set("layout", board.layout);
  setPlain(meta, "extra", board.extra);
}

function setViewport(meta: Y.Map<unknown>, page: string, vp: BoardViewport | undefined): void {
  const k = pageKey("viewport", page);
  if (vp === undefined) {
    if (meta.has(k)) meta.delete(k);
  } else if (!sameJson(meta.get(k), vp)) meta.set(k, vp);
}

function seedPage(doc: Y.Doc, page: string, content: PageContent): void {
  const maps = pageMaps(doc, page);
  maps.nodes.clear();
  maps.edges.clear();
  maps.threads.clear();
  for (const n of content.nodes) maps.nodes.set(n.id, nodeMap(n));
  for (const e of content.edges) maps.edges.set(e.id, edgeMap(e));
  for (const t of content.threads ?? []) maps.threads.set(t.id, boardThreadMap(t));
  setViewport(metaOf(doc), page, content.viewport);
}

/** The pages a board says it has (page-1 alone when it says nothing). */
const pageInfos = (board: Board): PageInfo[] => (board.pages ?? [{ id: FIRST_PAGE, title: FIRST_PAGE_TITLE }]).map((p) => ({ id: p.id, title: p.title }));

/** Page `id`'s content in `board`: the top level for page-1, else its entry (empty when it has none). */
function contentOf(board: Board, id: string): PageContent {
  if (id === FIRST_PAGE) return board;
  const p = board.pages?.find((q) => q.id === id);
  return p === undefined ? EMPTY : { nodes: p.nodes ?? [], edges: p.edges ?? [], ...(p.viewport ? { viewport: p.viewport } : {}), ...(p.threads ? { threads: p.threads } : {}) };
}

/** Replaces the doc's board (every page's nodes, edges, threads and viewport, meta title/layout/pages) with `board`, in one transaction. */
export function seedDoc(doc: Y.Doc, board: Board, origin: unknown = "seed"): void {
  doc.transact(() => {
    const before = pagesOf(doc);
    const pages = pageInfos(board);
    for (const p of before) if (!pages.some((q) => q.id === p.id)) seedPage(doc, p.id, EMPTY);
    setMeta(metaOf(doc), board);
    setPages(doc, pages);
    // page-1's maps are seeded even when the board has no page-1: they are the doc's originals.
    seedPage(doc, FIRST_PAGE, board);
    for (const p of pages) if (p.id !== FIRST_PAGE) seedPage(doc, p.id, contentOf(board, p.id));
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
  const dataExtra = plainObj(m.get("dataExtra"));
  if (dataExtra !== undefined) data["extra"] = dataExtra;
  const type = m.get("type");
  const num = (k: string): number | undefined => {
    const v = m.get(k);
    return typeof v === "number" && Number.isFinite(v) ? v : undefined;
  };
  const parent = m.get("parent");
  return defined<BoardNode>({
    id,
    type: typeof type === "string" && KIND.test(type) ? type : "note",
    x: num("x"),
    y: num("y"),
    w: num("w"),
    h: num("h"),
    parent: typeof parent === "string" ? parent : undefined,
    data: Object.keys(data).length > 0 ? data : undefined,
    extra: plainObj(m.get("extra")),
  });
}

/** A page of the doc in file shape. */
export function exportPage(doc: Y.Doc, page: string): PageContent {
  const maps = pageMaps(doc, page);
  const nodes: BoardNode[] = [];
  for (const [id, m] of maps.nodes) nodes.push(exportNode(id, m));
  const edges: BoardEdge[] = [];
  for (const [id, m] of maps.edges) {
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
        extra: plainObj(m.get("extra")),
      }),
    );
  }
  // Oldest thread first, so every room writes the same text for the same threads.
  const threads = snapThreads(maps.threads)
    .sort((a, b) => (a.messages[0]?.ts ?? 0) - (b.messages[0]?.ts ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((t) => defined<BoardThread>({ id: t.id, node: t.anchor.node, x: t.anchor.x, y: t.anchor.y, resolved: t.resolved ? true : undefined, messages: t.messages }));
  const viewport = metaOf(doc).get(pageKey("viewport", page));
  return defined<PageContent>({
    nodes,
    edges,
    viewport: isObj(viewport) ? (viewport as unknown as BoardViewport) : undefined,
    threads: threads.length > 0 ? threads : undefined,
  });
}

/** The doc's board in file shape; `boardText(exportBoard(doc))` is what the room writes. */
export function exportBoard(doc: Y.Doc): Board {
  const meta = metaOf(doc);
  const version = meta.get("version");
  const layout = meta.get("layout");
  const infos = pagesOf(doc);
  const pages = isSinglePage(infos)
    ? undefined
    : infos.map((p): BoardPage => (p.id === FIRST_PAGE ? { id: p.id, title: p.title } : { id: p.id, title: p.title, ...exportPage(doc, p.id) }));
  return defined<Board>({
    version: typeof version === "number" ? version : CANVAS_VERSION,
    title: typeof meta.get("title") === "string" ? (meta.get("title") as string) : "",
    layout: typeof layout === "string" && LAYOUTS.includes(layout) ? (layout as CanvasLayout) : undefined,
    ...exportPage(doc, FIRST_PAGE),
    pages,
    extra: plainObj(meta.get("extra")),
  });
}

/**
 * Copies page `from` (nodes, edges, viewport; not its comment threads) to a new page `id` right
 * after it. False when `from` is unknown or `id` is bad or taken.
 */
export function duplicatePage(doc: Y.Doc, from: string, id: string, title: string): boolean {
  const pages = pagesOf(doc);
  const i = pages.findIndex((p) => p.id === from);
  if (i < 0 || !PAGE_ID.test(id) || pages.some((p) => p.id === id) || pages.length >= MAX_PAGES) return false;
  const { nodes, edges, viewport } = exportPage(doc, from);
  pages.splice(i + 1, 0, { id, title: title.trim() === "" ? `${pages[i]?.title ?? "Page"} copy` : title.trim() });
  doc.transact(() => {
    seedPage(doc, id, viewport ? { nodes, edges, viewport } : { nodes, edges });
    setPages(doc, pages);
  });
  return true;
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

/** One page of `mergeBoardIntoDoc`: `board`'s content into `maps`, relative to `was` (see there). */
function mergePage(maps: PageMaps, meta: Y.Map<unknown>, page: string, board: PageContent, was: PageContent, stale: boolean): void {
  const { nodes, edges } = maps;
  const baseNodes = new Map(was.nodes.map((n) => [n.id, n]));
  const baseEdges = new Map(was.edges.map((e) => [e.id, e]));
  if (!sameJson(board.viewport, was.viewport)) setViewport(meta, page, board.viewport);

  const incomingIds = new Set(board.nodes.map((n) => n.id));
  for (const id of baseNodes.keys()) if (!incomingIds.has(id) && nodes.has(id)) nodes.delete(id);
  for (const n of board.nodes) {
    const was = baseNodes.get(n.id);
    const m = nodes.get(n.id);
    if (m === undefined) {
      // New from the writer, or deleted in the room since `base` and still in a stale file: only re-add the former.
      if (was === undefined || !stale) nodes.set(n.id, nodeMap(n));
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
    // Keys a writer does not know are only ever added or changed: one that drops them (EvaOS, an older Relay) leaves the room's.
    if (n.extra !== undefined && !sameJson(n.extra, was?.extra)) setPlain(m, "extra", n.extra);
    if (n.data?.extra !== undefined && !sameJson(n.data.extra, was?.data?.extra)) setPlain(m, "dataExtra", n.data.extra);
  }

  const incomingEdges = new Set(board.edges.map((e) => e.id));
  for (const id of baseEdges.keys()) if (!incomingEdges.has(id) && edges.has(id)) edges.delete(id);
  for (const e of board.edges) {
    const was = baseEdges.get(e.id);
    const m = edges.get(e.id);
    if (m === undefined) {
      if (was === undefined || !stale) edges.set(e.id, edgeMap(e));
      continue;
    }
    for (const k of EDGE_KEYS) {
      if (was !== undefined && e[k] === was[k]) continue;
      const v = e[k];
      if (v === undefined) m.delete(k);
      else if (m.get(k) !== v) m.set(k, v);
    }
    if (e.extra !== undefined && !sameJson(e.extra, was?.extra)) setPlain(m, "extra", e.extra);
  }

  // A writer that has no `threads` (EvaOS, older Relays, agents writing nodes only) leaves the room's pins alone.
  if (board.threads === undefined) return;
  const threads = maps.threads;
  const baseThreads = new Map((was.threads ?? []).map((t) => [t.id, t]));
  const incomingThreads = new Set(board.threads.map((t) => t.id));
  for (const id of baseThreads.keys()) if (!incomingThreads.has(id) && threads.has(id)) threads.delete(id);
  for (const t of board.threads) {
    const was = baseThreads.get(t.id);
    const m = threads.get(t.id);
    if (m === undefined) {
      if (was === undefined || !stale) threads.set(t.id, boardThreadMap(t));
      continue;
    }
    if (was === undefined || t.node !== was.node || t.x !== was.x || t.y !== was.y) {
      if (t.node === undefined) m.delete("node");
      else if (m.get("node") !== t.node) m.set("node", t.node);
      if (m.get("x") !== t.x) m.set("x", t.x);
      if (m.get("y") !== t.y) m.set("y", t.y);
    }
    const resolved = t.resolved === true;
    if ((was === undefined || resolved !== (was.resolved === true)) && m.get("resolved") !== resolved) m.set("resolved", resolved);
    // Messages are only ever added: the writer's new ones join the room's.
    const list = m.get("messages");
    if (!(list instanceof Y.Array)) continue;
    const have = new Set((list as Y.Array<ThreadMsg>).toArray().map((msg) => msg.id));
    const added = t.messages.filter((msg) => !have.has(msg.id));
    if (added.length > 0) (list as Y.Array<ThreadMsg>).push(added);
  }
}

/**
 * Merges a board written by someone else into the doc by id: nodes and edges added, removed and
 * updated, title/body through `spliceText`. With `base` (the board as this room last wrote or
 * read it) only what the writer changed relative to `base` is applied, so a stale writer never
 * undoes edits made in the room since; without it, the doc is brought to `board`. Threads merge
 * the same way by id (their messages are only ever added), and not at all when `board` has none.
 * Pages likewise: each page merges into its own maps, a page the writer dropped (relative to
 * `base`) goes, and a board without `pages` leaves the room's pages as they are.
 */
export function mergeBoardIntoDoc(doc: Y.Doc, board: Board, origin: unknown, base?: Board): void {
  const baseBoard = base ?? exportBoard(doc);
  const stale = base !== undefined;
  doc.transact(() => {
    const meta = metaOf(doc);
    if (board.title !== baseBoard.title) meta.set("title", board.title);
    if (board.version !== baseBoard.version) meta.set("version", board.version);
    if (board.layout !== baseBoard.layout) {
      if (board.layout === undefined) meta.delete("layout");
      else meta.set("layout", board.layout);
    }
    if (board.extra !== undefined && !sameJson(board.extra, baseBoard.extra)) setPlain(meta, "extra", board.extra);
    mergePage(pageMaps(doc, FIRST_PAGE), meta, FIRST_PAGE, board, baseBoard, stale);

    if (board.pages === undefined) return;
    const pages = pageInfos(board);
    const basePages = pageInfos(baseBoard);
    for (const p of basePages) {
      if (p.id === FIRST_PAGE || pages.some((q) => q.id === p.id)) continue;
      const maps = pageMaps(doc, p.id);
      maps.nodes.clear();
      maps.edges.clear();
      maps.threads.clear();
      setViewport(meta, p.id, undefined);
    }
    if (!sameJson(pages, basePages)) setPages(doc, pages);
    for (const p of pages) {
      if (p.id === FIRST_PAGE) continue;
      const known = basePages.some((q) => q.id === p.id);
      mergePage(pageMaps(doc, p.id), meta, p.id, contentOf(board, p.id), known ? contentOf(baseBoard, p.id) : EMPTY, stale);
    }
  }, origin);
}
