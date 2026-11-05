// A board's change log: who changed what on it, and when. The host keeps it next to the board
// (`<slug>.history.jsonl`, one JSON entry per line, append-only, rotated), so an agent that comes
// back to a board it worked on is told what happened meanwhile ("Isaac deleted 6 cards (mm-*) on
// Page 2 at 21:54") instead of being surprised by it, and a deleted card or link can be put back.
// Pure helpers: reading the lines, folding entries into the short summary, rotating; the fs is the
// host's (and Relay Desktop's, for the pin moves it logs on a board without a room).

import type { BoardEdge, BoardNode } from "./board";

export type HistoryOp = "add" | "update" | "move" | "delete" | "restore";
export type HistoryKind = "node" | "edge" | "thread" | "page";
export type HistoryRole = "human" | "agent" | "worker";

export interface HistoryEntry {
  /** Epoch ms. */
  ts: number;
  /** Isaac, the canvas self's name, or a worker's. */
  who: string;
  role: HistoryRole;
  op: HistoryOp;
  kind: HistoryKind;
  /** The node, edge, thread or page id. */
  id: string;
  /** A short label: a card's title, a link's ends, a comment's first words, a page's title. */
  label: string;
  /** The page it happened on. */
  page: string;
  /** Moves and updates folded into this entry. */
  count?: number | undefined;
  /** What a delete removed, enough to put it back (nodes and edges). */
  saved?: BoardNode | BoardEdge;
}

/** The entries a board keeps before the oldest go; rotation trims to this many when a file reaches `HISTORY_SLACK` times it. */
export const HISTORY_KEEP = 2_000;
export const HISTORY_SLACK = 1.25;

const KINDS: Record<HistoryKind, [string, string]> = {
  node: ["card", "cards"],
  edge: ["link", "links"],
  thread: ["comment thread", "comment threads"],
  page: ["page", "pages"],
};
const VERBS: Record<HistoryOp, string> = { add: "added", update: "changed", move: "moved", delete: "deleted", restore: "restored" };

/** One entry as a file line. */
export function historyLine(entry: HistoryEntry): string {
  return `${JSON.stringify(entry)}\n`;
}

const isOp = (v: unknown): v is HistoryOp => v === "add" || v === "update" || v === "move" || v === "delete" || v === "restore";
const isKind = (v: unknown): v is HistoryKind => v === "node" || v === "edge" || v === "thread" || v === "page";

/** The entries in a log's text, oldest first; a line that is not an entry (a torn write, another format) is skipped. */
export function parseHistory(text: string): HistoryEntry[] {
  const out: HistoryEntry[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const raw = JSON.parse(line) as Partial<HistoryEntry> | null;
      if (raw === null || typeof raw !== "object" || !isOp(raw.op) || !isKind(raw.kind)) continue;
      if (typeof raw.ts !== "number" || typeof raw.who !== "string" || typeof raw.id !== "string" || typeof raw.page !== "string") continue;
      out.push({
        ts: raw.ts,
        who: raw.who,
        role: raw.role === "agent" || raw.role === "worker" ? raw.role : "human",
        op: raw.op,
        kind: raw.kind,
        id: raw.id,
        label: typeof raw.label === "string" ? raw.label : "",
        page: raw.page,
        ...(typeof raw.count === "number" ? { count: raw.count } : {}),
        ...(raw.saved === undefined ? {} : { saved: raw.saved }),
      });
    } catch {
      // Not an entry.
    }
  }
  return out;
}

/**
 * `--since` as an epoch ms: `90s`, `30m`, `2h`, `1d` ago, an epoch in ms, or a date/time the engine
 * parses ("2026-11-05T21:00"); null when it is none of those.
 */
export function parseSince(text: string, now: number): number | null {
  const t = text.trim();
  const rel = /^(\d+(?:\.\d+)?)\s*([smhd])$/i.exec(t);
  if (rel !== null) {
    const unit = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[(rel[2] ?? "s").toLowerCase()] ?? 1_000;
    return now - Number(rel[1]) * unit;
  }
  if (/^\d{10,}$/.test(t)) return Number(t);
  const parsed = Date.parse(t);
  return Number.isNaN(parsed) ? null : parsed;
}

/** The lines to keep when a log of `lines` has grown past its slack: the newest `HISTORY_KEEP`; null while it has not. */
export function rotated(lines: readonly string[]): string[] | null {
  return lines.length > HISTORY_KEEP * HISTORY_SLACK ? lines.slice(-HISTORY_KEEP) : null;
}

/** "21:54" in the machine's local time. */
export function clock(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** The longest shared prefix of `ids` worth naming as a pattern (`mm-*`), else null. */
export function idPattern(ids: readonly string[]): string | null {
  const first = ids[0];
  if (first === undefined || ids.length < 2) return null;
  let n = first.length;
  for (const id of ids) {
    let i = 0;
    while (i < n && i < id.length && id[i] === first[i]) i++;
    n = i;
  }
  const prefix = first.slice(0, n).replace(/[0-9]+$/, "");
  return prefix.length >= 2 ? `${prefix}*` : null;
}

const quote = (label: string): string => (label === "" ? "" : ` "${label.length > 40 ? `${label.slice(0, 39)}…` : label}"`);

/** What an entry says on its own: `Isaac deleted card mm-3 "Root" on page-2 at 21:54`. */
export function describeEntry(e: HistoryEntry, titles: ReadonlyMap<string, string> = new Map()): string {
  const [one] = KINDS[e.kind];
  const where = e.kind === "page" ? "" : ` on ${titles.get(e.page) ?? e.page}`;
  const times = e.count !== undefined && e.count > 1 ? ` (${String(e.count)} times)` : "";
  return `${e.who} ${VERBS[e.op]} ${one} ${e.id}${quote(e.label)}${where}${times} at ${clock(e.ts)}`;
}

/**
 * Entries folded to one line per (who, what happened, kind, page): "Isaac deleted 6 cards (mm-*:
 * "Root", "Branch") on Page 2 at 21:54". `titles` names pages by id.
 */
export function summarizeHistory(entries: readonly HistoryEntry[], titles: ReadonlyMap<string, string> = new Map()): string[] {
  const groups = new Map<string, HistoryEntry[]>();
  for (const e of entries) {
    const key = [e.who, e.op, e.kind, e.page].join("\u0000");
    const list = groups.get(key);
    if (list === undefined) groups.set(key, [e]);
    else list.push(e);
  }
  const lines: { at: number; text: string }[] = [];
  for (const list of groups.values()) {
    const first = list[0];
    const last = list.at(-1);
    if (first === undefined || last === undefined) continue;
    const ids = [...new Set(list.map((e) => e.id))];
    const [one, many] = KINDS[first.kind];
    const verb = first.kind === "page" && first.op === "update" ? "renamed" : VERBS[first.op];
    const where = first.kind === "page" ? "" : ` on ${titles.get(first.page) ?? first.page}`;
    let what: string;
    if (ids.length === 1) {
      const times = list.length > 1 ? ` (${String(list.length)} times)` : "";
      what = `${one} ${ids[0] ?? ""}${quote(first.label)}${times}`;
    } else {
      const pattern = idPattern(ids);
      const labels = [...new Set(list.map((e) => e.label).filter((l) => l !== ""))].slice(0, 3).map((l) => `"${l.length > 30 ? `${l.slice(0, 29)}…` : l}"`);
      const inner = [pattern ?? ids.slice(0, 4).join(", "), ...labels].join(": ");
      what = `${String(ids.length)} ${many} (${inner})`;
    }
    lines.push({ at: last.ts, text: `${first.who} ${verb} ${what}${where} at ${clock(last.ts)}` });
  }
  return lines.sort((a, b) => a.at - b.at).map((l) => l.text);
}

/**
 * What an agent is told when a turn starts: the changes since its last turn, folded (`since` is when
 * that turn ended), then the last `recent` entries by anyone else than `self` as they happened. Empty
 * when nothing relevant happened. Its own edits are left out: it made them.
 */
export function sinceYourLastTurn(
  entries: readonly HistoryEntry[],
  since: number,
  self: string,
  titles: ReadonlyMap<string, string> = new Map(),
  recent = 8,
): string {
  const others = entries.filter((e) => e.who !== self);
  const fresh = others.filter((e) => e.ts > since);
  if (fresh.length === 0) return "";
  const lines = summarizeHistory(fresh, titles);
  const tail = others.slice(-recent).map((e) => describeEntry(e, titles));
  return [
    `Changes since your last turn (done on purpose by whoever is named; not bugs):`,
    ...lines.map((l) => `- ${l}`),
    "Last entries of the board's history:",
    ...tail.map((l) => `- ${l}`),
  ].join("\n");
}

/** The most recent `delete` entry that saved `id` (a node or edge), for restoring it. */
export function lastDeleted(entries: readonly HistoryEntry[], id: string, page?: string): HistoryEntry | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e?.op !== "delete" || e.id !== id || e.saved === undefined) continue;
    if (page !== undefined && e.page !== page) continue;
    return e;
  }
  return null;
}
