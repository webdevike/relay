// Comment threads and agent suggestions on a live text document (Relay Desktop's Skills editor):
// the canvas's thread model (threads.ts: the same messages, resolve and assignee) anchored to a run
// of text instead of a pin. The anchor is a pair of Yjs relative positions, so it follows edits, plus
// the quoted text, so a thread finds its text again when the doc is loaded fresh from the file.
//
// A suggestion is an agent's change offered for review, made in the doc itself (typed live at the
// agent's caret) and recorded as hunks: an inserted run of text with the text it replaced (marks
// included), or inserted blocks. Rejecting puts every hunk back exactly; accepting just forgets them.
// Pure helpers over the doc, shared by the host (agent edits, routing, the file the threads persist
// to) and the editor (highlights, the thread overlay, Accept and Reject).
//
// Y.Doc (beside the document's own keys):
//   threads:     Y.Map<threadId, Y.Map { from?: RelPos, to?: RelPos, quote: string, resolved: boolean,
//                                         assignee?: string, messages: Y.Array<ThreadMsg> }>
//   suggestions: Y.Map<suggestionId, SuggestionValue>   (plain values, written whole)

import * as Y from "yjs";
import { THREAD_ID, cleanMessage, type ThreadMap, type ThreadMsg } from "./threads";

export const DOC_THREADS = "threads";
export const DOC_SUGGESTIONS = "suggestions";

/** A `Y.RelativePosition` as JSON (`Y.relativePositionToJSON`). */
export type RelPos = Record<string, unknown>;

/** The run of text a thread is about: start and end, and the text as it was quoted. */
export interface TextAnchor {
  from: RelPos;
  to: RelPos;
  quote: string;
}

export interface DocThreadSnap {
  id: string;
  /** Null when the thread lost its text (it was deleted, or not found after a reload). */
  anchor: TextAnchor | null;
  quote: string;
  resolved: boolean;
  /** The assistant the thread is for (a registry id): replies go to it until someone else is mentioned. */
  assignee?: string;
  messages: ThreadMsg[];
}

/** A run of text with its marks, as `Y.XmlText.toDelta()` gives it. */
export interface TextRun {
  insert: string;
  attributes?: Record<string, unknown>;
}

/**
 * One change of a suggestion. `text`: `from`..`to` is the run the agent typed inside one text node,
 * `removed` the text it replaced there. `blocks`: `from`..`to` are the sibling blocks the agent
 * inserted into their parent; nothing was removed.
 */
export interface Hunk {
  kind: "text" | "blocks";
  from: RelPos;
  to: RelPos;
  removed: TextRun[];
}

export interface SuggestionAuthor {
  name: string;
  color: string;
  /** Host-relative avatar URL (`/canvas/avatar/<id>`), registry assistants only. */
  avatar?: string;
}

export interface SuggestionValue {
  /** The comment thread it answers; null for a suggestion made outside one. */
  thread: string | null;
  by: SuggestionAuthor;
  ts: number;
  hunks: Hunk[];
}

export interface SuggestionSnap extends SuggestionValue {
  id: string;
}

export const docThreadsOf = (doc: Y.Doc): Y.Map<ThreadMap> => doc.getMap<ThreadMap>(DOC_THREADS);
export const suggestionsOf = (doc: Y.Doc): Y.Map<SuggestionValue> => doc.getMap<SuggestionValue>(DOC_SUGGESTIONS);

const isRelPos = (v: unknown): v is RelPos => typeof v === "object" && v !== null && !Array.isArray(v);

/** The relative position of `index` in `type`; `assoc` -1 sticks to the character before it (a range's end). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- any Yjs type (Y.Text, Y.XmlFragment, ...)
export function relPos(type: Y.AbstractType<any>, index: number, assoc = 0): RelPos {
  return Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(type, index, assoc)) as RelPos;
}

/** Where `pos` is in `doc` now; null when its type is gone. */
export function absolute(doc: Y.Doc, pos: RelPos): Y.AbsolutePosition | null {
  try {
    return Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(pos), doc);
  } catch {
    return null;
  }
}

/** The anchor of `length` characters at `index` in one text node. */
export function textAnchor(text: Y.XmlText, index: number, length: number, quote: string): TextAnchor {
  return { from: relPos(text, index), to: relPos(text, index + length, -1), quote };
}

/** Opens thread `id` on `anchor` with its first message. False when the id is taken or invalid, or the text is empty. */
export function openDocThread(threads: Y.Map<ThreadMap>, id: string, anchor: TextAnchor, first: ThreadMsg, assignee?: string): boolean {
  if (threads.has(id) || !THREAD_ID.test(id) || first.text.trim() === "") return false;
  threads.set(id, docThreadMap(anchor.quote, anchor, false, [first], assignee));
  return true;
}

/** A thread's map (not yet in a doc); `anchor` null for a thread that has lost its text. */
export function docThreadMap(quote: string, anchor: TextAnchor | null, resolved: boolean, messages: readonly ThreadMsg[], assignee?: string): ThreadMap {
  const m = new Y.Map<unknown>();
  if (anchor !== null) {
    m.set("from", anchor.from);
    m.set("to", anchor.to);
  }
  m.set("quote", quote);
  m.set("resolved", resolved);
  if (assignee !== undefined && assignee !== "") m.set("assignee", assignee);
  const list = new Y.Array<ThreadMsg>();
  list.push(messages.map(cleanMessage));
  m.set("messages", list);
  return m;
}

/** Moves thread `id` onto `anchor` (null: it lost its text). False when there is no such thread. */
export function anchorDocThread(threads: Y.Map<ThreadMap>, id: string, anchor: TextAnchor | null): boolean {
  const t = threads.get(id);
  if (t === undefined) return false;
  const apply = (): void => {
    if (anchor === null) {
      t.delete("from");
      t.delete("to");
      return;
    }
    t.set("from", anchor.from);
    t.set("to", anchor.to);
    if (t.get("quote") !== anchor.quote) t.set("quote", anchor.quote);
  };
  if (threads.doc) threads.doc.transact(apply);
  else apply();
  return true;
}

/** Thread `id` as plain data; null when its map is malformed. */
export function snapDocThread(id: string, m: ThreadMap): DocThreadSnap | null {
  const list = m.get("messages");
  if (!(list instanceof Y.Array)) return null;
  const from = m.get("from");
  const to = m.get("to");
  const quote = typeof m.get("quote") === "string" ? (m.get("quote") as string) : "";
  const assignee = m.get("assignee");
  return {
    id,
    anchor: isRelPos(from) && isRelPos(to) ? { from, to, quote } : null,
    quote,
    resolved: m.get("resolved") === true,
    ...(typeof assignee === "string" && assignee !== "" ? { assignee } : {}),
    messages: (list as Y.Array<ThreadMsg>).toArray(),
  };
}

export function snapDocThreads(threads: Y.Map<ThreadMap>): DocThreadSnap[] {
  const out: DocThreadSnap[] = [];
  for (const [id, m] of threads) {
    const s = snapDocThread(id, m);
    if (s !== null) out.push(s);
  }
  return out;
}

/** The text of `runs`. */
export const runsText = (runs: readonly TextRun[]): string => runs.map((r) => r.insert).join("");

/** The runs of `text` from `from` to `to` (character offsets), marks kept. Embeds are skipped. */
export function sliceRuns(text: Y.XmlText, from: number, to: number): TextRun[] {
  const out: TextRun[] = [];
  let offset = 0;
  for (const op of text.toDelta() as { insert: unknown; attributes?: Record<string, unknown> }[]) {
    const length = typeof op.insert === "string" ? op.insert.length : 1;
    const start = Math.max(from, offset);
    const end = Math.min(to, offset + length);
    if (typeof op.insert === "string" && start < end) {
      const run: TextRun = { insert: op.insert.slice(start - offset, end - offset) };
      if (op.attributes !== undefined && Object.keys(op.attributes).length > 0) run.attributes = { ...op.attributes };
      out.push(run);
    }
    offset += length;
    if (offset >= to) break;
  }
  return out;
}

/** Adds `hunk` to suggestion `id`, creating it with `meta` the first time. */
export function addHunk(doc: Y.Doc, id: string, meta: Omit<SuggestionValue, "hunks">, hunk: Hunk, origin: unknown = null): void {
  const map = suggestionsOf(doc);
  doc.transact(() => {
    const was = map.get(id);
    map.set(id, was === undefined ? { ...meta, hunks: [hunk] } : { ...was, hunks: [...was.hunks, hunk] });
  }, origin);
}

/** Replaces hunk `index` of suggestion `id` (a change still being typed). False when there is no such hunk (it was accepted or rejected). */
export function setHunk(doc: Y.Doc, id: string, index: number, hunk: Hunk, origin: unknown = null): boolean {
  const map = suggestionsOf(doc);
  const was = map.get(id);
  if (was === undefined || index < 0 || index >= was.hunks.length) return false;
  doc.transact(() => {
    map.set(id, { ...was, hunks: was.hunks.map((h, i) => (i === index ? hunk : h)) });
  }, origin);
  return true;
}

export function snapSuggestions(doc: Y.Doc): SuggestionSnap[] {
  return [...suggestionsOf(doc).entries()].map(([id, value]) => ({ id, ...value }));
}

/** Where a hunk is now: its type and the index range it covers there; null when its text is gone. */
export function hunkRange(doc: Y.Doc, hunk: Hunk): { type: Y.AbstractType<unknown>; from: number; to: number } | null {
  const from = absolute(doc, hunk.from);
  const to = absolute(doc, hunk.to);
  if (!from || !to) return null;
  if (from.type !== to.type) return null;
  return { type: from.type, from: from.index, to: Math.max(from.index, to.index) };
}

/** Accepts suggestion `id`: its changes stay as they are. False when there is no such suggestion. */
export function acceptSuggestion(doc: Y.Doc, id: string, origin: unknown = null): boolean {
  const map = suggestionsOf(doc);
  if (!map.has(id)) return false;
  doc.transact(() => {
    map.delete(id);
  }, origin);
  return true;
}

/**
 * Rejects suggestion `id`: newest hunk first, typed text goes and the text it replaced comes back
 * with its marks, inserted blocks go; the thread it answers is anchored on the restored text again.
 * False when there is no such suggestion.
 */
export function rejectSuggestion(doc: Y.Doc, id: string, origin: unknown = null): boolean {
  const map = suggestionsOf(doc);
  const value = map.get(id);
  if (value === undefined) return false;
  doc.transact(() => {
    let restored: TextAnchor | null = null;
    for (const hunk of [...value.hunks].reverse()) {
      const range = hunkRange(doc, hunk);
      if (range === null) continue;
      const { type, from, to } = range;
      if (hunk.kind === "blocks") {
        if ((type instanceof Y.XmlFragment || type instanceof Y.XmlElement) && to > from) type.delete(from, to - from);
        continue;
      }
      if (!(type instanceof Y.XmlText)) continue;
      if (to > from) type.delete(from, to - from);
      let at = from;
      for (const run of hunk.removed) {
        // Explicit attributes (none for plain text) so the run never inherits the marks before it.
        type.insert(at, run.insert, run.attributes ?? {});
        at += run.insert.length;
      }
      const quote = runsText(hunk.removed);
      if (quote !== "") restored = textAnchor(type, from, quote.length, quote);
    }
    if (value.thread !== null && restored !== null) anchorDocThread(docThreadsOf(doc), value.thread, restored);
    map.delete(id);
  }, origin);
  return true;
}

/** Rejects every suggestion (the doc as it would be with none of them: what the file gets). */
export function rejectAll(doc: Y.Doc, origin: unknown = null): void {
  for (const id of [...suggestionsOf(doc).keys()]) rejectSuggestion(doc, id, origin);
}
