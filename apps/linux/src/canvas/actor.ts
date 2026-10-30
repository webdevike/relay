// One participant's hands on a live board: its presence (cursor, selection, caret, bubble, status)
// in an Awareness, and the action lines (dsl.ts) run as animated CRDT edits in the room's Y.Doc.
// The room's canvas self (agent.ts) and every agent that joins with `canvas join` (participant.ts)
// act through one of these, so a board edit looks the same whoever makes it: the cursor glides to
// the spot, the node appears, the text is typed in. Each actor tags its doc updates with its own
// origin; concurrent actors only interleave transactions on the host's single doc, which Yjs merges.
// Typing is chunked, so two actors typing into one field at once would interleave their letters:
// a field takes one typist at a time (the others wait their turn), different fields type at once.

import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import { placeUnplaced, type LayoutNode } from "@relay/canvas-live/layout";
import { DOC_KEYS, type NodeKind, type Presence, type TextField, type User } from "@relay/canvas-live/shared";
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
}

export const str = (m: Y.Map<unknown>, k: string): string => {
  const v = m.get(k);
  return v instanceof Y.Text ? v.toJSON() : typeof v === "string" ? v : "";
};
export const num = (m: Y.Map<unknown>, k: string): number | undefined => {
  const v = m.get(k);
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
};

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
  readonly nodes: Y.Map<Y.Map<unknown>>;
  readonly edges: Y.Map<Y.Map<unknown>>;
  /** Absolute positions of nodes the file gives none, recomputed when the board changes. */
  private placed: Map<string, { x: number; y: number }> | null = null;
  private readonly onDocUpdate = (): void => {
    this.placed = null;
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
    this.nodes = doc.getMap(DOC_KEYS.nodes);
    this.edges = doc.getMap(DOC_KEYS.edges);
    this.cursor = { ...start };
    this.presence = { user, cursor: this.cursor, status: "idle", selected: [] };
    awareness.setLocalState(this.presence);
    doc.on("update", this.onDocUpdate);
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
   * Glides to the free spot nearest (x, y) and looks again on arrival: another actor may have put
   * a card there meanwhile. Resolves with the spot that is still free.
   */
  private async arriveAtFreeSpot(x: number, y: number, w: number, h: number): Promise<{ x: number; y: number }> {
    let spot = this.freeSpot(x, y, w, h);
    this.setP({ status: "moving" });
    for (let tries = 0; tries < 3; tries++) {
      await this.glide(spot.x + 30, spot.y + 24);
      const again = this.freeSpot(spot.x, spot.y, w, h);
      if (again.x === spot.x && again.y === spot.y) break;
      spot = again;
    }
    return spot;
  }

  /** Where a node is: its own x/y, else where the layout puts it (as the clients draw it). */
  box(id: string): Box | null {
    const m = this.nodes.get(id);
    if (!m) return null;
    let x = num(m, "x");
    let y = num(m, "y");
    if (x === undefined || y === undefined) {
      this.placed ??= this.layout();
      const at = this.placed.get(id);
      if (!at) return null;
      x = at.x;
      y = at.y;
    }
    const w = num(m, "w") ?? 240;
    const fallbackH = m.get("type") === "image" ? w * 0.75 + 40 : 160;
    return { x, y, w, h: num(m, "h") ?? fallbackH };
  }

  private layout(): Map<string, { x: number; y: number }> {
    const nodes: LayoutNode[] = [];
    for (const [id, m] of this.nodes) {
      const node: LayoutNode = { id, type: (m.get("type") ?? "note") as NodeKind, title: str(m, "title"), body: str(m, "body"), caption: str(m, "caption"), sample: str(m, "sample") };
      for (const k of ["x", "y", "w", "h"] as const) {
        const v = num(m, k);
        if (v !== undefined) node[k] = v;
      }
      const parent = m.get("parent");
      if (typeof parent === "string") node.parent = parent;
      nodes.push(node);
    }
    const edges = [...this.edges.values()].map((e) => ({ source: str(e, "source"), target: str(e, "target") }));
    const layout = this.doc.getMap(DOC_KEYS.meta).get("layout");
    return placeUnplaced(nodes, edges, layout === "grid" || layout === "tree" || layout === "flow" ? layout : undefined);
  }

  /**
   * Runs one action as an animated edit. Resolves with null when it ran, or why it did not (an
   * unknown node id, a taken id); `@say` lines are not actions and never come here.
   */
  async run(a: Action, markEdit: () => void = () => undefined): Promise<string | null> {
    if (this.closed) return "left the room";
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
        return oneTypist(this.doc, `${a.id}:${a.field}`, async () => {
          const b = this.box(a.id);
          const yt = this.nodes.get(a.id)?.get(a.field);
          if (!b || !(yt instanceof Y.Text)) return missing(a.id);
          this.setP({ status: "moving" });
          await this.glide(b.x + 40, b.y + (a.field === "title" ? 24 : 60));
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
        if (this.nodes.has(a.id)) return `id ${a.id} is taken`;
        // Models misjudge free space; nudge a note's spot until it clears every node (again on
        // arrival: another agent may have filled it meanwhile). A frame is placed exactly: it is
        // meant to sit behind the nodes it groups.
        const spot = a.kind === "add_frame" ? { x: a.x, y: a.y } : await this.arriveAtFreeSpot(a.x, a.y, a.w, 220);
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
        });
        this.setP({ selected: [a.id], status: "typing" });
        await this.type(a.id, ["title", "body"], a.text, markEdit);
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
        const spot = await this.arriveAtFreeSpot(a.x, a.y, a.w, Math.round(a.w * 0.75 + 40));
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
    }
  }

  /** Types streamed text into one or more fields; a newline in a non-final field advances to the next. */
  private async type(nodeId: string, fields: TextField[], stream: TextStream, markEdit: () => void): Promise<void> {
    let fi = 0;
    let consumed = 0;
    const textOf = (f: TextField | undefined): Y.Text | null => {
      const t = f === undefined ? null : this.nodes.get(nodeId)?.get(f);
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
