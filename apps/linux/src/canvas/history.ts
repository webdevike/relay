// A board's change log on disk, `<canvases>/<slug>.history.jsonl` (canvas-live `history.ts` has the
// entry format and the folding), and the recorder that fills it from a live room's doc: who added,
// changed, moved or deleted what, on which page, with enough saved of a deleted card or link to put
// it back. Moves and text edits come in bursts (a drag, an agent typing), so they are folded into one
// entry per burst; everything else is written the moment it happens.

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import * as Y from "yjs";
import { exportEdge, exportNode, type BoardEdge, type BoardNode } from "@relay/canvas-live/board";
import { HISTORY_KEEP, HISTORY_SLACK, historyLine, parseHistory, rotated, type HistoryEntry, type HistoryKind, type HistoryOp, type HistoryRole } from "@relay/canvas-live/history";
import { pageMaps, pagesOf } from "@relay/canvas-live/pages";
import { DOC_KEYS } from "@relay/canvas-live/shared";
import { excerpt, snapThread } from "@relay/canvas-live/threads";

export function historyPath(dir: string, slug: string): string {
  return join(dir, `${slug}.history.jsonl`);
}

export class BoardHistory {
  /** Lines in the file, once known (read lazily, then counted as lines are appended). */
  private lines: number | null = null;

  constructor(readonly path: string) {}

  /** Appends `entry`; trims the file to its newest entries once it has grown well past its cap. */
  append(entry: HistoryEntry): void {
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, historyLine(entry));
    this.lines = this.lines === null ? this.fileLines().length : this.lines + 1;
    if (this.lines <= HISTORY_KEEP * HISTORY_SLACK) return;
    const kept = rotated(this.fileLines());
    if (kept === null) return;
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, `${kept.join("\n")}\n`);
    renameSync(tmp, this.path);
    this.lines = kept.length;
  }

  private fileLines(): string[] {
    return this.text().split("\n").filter((l) => l !== "");
  }

  private text(): string {
    return existsSync(this.path) ? readFileSync(this.path, "utf8") : "";
  }

  /** The entries after `since` (epoch ms), oldest first; with `limit`, the newest that many. */
  read(options: { since?: number; limit?: number } = {}): HistoryEntry[] {
    const all = parseHistory(this.text()).filter((e) => options.since === undefined || e.ts > options.since);
    return options.limit === undefined ? all : all.slice(-options.limit);
  }
}

export interface Who {
  readonly name: string;
  readonly role: HistoryRole;
}

/** How long a burst of moves or edits on one thing may pause before it is written as one entry. */
const BURST_MS = 1_200;
/** A burst that keeps going is written at least this often. */
const BURST_MAX_MS = 5_000;
/** An add by someone is followed by that someone's typing: edits within this long of it are the add. */
const ADD_GRACE_MS = 60_000;

const key = (...parts: string[]): string => parts.join("\u0000");

interface Burst {
  entry: HistoryEntry;
  firstAt: number;
  timer: ReturnType<typeof setTimeout>;
}

export class HistoryRecorder {
  private readonly nodes = new Map<string, BoardNode>();
  private readonly edges = new Map<string, BoardEdge>();
  private readonly pages = new Map<string, string>();
  private readonly watched = new Map<string, () => void>();
  private readonly bursts = new Map<string, Burst>();
  private readonly recentAdds = new Map<string, number>();
  private readonly restoring = new Set<string>();
  private stopped = false;
  private readonly onPages = (): void => {
    this.syncPages();
  };

  /** `who` names whoever made the transaction with `origin` (a peer, `agent`, `participant:<id>`, `file`, `host`). */
  constructor(
    private readonly doc: Y.Doc,
    private readonly history: BoardHistory,
    private readonly who: (origin: unknown) => Who,
    private readonly now: () => number = Date.now,
  ) {}

  /** Starts recording; what is on the board now is the baseline. */
  start(): void {
    for (const page of pagesOf(this.doc)) {
      this.pages.set(page.id, page.title);
      this.watch(page.id);
    }
    this.doc.getMap<unknown>(DOC_KEYS.meta).observe(this.onPages);
  }

  /** Writes what is pending and stops. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.doc.getMap<unknown>(DOC_KEYS.meta).unobserve(this.onPages);
    for (const off of this.watched.values()) off();
    this.watched.clear();
    this.flush();
  }

  /** The next add of node or edge `id` on `page` is a restore of what was deleted. */
  markRestore(page: string, id: string): void {
    this.restoring.add(key(page, id));
  }

  /** Writes the folded moves and edits now. */
  flush(): void {
    for (const burst of this.bursts.values()) {
      clearTimeout(burst.timer);
      this.history.append(burst.entry);
    }
    this.bursts.clear();
  }

  private syncPages(): void {
    const who = this.who("host");
    const now = pagesOf(this.doc);
    const ids = new Set(now.map((p) => p.id));
    for (const page of now) {
      const was = this.pages.get(page.id);
      if (was === undefined) {
        this.pages.set(page.id, page.title);
        this.watch(page.id);
        this.write(who, "add", "page", page.id, page.title, page.id);
      } else if (was !== page.title) {
        this.pages.set(page.id, page.title);
        this.write(who, "update", "page", page.id, page.title, page.id);
      }
    }
    for (const [id, title] of [...this.pages]) {
      if (ids.has(id)) continue;
      this.pages.delete(id);
      this.watched.get(id)?.();
      this.watched.delete(id);
      this.write(who, "delete", "page", id, title, id);
    }
  }

  private watch(page: string): void {
    const maps = pageMaps(this.doc, page);
    for (const [id, m] of maps.nodes) this.nodes.set(key(page, id), exportNode(id, m));
    for (const [id, m] of maps.edges) this.edges.set(key(page, id), exportEdge(id, m));
    const onNodes = (events: Y.YEvent<Y.AbstractType<unknown>>[], tr: Y.Transaction): void => {
      this.onNodes(page, maps.nodes, events, tr);
    };
    const onEdges = (events: Y.YEvent<Y.AbstractType<unknown>>[], tr: Y.Transaction): void => {
      this.onEdges(page, maps.edges, events, tr);
    };
    const onThreads = (events: Y.YEvent<Y.AbstractType<unknown>>[], tr: Y.Transaction): void => {
      this.onThreads(page, maps.threads, events, tr);
    };
    maps.nodes.observeDeep(onNodes);
    maps.edges.observeDeep(onEdges);
    maps.threads.observeDeep(onThreads);
    this.watched.set(page, () => {
      maps.nodes.unobserveDeep(onNodes);
      maps.edges.unobserveDeep(onEdges);
      maps.threads.unobserveDeep(onThreads);
    });
  }

  private onNodes(page: string, nodes: Y.Map<Y.Map<unknown>>, events: Y.YEvent<Y.AbstractType<unknown>>[], tr: Y.Transaction): void {
    const who = this.who(tr.origin);
    const touched = new Set<string>();
    for (const event of events) {
      if (event.target === nodes) {
        for (const [id, change] of (event as Y.YMapEvent<Y.Map<unknown>>).changes.keys) {
          const k = key(page, id);
          if (change.action === "delete") {
            const was = this.nodes.get(k);
            this.nodes.delete(k);
            this.write(who, "delete", "node", id, was?.data?.title ?? "", page, was);
          } else {
            touched.add(id);
            const m = nodes.get(id);
            const label = m === undefined ? "" : (exportNode(id, m).data?.title ?? "");
            if (change.action === "add") this.added(who, "node", id, label, page);
            else this.write(who, "update", "node", id, label, page);
          }
        }
        continue;
      }
      const id = event.path[0];
      if (typeof id !== "string" || !nodes.has(id)) continue;
      touched.add(id);
      const keys = event instanceof Y.YMapEvent ? [...(event.keysChanged as Set<string>)] : [];
      const moved = keys.length > 0 && keys.every((k) => k === "x" || k === "y");
      const label = this.nodes.get(key(page, id))?.data?.title ?? "";
      this.burst(who, moved ? "move" : "update", "node", id, label, page);
    }
    for (const id of touched) {
      const m = nodes.get(id);
      if (m !== undefined) this.nodes.set(key(page, id), exportNode(id, m));
    }
  }

  private onEdges(page: string, edges: Y.Map<Y.Map<unknown>>, events: Y.YEvent<Y.AbstractType<unknown>>[], tr: Y.Transaction): void {
    const who = this.who(tr.origin);
    const ends = (e: BoardEdge | undefined): string => (e === undefined ? "" : `${e.source} → ${e.target}${e.label === undefined ? "" : ` ${e.label}`}`);
    for (const event of events) {
      if (event.target !== edges) {
        const id = event.path[0];
        if (typeof id === "string" && edges.has(id)) this.burst(who, "update", "edge", id, ends(this.edges.get(key(page, id))), page);
        continue;
      }
      for (const [id, change] of (event as Y.YMapEvent<Y.Map<unknown>>).changes.keys) {
        const k = key(page, id);
        if (change.action === "delete") {
          const was = this.edges.get(k);
          this.edges.delete(k);
          this.write(who, "delete", "edge", id, ends(was), page, was);
          continue;
        }
        const m = edges.get(id);
        const edge = m === undefined ? undefined : exportEdge(id, m);
        if (edge !== undefined) this.edges.set(k, edge);
        if (change.action === "add") this.added(who, "edge", id, ends(edge), page);
        else this.write(who, "update", "edge", id, ends(edge), page);
      }
    }
    for (const [id, m] of edges) this.edges.set(key(page, id), exportEdge(id, m));
  }

  private onThreads(page: string, threads: Y.Map<Y.Map<unknown>>, events: Y.YEvent<Y.AbstractType<unknown>>[], tr: Y.Transaction): void {
    const who = this.who(tr.origin);
    const label = (id: string): string => {
      const t = threads.get(id);
      const snap = t === undefined ? null : snapThread(id, t);
      return excerpt(snap?.messages[0]?.text ?? "", 50);
    };
    for (const event of events) {
      if (event.target === threads) {
        for (const [id, change] of (event as Y.YMapEvent<Y.Map<unknown>>).changes.keys) {
          if (change.action === "delete") this.write(who, "delete", "thread", id, "", page);
          else if (change.action === "add") this.added(who, "thread", id, label(id), page);
        }
        continue;
      }
      const id = event.path[0];
      if (typeof id !== "string" || !threads.has(id)) continue;
      if (event instanceof Y.YMapEvent) {
        const keys = [...(event.keysChanged as Set<string>)].filter((k) => k !== "assignee");
        if (keys.length === 0) continue;
        // A pin dragged to another card or spot: x, y or the card it hangs on changed.
        const moved = keys.every((k) => k === "x" || k === "y" || k === "node");
        this.burst(who, moved ? "move" : "update", "thread", id, label(id), page);
      } else this.burst(who, "update", "thread", id, label(id), page);
    }
  }

  /** An add (or the restore it is marked as); edits by the same hand soon after are the add itself. */
  private added(who: Who, kind: HistoryKind, id: string, label: string, page: string): void {
    const k = key(page, id);
    const restored = this.restoring.delete(k);
    this.recentAdds.set(key(who.name, kind, k), this.now());
    this.write(who, restored ? "restore" : "add", kind, id, label, page);
  }

  private write(who: Who, op: HistoryOp, kind: HistoryKind, id: string, label: string, page: string, saved?: BoardNode | BoardEdge): void {
    // What was moved or edited just before is written first, so the file reads in the order it happened.
    this.flush();
    this.history.append({ ts: this.now(), who: who.name, role: who.role, op, kind, id, label, page, ...(saved === undefined ? {} : { saved }) });
  }

  /** A move or edit: folded with the ones just before it on the same thing by the same hand. */
  private burst(who: Who, op: HistoryOp, kind: HistoryKind, id: string, label: string, page: string): void {
    const at = this.now();
    const added = this.recentAdds.get(key(who.name, kind, key(page, id)));
    if (op === "update" && added !== undefined && at - added < ADD_GRACE_MS) return;
    const k = key(who.name, op, kind, page, id);
    const was = this.bursts.get(k);
    const firstAt = was?.firstAt ?? at;
    if (was !== undefined) clearTimeout(was.timer);
    const entry: HistoryEntry = { ts: at, who: who.name, role: who.role, op, kind, id, label, page, count: (was?.entry.count ?? 0) + 1 };
    const timer = setTimeout(
      () => {
        const burst = this.bursts.get(k);
        if (burst === undefined) return;
        this.bursts.delete(k);
        this.history.append(burst.entry);
      },
      Math.max(0, Math.min(BURST_MS, firstAt + BURST_MAX_MS - at)),
    );
    timer.unref();
    this.bursts.set(k, { entry, firstAt, timer });
  }
}
