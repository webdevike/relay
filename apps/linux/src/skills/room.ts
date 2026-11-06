// One skill being edited live: its SKILL.md as a Y.Doc (doc.ts) shared over the y-websocket
// protocol by a `CanvasSync`, the Relay Desktop editors as its peers and agents editing through the
// host as named cursors of their own. The host alone writes `state` (dirty, diskChanged, savedAt,
// error). The file on disk is watched: a change while nothing is unsaved reloads the doc in place
// (carets survive); with unsaved edits it only raises `diskChanged`, and a save without `force`
// refuses (409) until the editor chooses. Saves are atomic (a temp file in the same folder renamed
// onto the real path, so a symlinked skill stays a symlink and keeps its mode).
//
// Comment threads (canvas-live doc-threads.ts) live in the doc beside the body and persist to their
// own file (comments.ts), never to SKILL.md. A human's new message in one, from an editor, goes to
// `onComment` (the service routes it to an assistant). An agent's edit made for a thread is a
// suggestion: typed live into the doc and recorded as hunks until someone accepts or rejects it.
// Everything that compares to or writes the file (dirty, save, the threads file) sees the doc as it
// would be with every pending suggestion rejected, so nothing reaches SKILL.md until accepted.

import { randomBytes } from "node:crypto";
import { type FSWatcher, chmodSync, readFileSync, realpathSync, renameSync, rmSync, statSync, watch, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { JSONContent } from "@tiptap/core";
import {
  type DocThreadSnap,
  type Hunk,
  type RelPos,
  type SuggestionAuthor,
  type TextAnchor,
  type TextRun,
  absolute,
  addHunk,
  anchorDocThread,
  docThreadMap,
  docThreadsOf,
  rejectAll,
  relPos,
  runsText,
  setHunk,
  sliceRuns,
  snapDocThread,
  snapDocThreads,
  suggestionsOf,
  textAnchor,
} from "@relay/canvas-live/doc-threads";
import { type ThreadMsg, postInThread, setAssignee, setResolved } from "@relay/canvas-live/threads";
import * as awarenessProtocol from "y-protocols/awareness";
import * as Y from "yjs";
import { CanvasSync } from "../canvas/room";
import { type StoredThread, readThreads, threadsText, writeThreads } from "./comments";
import { DOC_KEYS, type SkillFile, applyMarkdown, docJSON, exportText, nodeKey, parseBody, readSkillFile, replaceFromFile, scratchBlocks, seedDoc, splitFrontmatter } from "./doc";
import { SkillError } from "./types";

/** A room nobody uses (no peers, no agents, nothing unsaved, no suggestion pending) for this long is unloaded. */
export const ROOM_IDLE_MS = 5 * 60_000;
/** An agent's caret leaves after this long without an edit. */
export const AGENT_IDLE_MS = 2 * 60_000;
/** Doc changes are compared to the file this long after the last one. */
const DIRTY_DEBOUNCE_MS = 150;
/** File watch events are read this long after the last one (editors write in bursts). */
const WATCH_DEBOUNCE_MS = 100;
/** SKILL.md is also re-read this often while the room is open, in case the watch missed a change. */
const DISK_POLL_MS = 2_000;
/** Thread changes are written to the threads file this long after the last one. */
const THREADS_DEBOUNCE_MS = 300;
/** Typing pace: about this long a character, between the pacing's `typeMs` and four times it. */
const TYPE_CHAR_MS = 30;
/** Typed text appears in at most this many chunks. */
const MAX_TYPE_STEPS = 80;

/** Origin of the host's own writes to `state`, which never make the doc dirty. */
const STATE_ORIGIN = "skills:state";
/** Origin of loads from disk. */
const DISK_ORIGIN = "skills:disk";
/** Origin of the host's writes to threads (loading them, assigning them, notes). */
const THREADS_ORIGIN = "skills:threads";

export interface Pacing {
  /** How long an agent's selection of the text it replaces shows. */
  readonly selectMs: number;
  /** The least time typing takes; longer text types at about 30ms a character, up to four times this. */
  readonly typeMs: number;
}

export const DEFAULT_PACING: Pacing = { selectMs: 400, typeMs: 1000 };

/** How an agent shows in the room: its caret, its messages and its suggestions. */
export interface AgentLook {
  readonly name: string;
  readonly color: string;
  /** Host-relative avatar URL (`/canvas/avatar/<id>`), registry assistants only. */
  readonly avatar?: string | undefined;
}

export interface RoomOptions {
  readonly now?: () => number;
  readonly log?: (line: string) => void;
  readonly pacing?: Pacing;
  readonly agentIdleMs?: number;
  /** Watch SKILL.md for outside changes (tests call `checkDisk` instead). */
  readonly watch?: boolean;
  /** An agent's look by the name it edits or answers as (default: that name, in blue). */
  readonly lookFor?: (name: string) => AgentLook;
  /** Where the skill's comment threads persist; without one they last as long as the room. */
  readonly threadsFile?: string;
  /** A human's new message in thread `thread`, from an editor (not the host's own writes). */
  readonly onComment?: (thread: DocThreadSnap, message: ThreadMsg) => void;
}

export interface EditRequest {
  readonly as: string;
  readonly color?: string | undefined;
  readonly find?: string | undefined;
  readonly replace?: string | undefined;
  readonly markdown?: string | undefined;
  /** Text (as shown, unique) whose block the `insert` blocks go after. */
  readonly after?: string | undefined;
  /** Markdown blocks to add after `after`'s block (items of its list when they are the same kind of list). */
  readonly insert?: string | undefined;
  /** The comment thread this answers: the edit becomes its suggestion instead of a change. */
  readonly thread?: string | undefined;
  readonly save?: boolean | undefined;
}

export interface EditResult {
  ok: true;
  dirty: boolean;
  saved: boolean;
  /** The suggestion the edit became (with `thread`). */
  suggestion?: string;
  /** Why `save` did not happen (`changed-on-disk`). */
  error?: string;
}

export interface ReplyRequest {
  readonly as: string;
  readonly color?: string | undefined;
  readonly thread: string;
  readonly text: string;
  readonly resolve?: boolean | undefined;
}

/** An agent's own awareness client in the room: its name, color and caret. */
class SkillAgent {
  readonly own = new awarenessProtocol.Awareness(new Y.Doc());
  private chain: Promise<unknown> = Promise.resolve();
  private idleTimer: Timer | undefined;
  private left = false;
  private cursor: { anchor: RelPos; head: RelPos } | null = null;
  private readonly forward = ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }): void => {
    const update = awarenessProtocol.encodeAwarenessUpdate(this.own, [...added, ...updated, ...removed]);
    awarenessProtocol.applyAwarenessUpdate(this.roomAwareness, update, this);
  };

  constructor(
    readonly name: string,
    public color: string,
    readonly avatar: string | undefined,
    private readonly roomAwareness: awarenessProtocol.Awareness,
    private readonly idleMs: number,
    private readonly onLeft: (agent: SkillAgent) => void,
  ) {
    this.own.on("update", this.forward);
    this.publish();
    this.touch();
  }

  /** Who a suggestion is by. */
  get look(): SuggestionAuthor {
    return { name: this.name, color: this.color, ...(this.avatar === undefined ? {} : { avatar: this.avatar }) };
  }

  setCursor(cursor: { anchor: RelPos; head: RelPos } | null): void {
    this.cursor = cursor;
    this.publish();
  }

  setColor(color: string): void {
    if (color === this.color) return;
    this.color = color;
    this.publish();
  }

  /** Runs `step` after the agent's earlier edits, so one agent's edits never interleave. */
  run<T>(step: () => Promise<T>): Promise<T> {
    const result = this.chain.then(step);
    this.chain = result.catch(() => undefined);
    return result.finally(() => {
      this.touch();
    });
  }

  leave(): void {
    if (this.left) return;
    this.left = true;
    clearTimeout(this.idleTimer);
    // A null state is the awareness protocol's "gone": the room drops the caret at once.
    this.own.setLocalState(null);
    this.own.off("update", this.forward);
    this.own.destroy();
    this.onLeft(this);
  }

  private publish(): void {
    if (this.left) return;
    this.own.setLocalState({ user: { name: this.name, color: this.color, kind: "agent", ...(this.avatar === undefined ? {} : { avatar: this.avatar }) }, cursor: this.cursor });
  }

  private touch(): void {
    clearTimeout(this.idleTimer);
    if (this.left) return;
    this.idleTimer = setTimeout(() => {
      this.leave();
    }, this.idleMs);
  }
}

/** Where `needle` occurs in the doc's text, each inside one text node. */
function findText(type: Y.XmlFragment | Y.XmlElement, needle: string, out: { text: Y.XmlText; index: number }[] = []): { text: Y.XmlText; index: number }[] {
  for (const child of type.toArray()) {
    if (child instanceof Y.XmlText) {
      const plain = (child.toDelta() as { insert: unknown }[]).map((op) => (typeof op.insert === "string" ? op.insert : "\uFFFC")).join("");
      for (let index = plain.indexOf(needle); index >= 0; index = plain.indexOf(needle, index + 1)) out.push({ text: child, index });
    } else if (child instanceof Y.XmlElement) findText(child, needle, out);
  }
  return out;
}

/** The formatting (marks) of the character at `index`, so typed text continues it. */
function attributesAt(text: Y.XmlText, index: number): Record<string, unknown> | undefined {
  let offset = 0;
  for (const op of text.toDelta() as { insert: unknown; attributes?: Record<string, unknown> }[]) {
    const length = typeof op.insert === "string" ? op.insert.length : 1;
    if (index < offset + length) return op.attributes;
    offset += length;
  }
  return undefined;
}

/** The first text node inside `type`, depth first. */
function firstText(type: Y.XmlElement | Y.XmlText | Y.XmlHook): Y.XmlText | null {
  if (type instanceof Y.XmlText) return type;
  if (!(type instanceof Y.XmlElement)) return null;
  for (const child of type.toArray()) {
    const found = firstText(child);
    if (found !== null) return found;
  }
  return null;
}

/** Every text node inside `type`, in document order. */
function textsIn(type: Y.XmlElement | Y.XmlText | Y.XmlHook, out: Y.XmlText[] = []): Y.XmlText[] {
  if (type instanceof Y.XmlText) out.push(type);
  else if (type instanceof Y.XmlElement) for (const child of type.toArray()) textsIn(child, out);
  return out;
}

const isElement = (type: unknown): type is Y.XmlElement => type instanceof Y.XmlElement;

/** The text `anchor` covers in `doc` now; null when it no longer covers any (its text went, or it never resolved). */
function anchoredText(doc: Y.Doc, anchor: TextAnchor | null): string | null {
  if (anchor === null) return null;
  const from = absolute(doc, anchor.from);
  const to = absolute(doc, anchor.to);
  if (from === null || to?.type !== from.type || !(from.type instanceof Y.XmlText) || to.index <= from.index) return null;
  return runsText(sliceRuns(from.type, from.index, to.index));
}

/** How typing `chars` characters goes: chunks of `size`, `stepMs` apart. */
function typing(chars: number, pacing: Pacing): { size: number; stepMs: number } {
  const steps = Math.min(chars, MAX_TYPE_STEPS);
  if (steps === 0) return { size: 1, stepMs: 0 };
  const total = Math.min(Math.max(chars * TYPE_CHAR_MS, pacing.typeMs), 4 * pacing.typeMs);
  return { size: Math.ceil(chars / steps), stepMs: total / steps };
}

/**
 * Where blocks `nodes` go when added after the block holding `text`: as new items of the list item
 * holding it when they are one list of that list's kind, else after its top-level block. `blocks`
 * are scratch elements (scratchBlocks) to clone in.
 */
function placement(fragment: Y.XmlFragment, text: Y.XmlText, nodes: readonly JSONContent[]): { parent: Y.XmlFragment | Y.XmlElement; index: number; blocks: Y.XmlElement[] } {
  const scratch = scratchBlocks(nodes);
  const only = nodes.length === 1 ? nodes[0] : undefined;
  for (let parent = text.parent; parent instanceof Y.XmlElement; parent = parent.parent) {
    if (parent.nodeName !== "listItem" && parent.nodeName !== "taskItem") continue;
    const list = parent.parent;
    const items = scratch[0];
    if (list instanceof Y.XmlElement && items !== undefined && only?.type === list.nodeName) return { parent: list, index: list.toArray().indexOf(parent) + 1, blocks: items.toArray().filter(isElement) };
    break;
  }
  // The top-level block: the outermost element (the fragment is no element).
  let top: Y.XmlText | Y.XmlElement = text;
  while (top.parent instanceof Y.XmlElement) top = top.parent;
  return { parent: fragment, index: fragment.toArray().indexOf(top) + 1, blocks: scratch };
}

/** A change an agent types for a thread, as one hunk of the thread's suggestion: `update` it with its range as it grows. */
interface Tracker {
  update(from: RelPos, to: RelPos): void;
  /** False once someone accepted or rejected the suggestion. */
  alive(): boolean;
}

export class SkillRoom {
  readonly sync = new CanvasSync();
  /** SKILL.md with symlinks resolved: what is watched and written. */
  readonly realFile: string;
  /** The text as last loaded or saved: what `dirty` and the disk check compare against. */
  private loaded: string;
  /** What exports serialize against: the blocks and frontmatter as last loaded or saved (or as an agent rewrote the frontmatter). */
  private base: SkillFile;
  /** Markdown agents wrote for nodes, used when no block as read matches. */
  private readonly hints = new Map<string, string>();
  private readonly agents = new Map<string, SkillAgent>();
  private readonly state: Y.Map<unknown>;
  private readonly fallbackName: string;
  private readonly now: () => number;
  private readonly pacing: Pacing;
  /** Thread messages already seen (loaded, written here, or handed to `onComment`). */
  private readonly seen = new Set<string>();
  /** The threads file's text as last read or written. */
  private threadsWritten = "";
  private dirtyTimer: Timer | undefined;
  private watchTimer: Timer | undefined;
  private threadsTimer: Timer | undefined;
  private watcher: FSWatcher | null = null;
  private pollTimer: Timer | undefined;
  private disposed = false;
  /** Last time anything happened in the room (an edit, a peer, an agent). */
  lastActive: number;

  constructor(
    readonly name: string,
    /** The SKILL.md path as listed (may be a symlink). */
    readonly file: string,
    private readonly options: RoomOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.pacing = options.pacing ?? DEFAULT_PACING;
    this.lastActive = this.now();
    this.realFile = realpathSync(file);
    this.fallbackName = basename(dirname(file));
    this.loaded = readFileSync(this.realFile, "utf8");
    this.base = readSkillFile(this.loaded, this.fallbackName);
    const doc = this.sync.doc;
    this.state = doc.getMap(DOC_KEYS.state);
    seedDoc(doc, this.base, DISK_ORIGIN);
    this.setState({ dirty: false, diskChanged: false, savedAt: null, error: null });
    this.loadThreads();
    doc.on("update", (_update: Uint8Array, origin: unknown) => {
      if (origin === STATE_ORIGIN) return;
      this.lastActive = this.now();
      clearTimeout(this.dirtyTimer);
      this.dirtyTimer = setTimeout(() => {
        this.recompute();
      }, DIRTY_DEBOUNCE_MS);
    });
    docThreadsOf(doc).observeDeep((_events, transaction) => {
      this.threadsChanged(transaction.local);
    });
    if (options.watch !== false) this.startWatch();
  }

  get dirty(): boolean {
    return this.state.get("dirty") === true;
  }

  get agentCount(): number {
    return this.agents.size;
  }

  /** Suggestions waiting for Accept or Reject. */
  get pendingSuggestions(): number {
    return suggestionsOf(this.sync.doc).size;
  }

  /** Unused: no peers, no agents, nothing unsaved or pending, nothing happening for `ROOM_IDLE_MS`. */
  idle(now: number): boolean {
    return this.sync.peerCount === 0 && this.agents.size === 0 && !this.dirty && this.pendingSuggestions === 0 && now - this.lastActive >= ROOM_IDLE_MS;
  }

  /** The file text the doc stands for now: without pending suggestions. */
  text(): string {
    return this.withAccepted((doc) => exportText(doc, this.base, this.hints));
  }

  /** The comment threads as the threads file holds them. */
  threads(): StoredThread[] {
    return this.withAccepted((doc) =>
      snapDocThreads(docThreadsOf(doc)).map((t) => ({
        id: t.id,
        quote: anchoredText(doc, t.anchor) ?? t.quote,
        resolved: t.resolved,
        ...(t.assignee === undefined ? {} : { assignee: t.assignee }),
        messages: t.messages,
      })),
    );
  }

  /** Compares the doc to the file as loaded now (normally debounced after edits) and updates `state.dirty`. */
  recompute(): void {
    clearTimeout(this.dirtyTimer);
    if (this.disposed) return;
    try {
      this.setState({ dirty: this.text() !== this.loaded, error: null });
    } catch (error) {
      this.setState({ error: error instanceof Error ? error.message : String(error) });
    }
  }

  /**
   * Writes the doc (pending suggestions left out) to SKILL.md. Refuses (409 `changed-on-disk`) when
   * the file changed since it was loaded or saved, unless `force`.
   */
  save(force = false): number {
    this.recompute();
    const disk = readFileSync(this.realFile, "utf8");
    if (disk !== this.loaded && !force) {
      this.setState({ diskChanged: true });
      throw new SkillError(409, "changed-on-disk");
    }
    const text = this.text();
    if (text !== disk) this.writeAtomic(text);
    this.loaded = text;
    this.base = readSkillFile(text, this.fallbackName);
    this.hints.clear();
    const savedAt = this.now();
    this.setState({ diskChanged: false, savedAt, error: null });
    this.recompute();
    this.flushThreads();
    return savedAt;
  }

  /** Replaces the doc from disk, dropping unsaved edits and pending suggestions. */
  reload(): void {
    this.loadInPlace(readFileSync(this.realFile, "utf8"));
  }

  /** Reads SKILL.md after an outside change: reloads when nothing is unsaved, else flags `diskChanged`. */
  checkDisk(): void {
    if (this.disposed) return;
    let disk: string;
    try {
      disk = readFileSync(this.realFile, "utf8");
    } catch {
      return; // gone or mid-replace; the next event reads again
    }
    if (disk === this.loaded) return;
    this.recompute();
    if (this.dirty) this.setState({ diskChanged: true });
    else this.loadInPlace(disk);
  }

  /** An agent's edit through the live doc (see `EditRequest`), shown as its own named caret. */
  async edit(request: EditRequest): Promise<EditResult> {
    const modes = [request.find !== undefined, request.markdown !== undefined, request.after !== undefined].filter(Boolean).length;
    if (modes !== 1) throw new SkillError(400, "give find and replace, after and insert, or markdown");
    if (request.find !== undefined && request.replace === undefined) throw new SkillError(400, "find needs replace");
    if (request.after !== undefined && request.insert === undefined) throw new SkillError(400, "after needs insert");
    const thread = request.thread;
    if (thread !== undefined) {
      if (request.markdown !== undefined) throw new SkillError(400, "a whole-file rewrite cannot be a suggestion; give find and replace, or after and insert, with thread");
      if (!docThreadsOf(this.sync.doc).has(thread)) throw new SkillError(404, `no comment thread ${thread} in ${this.name}`);
    }
    const agent = this.join(request.as, request.color);
    await agent.run(async () => {
      if (request.markdown !== undefined) this.rewrite(agent, request.markdown);
      else if (request.after !== undefined) await this.insertAfter(agent, request.after, request.insert ?? "", thread);
      else await this.replace(agent, request.find ?? "", request.replace ?? "", thread);
    });
    this.recompute();
    const suggestion = thread !== undefined && suggestionsOf(this.sync.doc).has(`s-${thread}`) ? { suggestion: `s-${thread}` } : {};
    if (request.save !== true) return { ok: true, dirty: this.dirty, saved: false, ...suggestion };
    try {
      this.save(false);
      return { ok: true, dirty: this.dirty, saved: true, ...suggestion };
    } catch (error) {
      if (error instanceof SkillError && error.status === 409) return { ok: true, dirty: this.dirty, saved: false, ...suggestion, error: error.message };
      throw error;
    }
  }

  /** An agent's message in a comment thread, optionally resolving it. */
  reply(request: ReplyRequest): void {
    const threads = docThreadsOf(this.sync.doc);
    if (!threads.has(request.thread)) throw new SkillError(404, `no comment thread ${request.thread} in ${this.name}`);
    if (request.text.trim() === "") throw new SkillError(400, "text is empty");
    const look = this.lookOf(request.as, request.color);
    this.sync.doc.transact(() => {
      postInThread(threads, request.thread, this.message("agent", look, request.text));
      if (request.resolve === true) setResolved(threads, request.thread, true);
    }, `agent:${look.name}`);
    this.lastActive = this.now();
  }

  /** Thread `thread` is for assistant `assignee` (a registry id) from now on. */
  assign(thread: string, assignee: string): void {
    this.sync.doc.transact(() => setAssignee(docThreadsOf(this.sync.doc), thread, assignee), THREADS_ORIGIN);
  }

  /** The host's own line in thread `thread` (a routing failure), as Relay. */
  note(thread: string, text: string): void {
    this.sync.doc.transact(() => postInThread(docThreadsOf(this.sync.doc), thread, this.message("agent", { name: "Relay", color: "#868e96" }, text)), THREADS_ORIGIN);
  }

  /** Takes agent `name`'s caret out of the room. */
  leave(name: string): void {
    this.agents.get(name.trim().toLowerCase())?.leave();
  }

  /** The awareness state agent `name` shows, for tests and the CLI. */
  agentState(name: string): unknown {
    return this.agents.get(name.trim().toLowerCase())?.own.getLocalState() ?? null;
  }

  dispose(): void {
    if (this.disposed) return;
    this.flushThreads();
    this.disposed = true;
    clearTimeout(this.dirtyTimer);
    clearTimeout(this.watchTimer);
    clearInterval(this.pollTimer);
    this.watcher?.close();
    for (const agent of [...this.agents.values()]) agent.leave();
    this.sync.closeAll(1001, "skill closed");
    this.sync.destroy();
  }

  /** `read` on the doc as the file would have it: pending suggestions rejected, in a copy. */
  private withAccepted<T>(read: (doc: Y.Doc) => T): T {
    const doc = this.sync.doc;
    if (suggestionsOf(doc).size === 0) return read(doc);
    const copy = new Y.Doc();
    try {
      Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
      rejectAll(copy);
      return read(copy);
    } finally {
      copy.destroy();
    }
  }

  private lookOf(name: string, color: string | undefined): AgentLook {
    const look = this.options.lookFor?.(name.trim()) ?? { name: name.trim(), color: "#1c7ed6" };
    return color === undefined ? look : { ...look, color };
  }

  private message(kind: ThreadMsg["kind"], look: AgentLook, text: string): ThreadMsg {
    const msg: ThreadMsg = { id: `m-${this.now().toString(36)}${randomBytes(3).toString("hex")}`, kind, name: look.name, color: look.color, text, ts: this.now() };
    if (look.avatar !== undefined) msg.avatar = look.avatar;
    this.seen.add(msg.id);
    return msg;
  }

  private join(name: string, color: string | undefined): SkillAgent {
    const key = name.trim().toLowerCase();
    const existing = this.agents.get(key);
    if (existing !== undefined) {
      if (color !== undefined) existing.setColor(color);
      return existing;
    }
    const look = this.lookOf(name, color);
    const agent = new SkillAgent(look.name, look.color, look.avatar, this.sync.awareness, this.options.agentIdleMs ?? AGENT_IDLE_MS, (gone) => {
      if (this.agents.get(key) === gone) this.agents.delete(key);
      this.lastActive = this.now();
    });
    this.agents.set(key, agent);
    return agent;
  }

  /** The one place `needle` occurs in the doc's text (`what` names the field in errors). */
  private unique(needle: string, what: "find" | "after"): { text: Y.XmlText; index: number } {
    const matches = findText(this.sync.doc.getXmlFragment(DOC_KEYS.body), needle);
    const match = matches[0];
    if (match === undefined) throw new SkillError(422, `"${needle}" is not in ${this.name} (${what} matches the text as shown, without markdown syntax, inside one paragraph, heading, list item or cell)`);
    if (matches.length > 1) throw new SkillError(422, `"${needle}" appears ${String(matches.length)} times in ${this.name}; give a longer ${what} that occurs once`);
    return match;
  }

  /** Records `agent`'s change for thread `thread` as a new hunk of the thread's suggestion (`s-<thread>`). */
  private track(agent: SkillAgent, thread: string, kind: Hunk["kind"], removed: TextRun[]): Tracker {
    const doc = this.sync.doc;
    const id = `s-${thread}`;
    const origin = `agent:${agent.name}`;
    let index = -1;
    return {
      update: (from, to) => {
        const hunk: Hunk = { kind, from, to, removed };
        if (index >= 0) {
          setHunk(doc, id, index, hunk, origin);
          return;
        }
        addHunk(doc, id, { thread, by: agent.look, ts: this.now() }, hunk, origin);
        index = (suggestionsOf(doc).get(id)?.hunks.length ?? 1) - 1;
      },
      alive: () => index < 0 || (suggestionsOf(doc).get(id)?.hunks.length ?? 0) > index,
    };
  }

  /** Thread `id` keeps text to point at: when the agent replaced all of its text, it moves onto `length` characters at `index` of `text`. */
  private keepAnchor(id: string, text: Y.XmlText, index: number, length: number): void {
    const doc = this.sync.doc;
    const threads = docThreadsOf(doc);
    const map = threads.get(id);
    const snap = map === undefined ? null : snapDocThread(id, map);
    if (snap === null || length <= 0 || anchoredText(doc, snap.anchor) !== null) return;
    const quote = runsText(sliceRuns(text, index, index + length));
    doc.transact(() => anchorDocThread(threads, id, textAnchor(text, index, length, quote)), THREADS_ORIGIN);
  }

  /**
   * Selects `find` (one unique run of text), then deletes it and types `replace` in small chunks.
   * With `thread`, the change is that thread's suggestion: what it replaced is kept to put back.
   */
  private async replace(agent: SkillAgent, find: string, replace: string, thread: string | undefined): Promise<void> {
    const doc = this.sync.doc;
    const { text, index } = this.unique(find, "find");
    const start = Y.createRelativePositionFromTypeIndex(text, index);
    const end = Y.createRelativePositionFromTypeIndex(text, index + find.length);
    agent.setCursor({ anchor: Y.relativePositionToJSON(start) as RelPos, head: Y.relativePositionToJSON(end) as RelPos });
    await delay(this.pacing.selectMs);
    const from = Y.createAbsolutePositionFromRelativePosition(start, doc);
    const to = Y.createAbsolutePositionFromRelativePosition(end, doc);
    if (from === null || to === null || from.type !== text || to.type !== text || this.disposed) throw new SkillError(409, `"${find}" changed while ${agent.name} was replacing it; try again`);
    const attributes = attributesAt(text, from.index);
    const origin = `agent:${agent.name}`;
    const tracker = thread === undefined ? null : this.track(agent, thread, "text", sliceRuns(text, from.index, to.index));
    doc.transact(() => {
      text.delete(from.index, Math.max(0, to.index - from.index));
      // Nothing typed yet: an empty range where the text was, so the removed text shows at once.
      tracker?.update(relPos(text, from.index), relPos(text, from.index, -1));
    }, origin);
    // The caret is relative to the character after it, so text typed at the caret pushes it along.
    const caret = Y.createRelativePositionFromTypeIndex(text, from.index);
    const caretJSON = Y.relativePositionToJSON(caret) as RelPos;
    agent.setCursor({ anchor: caretJSON, head: caretJSON });
    const chars = Array.from(replace);
    const { size, stepMs } = typing(chars.length, this.pacing);
    // What has been typed: its first character (once there is one) and the index just past it.
    const typed: { first: RelPos | null; end: number } = { first: null, end: from.index };
    for (let at = 0; at < chars.length; at += size) {
      const position = Y.createAbsolutePositionFromRelativePosition(caret, doc);
      if (position?.type !== text) throw new SkillError(409, `${this.name} changed under ${agent.name}'s caret; try again`);
      if (tracker?.alive() === false) throw new SkillError(409, `the change was accepted or rejected while ${agent.name} was still typing it`);
      const chunk = chars.slice(at, at + size).join("");
      doc.transact(() => {
        text.insert(position.index, chunk, attributes ?? {});
        const first = typed.first ?? relPos(text, position.index);
        typed.first = first;
        typed.end = position.index + chunk.length;
        tracker?.update(first, relPos(text, typed.end, -1));
      }, origin);
      agent.setCursor({ anchor: caretJSON, head: caretJSON });
      if (at + size < chars.length) await delay(stepMs);
    }
    const startAt = typed.first === null ? null : absolute(doc, typed.first);
    if (thread !== undefined && startAt !== null) this.keepAnchor(thread, text, startAt.index, typed.end - startAt.index);
  }

  /**
   * Selects `after`, adds the blocks of `insert` after its block (placement) empty and types their
   * text in. With `thread`, the new blocks are that thread's suggestion.
   */
  private async insertAfter(agent: SkillAgent, after: string, insert: string, thread: string | undefined): Promise<void> {
    const doc = this.sync.doc;
    const parsed = parseBody(insert.trim());
    if (parsed.blocks.length === 0) throw new SkillError(400, "insert has no markdown blocks");
    const { text, index } = this.unique(after, "after");
    const start = Y.createRelativePositionFromTypeIndex(text, index);
    agent.setCursor({ anchor: Y.relativePositionToJSON(start) as RelPos, head: relPos(text, index + after.length) });
    await delay(this.pacing.selectMs);
    if (Y.createAbsolutePositionFromRelativePosition(start, doc)?.type !== text || this.disposed) throw new SkillError(409, `"${after}" changed while ${agent.name} was adding after it; try again`);
    const fragment = doc.getXmlFragment(DOC_KEYS.body);
    const place = placement(fragment, text, parsed.blocks.map((block) => block.node));
    // The blocks go in empty (their text taken out in the scratch doc first) and are typed into.
    const runs = place.blocks.map((block) =>
      textsIn(block).map((node) => {
        const delta = node.toDelta() as { insert: unknown; attributes?: Record<string, unknown> }[];
        node.delete(0, node.length);
        return delta;
      }),
    );
    const clones = place.blocks.map((block) => block.clone());
    const origin = `agent:${agent.name}`;
    const tracker = thread === undefined ? null : this.track(agent, thread, "blocks", []);
    doc.transact(() => {
      place.parent.insert(place.index, clones);
      tracker?.update(relPos(place.parent, place.index), relPos(place.parent, place.index + clones.length, -1));
    }, origin);
    if (place.parent === fragment) for (const block of parsed.blocks) this.hints.set(block.key, block.raw);
    const targets = clones.flatMap((clone, i) => textsIn(clone).map((node, j) => ({ node, ops: runs[i]?.[j] ?? [] })));
    const total = targets.reduce((sum, t) => sum + t.ops.reduce((n, op) => n + (typeof op.insert === "string" ? Array.from(op.insert).length : 1), 0), 0);
    const { size, stepMs } = typing(total, this.pacing);
    for (const { node, ops } of targets) {
      let offset = 0;
      const caretAt = (): void => {
        const caret = relPos(node, offset);
        agent.setCursor({ anchor: caret, head: caret });
      };
      caretAt();
      for (const op of ops) {
        if (typeof op.insert !== "string") {
          const embed = op.insert as object;
          doc.transact(() => {
            node.insertEmbed(Math.min(offset, node.length), embed, op.attributes ?? {});
          }, origin);
          offset += 1;
          continue;
        }
        const chars = Array.from(op.insert);
        for (let at = 0; at < chars.length; at += size) {
          if (node._item?.deleted === true) throw new SkillError(409, `the block ${agent.name} was typing was deleted; try again`);
          if (tracker?.alive() === false) throw new SkillError(409, `the change was accepted or rejected while ${agent.name} was still typing it`);
          const chunk = chars.slice(at, at + size).join("");
          doc.transact(() => {
            node.insert(Math.min(offset, node.length), chunk, op.attributes ?? {});
          }, origin);
          offset += chunk.length;
          caretAt();
          await delay(stepMs);
        }
      }
    }
    const typed = targets.find((t) => t.node.length > 0)?.node;
    if (thread !== undefined && typed !== undefined) this.keepAnchor(thread, typed, 0, typed.length);
  }

  /** A whole-file rewrite: frontmatter into `front`, body applied in place; the caret goes to the first changed block. */
  private rewrite(agent: SkillAgent, source: string): void {
    const doc = this.sync.doc;
    const origin = `agent:${agent.name}`;
    const { header, yaml, body } = splitFrontmatter(source);
    const before = (docJSON(doc).content ?? []).map(nodeKey);
    doc.transact(() => {
      if (yaml !== null) {
        const head = readSkillFile(header, this.fallbackName);
        // Other keys and comments come from the agent's frontmatter; name and description go through `front`.
        this.base = { ...this.base, header, yaml, name: head.name, description: head.description };
        const front = doc.getMap(DOC_KEYS.front);
        if (front.get("name") !== head.name) front.set("name", head.name);
        if (front.get("description") !== head.description) front.set("description", head.description);
      }
      for (const block of applyMarkdown(doc, body, origin).blocks) this.hints.set(block.key, block.raw);
    }, origin);
    const after = (docJSON(doc).content ?? []).map(nodeKey);
    let changed = 0;
    while (changed < after.length && after[changed] === before[changed]) changed += 1;
    if (changed >= after.length && after.length === before.length) return;
    const fragment = doc.getXmlFragment(DOC_KEYS.body);
    const text = changed < fragment.length ? firstText(fragment.get(changed)) : null;
    const position = text === null ? Y.createRelativePositionFromTypeIndex(fragment, Math.min(changed, fragment.length)) : Y.createRelativePositionFromTypeIndex(text, 0);
    const caret = Y.relativePositionToJSON(position) as RelPos;
    agent.setCursor({ anchor: caret, head: caret });
  }

  private loadInPlace(text: string): void {
    this.loaded = text;
    this.base = readSkillFile(text, this.fallbackName);
    this.hints.clear();
    const doc = this.sync.doc;
    doc.transact(() => {
      suggestionsOf(doc).clear();
      replaceFromFile(doc, this.base, DISK_ORIGIN);
    }, DISK_ORIGIN);
    this.reanchorThreads();
    clearTimeout(this.dirtyTimer);
    this.setState({ dirty: false, diskChanged: false, error: null });
    this.recompute();
  }

  /** The anchor of `quote`'s first occurrence in the doc, or null. */
  private anchorOf(quote: string): TextAnchor | null {
    if (quote === "") return null;
    const match = findText(this.sync.doc.getXmlFragment(DOC_KEYS.body), quote)[0];
    return match === undefined ? null : textAnchor(match.text, match.index, quote.length, quote);
  }

  /** Threads whose text went (a reload replaced it) find it again by their quote. */
  private reanchorThreads(): void {
    const doc = this.sync.doc;
    const threads = docThreadsOf(doc);
    doc.transact(() => {
      for (const t of snapDocThreads(threads)) {
        if (anchoredText(doc, t.anchor) !== null) continue;
        const anchor = this.anchorOf(t.quote);
        if (anchor !== null || t.anchor !== null) anchorDocThread(threads, t.id, anchor);
      }
    }, THREADS_ORIGIN);
  }

  /** The threads file's threads into the doc, each anchored on the first occurrence of its quote. */
  private loadThreads(): void {
    const file = this.options.threadsFile;
    if (file === undefined) return;
    const stored = readThreads(file);
    this.threadsWritten = threadsText(stored);
    const doc = this.sync.doc;
    const threads = docThreadsOf(doc);
    doc.transact(() => {
      for (const t of stored) {
        threads.set(t.id, docThreadMap(t.quote, this.anchorOf(t.quote), t.resolved, t.messages, t.assignee));
        for (const m of t.messages) this.seen.add(m.id);
      }
    }, THREADS_ORIGIN);
  }

  /**
   * After a change to the threads: a human's new messages from an editor (`local` false: they came
   * over the socket) go to `onComment`, out of this observer; the threads file is written soon.
   */
  private threadsChanged(local: boolean): void {
    if (this.disposed) return;
    const fresh: { thread: string; message: ThreadMsg }[] = [];
    for (const t of snapDocThreads(docThreadsOf(this.sync.doc))) {
      for (const m of t.messages) {
        if (this.seen.has(m.id)) continue;
        this.seen.add(m.id);
        if (!local && m.kind === "human") fresh.push({ thread: t.id, message: m });
      }
    }
    const onComment = this.options.onComment;
    if (fresh.length > 0 && onComment !== undefined) {
      queueMicrotask(() => {
        const threads = docThreadsOf(this.sync.doc);
        for (const { thread, message } of fresh) {
          const map = threads.get(thread);
          const snap = map === undefined ? null : snapDocThread(thread, map);
          if (snap !== null && !this.disposed) onComment(snap, message);
        }
      });
    }
    if (this.options.threadsFile === undefined) return;
    clearTimeout(this.threadsTimer);
    this.threadsTimer = setTimeout(() => {
      this.flushThreads();
    }, THREADS_DEBOUNCE_MS);
  }

  /** Writes the threads file now when the threads changed since it was last written. */
  private flushThreads(): void {
    clearTimeout(this.threadsTimer);
    const file = this.options.threadsFile;
    if (file === undefined || this.disposed) return;
    const threads = this.threads();
    const text = threadsText(threads);
    if (text === this.threadsWritten) return;
    try {
      writeThreads(file, threads);
      this.threadsWritten = text;
    } catch (error) {
      this.options.log?.(`skills: writing ${file} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private writeAtomic(text: string): void {
    const mode = statSync(this.realFile).mode & 0o7777;
    const temp = join(dirname(this.realFile), `.${basename(this.realFile)}.${randomBytes(6).toString("hex")}.tmp`);
    try {
      writeFileSync(temp, text, { mode });
      chmodSync(temp, mode);
      renameSync(temp, this.realFile);
    } catch (error) {
      rmSync(temp, { force: true });
      throw error;
    }
  }

  private setState(patch: Record<string, unknown>): void {
    if (this.disposed) return;
    this.sync.doc.transact(() => {
      for (const [key, value] of Object.entries(patch)) if (this.state.get(key) !== value) this.state.set(key, value);
    }, STATE_ORIGIN);
  }

  /**
   * Watches the folder (editors replace files rather than write them in place) for SKILL.md changes,
   * and re-reads it every few seconds too: macOS FSEvents can drop a change made right around the
   * moment the watch starts, and a missed one would leave the doc stale until the next edit.
   */
  private startWatch(): void {
    const name = basename(this.realFile);
    this.pollTimer = setInterval(() => {
      this.checkDisk();
    }, DISK_POLL_MS);
    this.pollTimer.unref();
    try {
      this.watcher = watch(dirname(this.realFile), (_event, changed) => {
        if (changed !== null && changed !== name) return;
        clearTimeout(this.watchTimer);
        this.watchTimer = setTimeout(() => {
          this.checkDisk();
        }, WATCH_DEBOUNCE_MS);
      });
      this.watcher.on("error", (error) => {
        this.options.log?.(`skills: watching ${this.realFile} failed: ${error.message}`);
      });
    } catch (error) {
      this.options.log?.(`skills: cannot watch ${this.realFile}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
