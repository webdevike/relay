// One participant's hands on a live board: its presence (cursor, selection, caret, bubble, status)
// in an Awareness, and the action lines (dsl.ts) run as animated CRDT edits in the room's Y.Doc.
// The room's canvas self (agent.ts) and every agent that joins with `canvas join` (participant.ts)
// act through one of these, so a board edit looks the same whoever makes it: the cursor glides to
// the spot, the node appears, the text is typed in. Each actor tags its doc updates with its own
// origin; concurrent actors only interleave transactions on the host's single doc, which Yjs merges.
// Typing is chunked, so two actors typing into one field at once would interleave their letters:
// a field takes one typist at a time (the others wait their turn), different fields type at once.
// An actor is on one page of the board at a time (pages.ts; its presence names it): `@page` and
// `@page_add` move it, and its node, edge and pin actions land on that page.

import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import { placeUnplaced, type LayoutNode } from "@relay/canvas-live/layout";
import { addPage, FIRST_PAGE, MAX_PAGES, PAGE_ID, pageMaps, pagesOf, type PageMaps } from "@relay/canvas-live/pages";
import { DOC_KEYS, type NodeKind, type Presence, type TextField, type User } from "@relay/canvas-live/shared";
import { anchorFor, openThread, pinAt, postInThread, setResolved, THREAD_ID, type ThreadAnchor, type ThreadMap, type ThreadMsg } from "@relay/canvas-live/threads";
import { liveRefusal } from "../query/openui";
import { protoSourceRefusal } from "../../../../packages/widget-runtime/src/proto";
import { DESIGN_SYSTEMS, isDesignSystem } from "../../../../packages/widget-runtime/src/systems";
import type { Action, TextStream } from "./dsl";

const ease = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
export function sleep(ms: number): Promise<undefined> {
  const { promise, resolve } = Promise.withResolvers<undefined>();
  setTimeout(resolve, ms, undefined);
  return promise;
}

/** Doc updates the room's canvas self makes carry this origin. */
export const AGENT_ORIGIN = "agent";

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ActorOptions {
  /** Cursor tween frame; tests shorten the animation. */
  readonly frameMs?: number;
  /** Delay per typed chunk. */
  readonly typeMs?: number;
  /** Nudge new notes and images off occupied spots; default `CANVAS_AVOID_OVERLAP=1`, else off. */
  readonly avoidOverlap?: boolean;
}

/**
 * Collision avoidance is off for now: cards land exactly where the agent asked, so it can group
 * them inside frames. `CANVAS_AVOID_OVERLAP=1` in the host's environment turns the nudging back on.
 */
export const AVOID_OVERLAP = process.env["CANVAS_AVOID_OVERLAP"] === "1";

export const str = (m: Y.Map<unknown>, k: string): string => {
  const v = m.get(k);
  return v instanceof Y.Text ? v.toJSON() : typeof v === "string" ? v : "";
};
export const num = (m: Y.Map<unknown>, k: string): number | undefined => {
  const v = m.get(k);
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
};

/** OpenUI Lang source: starts with `root =` or reads a `Query(`. */
export function looksLikeOpenUI(body: string): boolean {
  return /^\s*root\s*=/.test(body) || body.includes("Query(");
}

/** Appended to the reason a note that holds OpenUI is refused, so the brain knows the right action. */
export const OPENUI_NOTE_REFUSAL = "that text is OpenUI; OpenUI never goes in a note body (notes show it as raw text)";

/**
 * Whether the text streaming into `text` is OpenUI after its first `skipLines` lines (a title).
 * Decides from the first body line once it is complete, so ordinary notes still type live.
 */
export async function openUiAhead(text: TextStream, skipLines: number): Promise<boolean> {
  while (!text.closed && text.text.split("\n").length <= skipLines + 1) await text.changed();
  return looksLikeOpenUI(text.text.split("\n").slice(skipLines).join("\n"));
}

/** The text field each doc has a typist in, as a queue: the last typist's turn resolves when it is done. */
const typists = new WeakMap<Y.Doc, Map<string, Promise<void>>>();

/** Runs `fn` once every earlier typist on field `key` of `doc` is done; later ones wait for it. */
async function oneTypist<T>(doc: Y.Doc, key: string, fn: () => Promise<T>): Promise<T> {
  let fields = typists.get(doc);
  if (fields === undefined) {
    fields = new Map();
    typists.set(doc, fields);
  }
  const before = fields.get(key) ?? Promise.resolve();
  const { promise: done, resolve } = Promise.withResolvers<undefined>();
  const turn = before.then(() => done);
  fields.set(key, turn);
  await before;
  try {
    return await fn();
  } finally {
    resolve(undefined);
    if (fields.get(key) === turn) fields.delete(key);
  }
}

export class CanvasActor {
  presence: Presence;
  cursor: { x: number; y: number };
  private closed = false;
  /** The page this actor is on (pages.ts): its cursor, selection, caret and edits are there. */
  private current: string = FIRST_PAGE;
  private maps: PageMaps;
  private said = 0;
  /** Absolute positions of nodes the file gives none, by page, recomputed when the board changes. */
  private readonly placed = new Map<string, Map<string, { x: number; y: number }>>();
  private readonly onDocUpdate = (): void => {
    this.placed.clear();
  };

  constructor(
    private readonly doc: Y.Doc,
    private readonly awareness: Awareness,
    readonly user: User,
    /** The origin this actor's doc updates carry. */
    readonly origin: string,
    private readonly options: ActorOptions,
    start: { x: number; y: number } = { x: -300, y: 240 },
  ) {
    this.maps = pageMaps(doc, FIRST_PAGE);
    this.cursor = { ...start };
    this.presence = { user, cursor: this.cursor, status: "idle", selected: [], page: FIRST_PAGE };
    awareness.setLocalState(this.presence);
    doc.on("update", this.onDocUpdate);
  }

  /** The page this actor is on. */
  get page(): string {
    return this.current;
  }

  /** The nodes of the page this actor is on. */
  get nodes(): Y.Map<Y.Map<unknown>> {
    return this.maps.nodes;
  }

  get edges(): Y.Map<Y.Map<unknown>> {
    return this.maps.edges;
  }

  get threads(): Y.Map<ThreadMap> {
    return this.maps.threads;
  }

  /** True when the board has page `id`. */
  hasPage(id: string): boolean {
    return pagesOf(this.doc).some((p) => p.id === id);
  }

  /** Goes to page `id`: its presence says so, and its selection, caret and connector are dropped (they were on the old page). */
  setPage(id: string): void {
    if (id === this.current) return;
    this.current = id;
    this.maps = pageMaps(this.doc, id);
    this.setP({ page: id, selected: [], typing: null, connecting: null });
  }

  /** The page thread `id` is on: this actor's page first (thread ids are per page), then the board's pages in order; null when none has it. */
  threadPage(id: string): string | null {
    if (this.threads.has(id)) return this.current;
    return pagesOf(this.doc).find((p) => pageMaps(this.doc, p.id).threads.has(id))?.id ?? null;
  }

  /** Stops publishing presence and edits (the room or the participant is gone). */
  dispose(): void {
    this.closed = true;
    this.doc.off("update", this.onDocUpdate);
  }

  setP(patch: Partial<Presence>): void {
    this.presence = { ...this.presence, ...patch };
    if (!this.closed) this.awareness.setLocalState(this.presence);
  }

  async glide(tx: number, ty: number, onFrame?: (x: number, y: number) => void): Promise<void> {
    const from = { ...this.cursor };
    const dist = Math.hypot(tx - from.x, ty - from.y);
    const frame = this.options.frameMs ?? 33;
    const dur = frame === 0 ? 0 : Math.min(520, Math.max(160, 120 + dist * 0.16));
    const t0 = performance.now();
    for (;;) {
      const t = dur === 0 ? 1 : Math.min(1, (performance.now() - t0) / dur);
      const e = ease(t);
      this.cursor = { x: from.x + (tx - from.x) * e, y: from.y + (ty - from.y) * e };
      onFrame?.(this.cursor.x, this.cursor.y);
      this.setP({ cursor: this.cursor });
      if (t >= 1) return;
      await sleep(frame);
    }
  }

  freeSpot(x: number, y: number, w: number, h: number): { x: number; y: number } {
    const pad = 40;
    const boxes = [...this.nodes.keys()].map((id) => this.box(id)).filter((b): b is Box => b !== null);
    const clear = (cx: number, cy: number): boolean => boxes.every((b) => cx + w + pad <= b.x || cx >= b.x + b.w + pad || cy + h + pad <= b.y || cy >= b.y + b.h + pad);
    if (clear(x, y)) return { x, y };
    // Rings of candidates around the requested spot, nearest first.
    for (let r = 60; r <= 2400; r += 60) {
      const candidates: [number, number][] = [
        [x + r, y],
        [x, y + r],
        [x - r, y],
        [x, y - r],
        [x + r, y + r],
        [x + r, y - r],
      ];
      for (const [cx, cy] of candidates) if (clear(cx, cy)) return { x: cx, y: cy };
    }
    return { x, y };
  }

  /**
   * Glides to (x, y). With overlap avoidance on, that is the free spot nearest (x, y), looked at
   * again on arrival (another actor may have put a card there meanwhile). Resolves with the spot.
   */
  private async arriveAt(x: number, y: number, w: number, h: number): Promise<{ x: number; y: number }> {
    this.setP({ status: "moving" });
    if (!(this.options.avoidOverlap ?? AVOID_OVERLAP)) {
      await this.glide(x + 30, y + 24);
      return { x, y };
    }
    let spot = this.freeSpot(x, y, w, h);
    for (let tries = 0; tries < 3; tries++) {
      await this.glide(spot.x + 30, spot.y + 24);
      const again = this.freeSpot(spot.x, spot.y, w, h);
      if (again.x === spot.x && again.y === spot.y) break;
      spot = again;
    }
    return spot;
  }

  /** Where a node of `page` (default: this actor's) is: its own x/y, else where the layout puts it (as the clients draw it). */
  box(id: string, page: string = this.current): Box | null {
    const m = (page === this.current ? this.maps : pageMaps(this.doc, page)).nodes.get(id);
    if (!m) return null;
    let x = num(m, "x");
    let y = num(m, "y");
    if (x === undefined || y === undefined) {
      let placed = this.placed.get(page);
      if (placed === undefined) {
        placed = this.layout(page);
        this.placed.set(page, placed);
      }
      const at = placed.get(id);
      if (!at) return null;
      x = at.x;
      y = at.y;
    }
    const w = num(m, "w") ?? 240;
    const fallbackH = m.get("type") === "image" ? w * 0.75 + 40 : 160;
    return { x, y, w, h: num(m, "h") ?? fallbackH };
  }

  /** Where thread `id`'s pin is on `page` (default: this actor's); null when there is no such thread or its node is gone. */
  pin(id: string, page: string = this.current): { x: number; y: number } | null {
    const t = (page === this.current ? this.maps : pageMaps(this.doc, page)).threads.get(id);
    if (t === undefined) return null;
    const node = t.get("node");
    const x = num(t, "x") ?? 0;
    const y = num(t, "y") ?? 0;
    return typeof node === "string" ? pinAt({ node, x, y }, this.box(node, page)) : { x, y };
  }

  /** A thread message from this actor, saying `text`. */
  threadMessage(text: string): ThreadMsg {
    this.said += 1;
    const { name, color, avatar } = this.user;
    return { id: `${this.origin}-${Date.now().toString(36)}-${String(this.said)}`, kind: "agent", name, color, ...(avatar === undefined ? {} : { avatar }), text, ts: Date.now() };
  }

  private layout(page: string): Map<string, { x: number; y: number }> {
    const maps = pageMaps(this.doc, page);
    const nodes: LayoutNode[] = [];
    for (const [id, m] of maps.nodes) {
      const node: LayoutNode = { id, type: (m.get("type") ?? "note") as NodeKind, title: str(m, "title"), body: str(m, "body"), caption: str(m, "caption"), sample: str(m, "sample") };
      for (const k of ["x", "y", "w", "h"] as const) {
        const v = num(m, k);
        if (v !== undefined) node[k] = v;
      }
      const parent = m.get("parent");
      if (typeof parent === "string") node.parent = parent;
      nodes.push(node);
    }
    const edges = [...maps.edges.values()].map((e) => ({ source: str(e, "source"), target: str(e, "target") }));
    const layout = this.doc.getMap(DOC_KEYS.meta).get("layout");
    return placeUnplaced(nodes, edges, layout === "grid" || layout === "tree" || layout === "flow" ? layout : undefined);
  }

  /** True when `id` is `ancestor` or sits (at any depth) inside it. */
  private isUnder(id: string, ancestor: string): boolean {
    const seen = new Set<string>();
    let cur: string | undefined = id;
    while (cur !== undefined && !seen.has(cur)) {
      if (cur === ancestor) return true;
      seen.add(cur);
      const p: unknown = this.nodes.get(cur)?.get("parent");
      cur = typeof p === "string" ? p : undefined;
    }
    return false;
  }

  /** Sets a node's frame from where it is: the smallest frame holding it fully, else none. Coordinates stay absolute. */
  private autoParent(id: string): void {
    const m = this.nodes.get(id);
    const b = this.box(id);
    if (!m || !b) return;
    let best: string | null = null;
    let bestArea = Number.POSITIVE_INFINITY;
    for (const [fid, f] of this.nodes) {
      if (fid === id || f.get("type") !== "frame") continue;
      const fb = this.box(fid);
      if (!fb) continue;
      const area = fb.w * fb.h;
      if (area <= b.w * b.h || area >= bestArea) continue;
      if (b.x >= fb.x && b.y >= fb.y && b.x + b.w <= fb.x + fb.w && b.y + b.h <= fb.y + fb.h) {
        best = fid;
        bestArea = area;
      }
    }
    if (best === null) {
      if (m.has("parent")) m.delete("parent");
    } else if (m.get("parent") !== best) m.set("parent", best);
  }

  /** A new frame takes in the nodes whose center is inside it (unless a smaller frame already holds them). */
  private adopt(frameId: string): void {
    const fb = this.box(frameId);
    if (!fb) return;
    const area = fb.w * fb.h;
    for (const [id, m] of this.nodes) {
      if (id === frameId) continue;
      const b = this.box(id);
      if (!b || b.w * b.h >= area) continue;
      const cx = b.x + b.w / 2;
      const cy = b.y + b.h / 2;
      if (cx < fb.x || cy < fb.y || cx > fb.x + fb.w || cy > fb.y + fb.h) continue;
      const cur = m.get("parent");
      const curBox = typeof cur === "string" ? this.box(cur) : null;
      if (curBox && curBox.w * curBox.h <= area) continue;
      if (this.isUnder(frameId, id)) continue;
      m.set("parent", frameId);
    }
  }

  /**
   * A note whose body is OpenUI becomes a `ui` node (same id and spot) when it checks, else is
   * refused with why. Undefined: an ordinary note, carry on.
   */
  private async openUiNote(a: Extract<Action, { kind: "add_node" }>, markEdit: () => void): Promise<string | null | undefined> {
    if (!(await openUiAhead(a.text, 1))) return undefined;
    const converted = await this.run({ kind: "add_ui", id: a.id, x: a.x, y: a.y, w: a.w, h: null, text: a.text }, markEdit);
    return converted === null ? null : `${converted}; ${OPENUI_NOTE_REFUSAL}. Use @add_ui <id> <x> <y> <w>, then the title line and the program, @end`;
  }

  /**
   * Runs one action as an animated edit. Resolves with null when it ran, or why it did not (an
   * unknown node id, a taken id); `@say` lines are not actions and never come here.
   */
  async run(a: Action, markEdit: () => void = () => undefined): Promise<string | null> {
    if (this.closed) return "left the room";
    // Its page was deleted under it: carry on on the board's first page, not in a page nobody sees.
    const pages = pagesOf(this.doc);
    if (!pages.some((p) => p.id === this.current)) this.setPage(pages[0]?.id ?? FIRST_PAGE);
    const transact = (fn: () => void): void => {
      this.doc.transact(fn, this.origin);
      markEdit();
    };
    const missing = (id: string): string => `no node ${id}`;
    switch (a.kind) {
      case "point": {
        const b = this.box(a.id);
        if (!b) return missing(a.id);
        this.setP({ status: "moving" });
        await this.glide(b.x + Math.min(b.w - 30, 180), b.y + Math.min(b.h - 10, 40));
        return null;
      }
      case "cursor": {
        this.setP({ status: "moving" });
        await this.glide(a.x, a.y);
        return null;
      }
      case "select": {
        const b = this.box(a.id);
        if (!b) return missing(a.id);
        this.setP({ status: "moving" });
        await this.glide(b.x + b.w - 30, b.y + 26);
        this.setP({ selected: [a.id] });
        return null;
      }
      case "set_text":
      case "append_text":
        return oneTypist(this.doc, `${this.current}/${a.id}:${a.field}`, async () => {
          const b = this.box(a.id);
          const yt = this.nodes.get(a.id)?.get(a.field);
          if (!b || !(yt instanceof Y.Text)) return missing(a.id);
          this.setP({ status: "moving" });
          await this.glide(b.x + 40, b.y + (a.field === "title" ? 24 : 60));
          // A live widget's source lands whole and only once it checks: typed char by char it
          // would render a half program in every client meanwhile.
          const kind = this.nodes.get(a.id)?.get("type");
          if (a.field === "body" && kind !== "ui" && kind !== "proto" && (await openUiAhead(a.text, 0))) {
            while (!a.text.closed) await a.text.changed();
            if (looksLikeOpenUI(a.text.text)) return `${OPENUI_NOTE_REFUSAL}; use @set_text on a ui node, or @add_ui for a new widget`;
          }
          if (a.field === "body" && (kind === "ui" || kind === "proto")) {
            while (!a.text.closed) await a.text.changed();
            const source = a.kind === "set_text" ? a.text.text.trim() : `${yt.toJSON()}\n${a.text.text.trim()}`;
            if (kind === "ui") {
              const refused = liveRefusal(source);
              if (refused !== null) return `openui: ${refused}`;
            } else {
              const system = this.nodes.get(a.id)?.get("system");
              const refused = protoSourceRefusal(source, isDesignSystem(system) ? system : "mantine");
              if (refused !== null) return `jsx: ${refused}`;
            }
            this.setP({ selected: [a.id], status: "typing" });
            transact(() => {
              yt.delete(0, yt.length);
              yt.insert(0, source);
            });
            return null;
          }
          if (a.kind === "set_text") {
            this.setP({ selected: [a.id], status: "typing", typing: { nodeId: a.id, field: a.field, index: 0, selectAll: true } });
            await sleep(this.options.typeMs === 0 ? 0 : 140);
            transact(() => {
              yt.delete(0, yt.length);
            });
          } else {
            this.setP({ selected: [a.id], status: "typing" });
            if (yt.length > 0) {
              transact(() => {
                yt.insert(yt.length, "\n");
              });
            }
          }
          await this.type(a.id, [a.field], a.text, markEdit);
          return null;
        });
      case "add_node":
      case "add_frame": {
        if (a.kind === "add_node") {
          const converted = await this.openUiNote(a, markEdit);
          if (converted !== undefined) return converted;
        }
        if (this.nodes.has(a.id)) return `id ${a.id} is taken`;
        // A frame is always placed exactly (it sits behind the cards it groups); notes too unless
        // overlap avoidance is on, which nudges them until they clear every node.
        const spot = a.kind === "add_frame" ? { x: a.x, y: a.y } : await this.arriveAt(a.x, a.y, a.w, 220);
        if (a.kind === "add_frame") {
          this.setP({ status: "moving" });
          await this.glide(spot.x + 30, spot.y + 24);
        }
        if (this.nodes.has(a.id)) return `id ${a.id} is taken`;
        const m = new Y.Map<unknown>();
        m.set("type", a.kind === "add_frame" ? "frame" : a.type);
        m.set("x", Math.round(spot.x));
        m.set("y", Math.round(spot.y));
        m.set("w", Math.round(a.w));
        if (a.kind === "add_frame") m.set("h", Math.round(a.h));
        m.set("title", new Y.Text(""));
        m.set("body", new Y.Text(""));
        m.set("fields", []);
        transact(() => {
          this.nodes.set(a.id, m);
          if (a.kind === "add_frame") this.adopt(a.id);
          else this.autoParent(a.id);
        });
        this.setP({ selected: [a.id], status: "typing" });
        await this.type(a.id, ["title", "body"], a.text, markEdit);
        return null;
      }
      case "add_ui": {
        if (this.nodes.has(a.id)) return `id ${a.id} is taken`;
        // Title on the first line, the OpenUI source after it; checked before anything lands.
        while (!a.text.closed) await a.text.changed();
        const [title = "", ...rest] = a.text.text.split("\n");
        const source = rest.join("\n").trim();
        const refused = liveRefusal(source);
        if (refused !== null) return `openui: ${refused}`;
        const spot = await this.arriveAt(a.x, a.y, a.w, a.h ?? 320);
        if (this.nodes.has(a.id)) return `id ${a.id} is taken`;
        const m = new Y.Map<unknown>();
        m.set("type", "ui");
        m.set("x", Math.round(spot.x));
        m.set("y", Math.round(spot.y));
        m.set("w", Math.round(a.w));
        if (a.h !== null) m.set("h", Math.round(a.h));
        m.set("title", new Y.Text(title.trim()));
        m.set("body", new Y.Text(source));
        m.set("fields", []);
        transact(() => {
          this.nodes.set(a.id, m);
          this.autoParent(a.id);
        });
        this.setP({ selected: [a.id], status: "idle" });
        return null;
      }
      case "add_proto": {
        if (this.nodes.has(a.id)) return `id ${a.id} is taken`;
        if (!isDesignSystem(a.system)) return `unknown design system "${a.system}" (use ${DESIGN_SYSTEMS.join(", ")})`;
        // Title on the first line, the JSX after it; it lands whole, and only once it compiles.
        while (!a.text.closed) await a.text.changed();
        const [title = "", ...rest] = a.text.text.split("\n");
        const source = rest.join("\n").trim();
        const refused = protoSourceRefusal(source, a.system);
        if (refused !== null) return `jsx: ${refused}`;
        const spot = await this.arriveAt(a.x, a.y, a.w, a.h ?? 640);
        if (this.nodes.has(a.id)) return `id ${a.id} is taken`;
        const m = new Y.Map<unknown>();
        m.set("type", "proto");
        m.set("x", Math.round(spot.x));
        m.set("y", Math.round(spot.y));
        m.set("w", Math.round(a.w));
        m.set("h", Math.round(a.h ?? 640));
        m.set("title", new Y.Text(title.trim()));
        m.set("body", new Y.Text(source));
        m.set("system", a.system);
        if (a.viewport === "mobile") m.set("viewport", "mobile");
        m.set("fields", []);
        transact(() => {
          this.nodes.set(a.id, m);
          this.autoParent(a.id);
        });
        this.setP({ selected: [a.id], status: "idle" });
        return null;
      }
      case "add_image": {
        if (this.nodes.has(a.id)) return `id ${a.id} is taken`;
        if (/^[a-z][a-z0-9+.-]*:/i.test(a.src) && !/^https:/i.test(a.src)) return `src must be an https URL or a local file path, not ${a.src.slice(0, 60)}`;
        if (isAbsolute(a.src) && !existsSync(a.src)) return `no image file at ${a.src}`;
        // Title on the first line, the caption after it; the card is placed once both are known.
        while (!a.text.closed) await a.text.changed();
        const [title = "", ...rest] = a.text.text.split("\n");
        const caption = rest.join(" ").trim();
        const spot = await this.arriveAt(a.x, a.y, a.w, Math.round(a.w * 0.75 + 40));
        if (this.nodes.has(a.id)) return `id ${a.id} is taken`;
        const m = new Y.Map<unknown>();
        m.set("type", "image");
        m.set("x", Math.round(spot.x));
        m.set("y", Math.round(spot.y));
        m.set("w", Math.round(a.w));
        m.set("title", new Y.Text(title.trim()));
        m.set("body", new Y.Text(""));
        m.set("src", a.src);
        if (caption !== "") m.set("caption", caption);
        if (/^https?:/i.test(a.src)) m.set("url", a.src);
        m.set("fields", []);
        transact(() => {
          this.nodes.set(a.id, m);
          this.autoParent(a.id);
        });
        this.setP({ selected: [a.id], status: "idle" });
        return null;
      }
      case "move_node": {
        const b = this.box(a.id);
        const m = this.nodes.get(a.id);
        if (!b || !m) return missing(a.id);
        this.setP({ status: "moving" });
        await this.glide(b.x + 30, b.y + 20);
        this.setP({ selected: [a.id] });
        await this.glide(a.x + 30, a.y + 20, (x, y) => {
          transact(() => {
            m.set("x", Math.round(x - 30));
            m.set("y", Math.round(y - 20));
          });
        });
        transact(() => {
          this.autoParent(a.id);
        });
        return null;
      }
      case "parent": {
        const m = this.nodes.get(a.id);
        if (!m) return missing(a.id);
        if (a.frame !== null) {
          const f = this.nodes.get(a.frame);
          if (!f) return missing(a.frame);
          if (f.get("type") !== "frame") return `${a.frame} is not a frame`;
          if (this.isUnder(a.frame, a.id)) return `${a.frame} is inside ${a.id}`;
        }
        transact(() => {
          if (a.frame === null) m.delete("parent");
          else m.set("parent", a.frame);
        });
        return null;
      }
      case "add_edge": {
        const s = this.box(a.source);
        const t = this.box(a.target);
        if (!s) return missing(a.source);
        if (!t) return missing(a.target);
        const horizontal = Math.abs(t.x + t.w / 2 - (s.x + s.w / 2)) > Math.abs(t.y + t.h / 2 - (s.y + s.h / 2));
        const [sh, th] = horizontal ? (t.x > s.x ? ["right", "left"] : ["left", "right"]) : t.y > s.y ? ["bottom", "top"] : ["top", "bottom"];
        const port = (b: Box, h: string): { x: number; y: number } =>
          h === "right" ? { x: b.x + b.w, y: b.y + b.h / 2 } : h === "left" ? { x: b.x, y: b.y + b.h / 2 } : h === "bottom" ? { x: b.x + b.w / 2, y: b.y + b.h } : { x: b.x + b.w / 2, y: b.y };
        const sp = port(s, sh);
        const tp = port(t, th);
        this.setP({ status: "moving" });
        await this.glide(sp.x, sp.y);
        this.setP({ status: "drawing", connecting: { source: a.source } });
        await this.glide(tp.x, tp.y);
        const e = new Y.Map<unknown>();
        e.set("source", a.source);
        e.set("target", a.target);
        e.set("sourceHandle", sh);
        e.set("targetHandle", th);
        if (a.label !== "") e.set("label", a.label);
        transact(() => {
          this.edges.set(`e-${a.source}-${a.target}`, e);
        });
        this.setP({ connecting: null });
        return null;
      }
      case "delete": {
        const b = this.box(a.id);
        if (!b) return missing(a.id);
        this.setP({ status: "moving" });
        await this.glide(b.x + b.w - 30, b.y + 26);
        this.setP({ selected: [a.id] });
        await sleep(this.options.typeMs === 0 ? 0 : 250);
        transact(() => {
          this.nodes.delete(a.id);
          for (const [eid, e] of this.edges) if (e.get("source") === a.id || e.get("target") === a.id) this.edges.delete(eid);
        });
        this.setP({ selected: [] });
        return null;
      }
      case "reply": {
        const page = this.threadPage(a.thread);
        if (page === null) return `no thread ${a.thread}`;
        // A thread on another page is answered without the cursor going there.
        const at = page === this.current ? this.pin(a.thread) : null;
        if (at !== null) {
          this.setP({ status: "moving" });
          await this.glide(at.x + 18, at.y + 10);
        }
        transact(() => {
          postInThread(pageMaps(this.doc, page).threads, a.thread, this.threadMessage(a.text));
        });
        return null;
      }
      case "pin": {
        if (!THREAD_ID.test(a.id)) return `thread id ${a.id}: use letters, digits, ".", "_" or "-"`;
        if (this.threads.has(a.id)) return `thread ${a.id} is taken`;
        let anchor: ThreadAnchor = { x: Math.round(a.x), y: Math.round(a.y) };
        if (a.node !== null) {
          const b = this.box(a.node);
          if (!b) return missing(a.node);
          anchor = anchorFor(null, { id: a.node, box: b });
        }
        this.setP({ status: "moving" });
        const at = pinAt(anchor, a.node === null ? null : this.box(a.node)) ?? anchor;
        await this.glide(at.x + 18, at.y + 10);
        transact(() => {
          openThread(this.threads, a.id, anchor, this.threadMessage(a.text));
        });
        return null;
      }
      case "resolve": {
        const page = this.threadPage(a.thread);
        if (page === null) return `no thread ${a.thread}`;
        transact(() => {
          setResolved(pageMaps(this.doc, page).threads, a.thread, a.resolved);
        });
        return null;
      }
      case "page_add": {
        if (!PAGE_ID.test(a.id)) return `page id ${a.id}: use lowercase letters, digits and "-", at most 40 characters`;
        if (pages.some((p) => p.id === a.id)) return `page ${a.id} is taken`;
        if (pages.length >= MAX_PAGES) return `the board already has ${String(MAX_PAGES)} pages`;
        if (!this.doc.transact(() => addPage(this.doc, a.id, a.title, this.current), this.origin)) return `page ${a.id} could not be added`;
        markEdit();
        this.setPage(a.id);
        return null;
      }
      case "page":
        if (!pages.some((p) => p.id === a.id)) return `no page ${a.id} (pages: ${pages.map((p) => p.id).join(", ")})`;
        this.setPage(a.id);
        return null;
      case "handoff":
        // The canvas self's turn routes its handoffs before they get here (agent.ts).
        return "only the room's canvas self hands work off";
    }
  }

  /** Types streamed text into one or more fields; a newline in a non-final field advances to the next. */
  private async type(nodeId: string, fields: TextField[], stream: TextStream, markEdit: () => void): Promise<void> {
    let fi = 0;
    let consumed = 0;
    // The page it started on, even if the actor moves to another page meanwhile.
    const nodes = this.nodes;
    const textOf = (f: TextField | undefined): Y.Text | null => {
      const t = f === undefined ? null : nodes.get(nodeId)?.get(f);
      return t instanceof Y.Text ? t : null;
    };
    const first = textOf(fields[0]);
    if (!first) return;
    let yt: Y.Text = first;
    let rel = Y.createRelativePositionFromTypeIndex(yt, yt.length);
    this.setP({ status: "typing", typing: { nodeId, field: fields[0] ?? "body", index: yt.length } });
    for (;;) {
      const backlog = stream.text.length - consumed;
      if (backlog === 0) {
        if (stream.closed) break;
        await stream.changed();
        continue;
      }
      // Faster than a person, and it catches up when the model outruns the typist.
      let n = Math.min(backlog, Math.max(3, Math.ceil(backlog / 8)));
      let chunk = stream.text.slice(consumed, consumed + n);
      const nl = chunk.indexOf("\n");
      const advance = nl >= 0 && fi < fields.length - 1;
      if (advance) {
        chunk = chunk.slice(0, nl);
        n = nl + 1;
      }
      const idx = Y.createAbsolutePositionFromRelativePosition(rel, this.doc)?.index ?? yt.length;
      const target = yt;
      if (chunk !== "") {
        this.doc.transact(() => {
          target.insert(idx, chunk);
        }, this.origin);
        markEdit();
      }
      consumed += n;
      rel = Y.createRelativePositionFromTypeIndex(yt, idx + chunk.length);
      if (advance) {
        fi++;
        const next = textOf(fields[fi]);
        if (!next) return;
        yt = next;
        rel = Y.createRelativePositionFromTypeIndex(yt, yt.length);
      }
      this.setP({ typing: { nodeId, field: fields[fi] ?? "body", index: Y.createAbsolutePositionFromRelativePosition(rel, this.doc)?.index ?? 0 } });
      await sleep(this.options.typeMs ?? 16);
    }
    this.setP({ typing: null });
  }
}
