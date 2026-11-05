// One skill being edited live: its SKILL.md as a Y.Doc (doc.ts) shared over the y-websocket
// protocol by a `CanvasSync`, the Relay Desktop editors as its peers and agents editing through the
// host as named cursors of their own. The host alone writes `state` (dirty, diskChanged, savedAt,
// error). The file on disk is watched: a change while nothing is unsaved reloads the doc in place
// (carets survive); with unsaved edits it only raises `diskChanged`, and a save without `force`
// refuses (409) until the editor chooses. Saves are atomic (a temp file in the same folder renamed
// onto the real path, so a symlinked skill stays a symlink and keeps its mode).

import { randomBytes } from "node:crypto";
import { type FSWatcher, chmodSync, readFileSync, realpathSync, renameSync, rmSync, statSync, watch, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import * as awarenessProtocol from "y-protocols/awareness";
import * as Y from "yjs";
import { CanvasSync } from "../canvas/room";
import { DOC_KEYS, type SkillFile, applyMarkdown, docJSON, exportText, nodeKey, readSkillFile, replaceFromFile, seedDoc, splitFrontmatter } from "./doc";
import { SkillError } from "./types";

/** A room nobody uses (no peers, no agents, nothing unsaved) for this long is unloaded. */
export const ROOM_IDLE_MS = 5 * 60_000;
/** An agent's caret leaves after this long without an edit. */
export const AGENT_IDLE_MS = 2 * 60_000;
/** Doc changes are compared to the file this long after the last one. */
const DIRTY_DEBOUNCE_MS = 150;
/** File watch events are read this long after the last one (editors write in bursts). */
const WATCH_DEBOUNCE_MS = 100;
/** SKILL.md is also re-read this often while the room is open, in case the watch missed a change. */
const DISK_POLL_MS = 2_000;

/** Origin of the host's own writes to `state`, which never make the doc dirty. */
const STATE_ORIGIN = "skills:state";
/** Origin of loads from disk. */
const DISK_ORIGIN = "skills:disk";

export interface Pacing {
  /** How long an agent's selection of the text it replaces shows. */
  readonly selectMs: number;
  /** About how long typing a replacement takes, whatever its length. */
  readonly typeMs: number;
}

export const DEFAULT_PACING: Pacing = { selectMs: 400, typeMs: 1000 };

export interface RoomOptions {
  readonly now?: () => number;
  readonly log?: (line: string) => void;
  readonly pacing?: Pacing;
  readonly agentIdleMs?: number;
  /** Watch SKILL.md for outside changes (tests call `checkDisk` instead). */
  readonly watch?: boolean;
  /** An agent's default caret color by name. */
  readonly colorFor?: (name: string) => string;
}

export interface EditRequest {
  readonly as: string;
  readonly color?: string | undefined;
  readonly find?: string | undefined;
  readonly replace?: string | undefined;
  readonly markdown?: string | undefined;
  readonly save?: boolean | undefined;
}

export interface EditResult {
  ok: true;
  dirty: boolean;
  saved: boolean;
  /** Why `save` did not happen (`changed-on-disk`). */
  error?: string;
}

type RelPosJSON = Record<string, unknown>;

/** An agent's own awareness client in the room: its name, color and caret. */
class SkillAgent {
  readonly own = new awarenessProtocol.Awareness(new Y.Doc());
  private chain: Promise<unknown> = Promise.resolve();
  private idleTimer: Timer | undefined;
  private left = false;
  private cursor: { anchor: RelPosJSON; head: RelPosJSON } | null = null;
  private readonly forward = ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }): void => {
    const update = awarenessProtocol.encodeAwarenessUpdate(this.own, [...added, ...updated, ...removed]);
    awarenessProtocol.applyAwarenessUpdate(this.roomAwareness, update, this);
  };

  constructor(
    readonly name: string,
    public color: string,
    private readonly roomAwareness: awarenessProtocol.Awareness,
    private readonly idleMs: number,
    private readonly onLeft: (agent: SkillAgent) => void,
  ) {
    this.own.on("update", this.forward);
    this.publish();
    this.touch();
  }

  setCursor(cursor: { anchor: RelPosJSON; head: RelPosJSON } | null): void {
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
    this.own.setLocalState({ user: { name: this.name, color: this.color, kind: "agent" }, cursor: this.cursor });
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
  private dirtyTimer: Timer | undefined;
  private watchTimer: Timer | undefined;
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
    doc.on("update", (_update: Uint8Array, origin: unknown) => {
      if (origin === STATE_ORIGIN) return;
      this.lastActive = this.now();
      clearTimeout(this.dirtyTimer);
      this.dirtyTimer = setTimeout(() => {
        this.recompute();
      }, DIRTY_DEBOUNCE_MS);
    });
    if (options.watch !== false) this.startWatch();
  }

  get dirty(): boolean {
    return this.state.get("dirty") === true;
  }

  get agentCount(): number {
    return this.agents.size;
  }

  /** Unused: no peers, no agents, nothing unsaved, nothing happening for `ROOM_IDLE_MS`. */
  idle(now: number): boolean {
    return this.sync.peerCount === 0 && this.agents.size === 0 && !this.dirty && now - this.lastActive >= ROOM_IDLE_MS;
  }

  /** The file text the doc stands for now. */
  text(): string {
    return exportText(this.sync.doc, this.base, this.hints);
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
   * Writes the doc to SKILL.md. Refuses (409 `changed-on-disk`) when the file changed since it was
   * loaded or saved, unless `force`.
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
    return savedAt;
  }

  /** Replaces the doc from disk, dropping unsaved edits. */
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
    const findMode = request.find !== undefined;
    if (findMode === (request.markdown !== undefined)) throw new SkillError(400, "give find and replace, or markdown");
    if (findMode && request.replace === undefined) throw new SkillError(400, "find needs replace");
    const agent = this.join(request.as, request.color);
    await agent.run(async () => {
      if (request.markdown !== undefined) this.rewrite(agent, request.markdown);
      else await this.replace(agent, request.find ?? "", request.replace ?? "");
    });
    this.recompute();
    if (request.save !== true) return { ok: true, dirty: this.dirty, saved: false };
    try {
      this.save(false);
      return { ok: true, dirty: this.dirty, saved: true };
    } catch (error) {
      if (error instanceof SkillError && error.status === 409) return { ok: true, dirty: this.dirty, saved: false, error: error.message };
      throw error;
    }
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
    this.disposed = true;
    clearTimeout(this.dirtyTimer);
    clearTimeout(this.watchTimer);
    clearInterval(this.pollTimer);
    this.watcher?.close();
    for (const agent of [...this.agents.values()]) agent.leave();
    this.sync.closeAll(1001, "skill closed");
    this.sync.destroy();
  }

  private join(name: string, color: string | undefined): SkillAgent {
    const key = name.trim().toLowerCase();
    const existing = this.agents.get(key);
    if (existing !== undefined) {
      if (color !== undefined) existing.setColor(color);
      return existing;
    }
    const agent = new SkillAgent(name.trim(), color ?? this.options.colorFor?.(name.trim()) ?? "#1c7ed6", this.sync.awareness, this.options.agentIdleMs ?? AGENT_IDLE_MS, (gone) => {
      if (this.agents.get(key) === gone) this.agents.delete(key);
      this.lastActive = this.now();
    });
    this.agents.set(key, agent);
    return agent;
  }

  /** Selects `find` (one unique run of text), then deletes it and types `replace` in small chunks. */
  private async replace(agent: SkillAgent, find: string, replace: string): Promise<void> {
    const doc = this.sync.doc;
    const matches = findText(doc.getXmlFragment(DOC_KEYS.body), find);
    const match = matches[0];
    if (match === undefined) throw new SkillError(422, `"${find}" is not in ${this.name} (find matches the text as shown, without markdown syntax, inside one paragraph, heading, list item or cell)`);
    if (matches.length > 1) throw new SkillError(422, `"${find}" appears ${String(matches.length)} times in ${this.name}; give a longer find that occurs once`);
    const { text, index } = match;
    const start = Y.createRelativePositionFromTypeIndex(text, index);
    const end = Y.createRelativePositionFromTypeIndex(text, index + find.length);
    agent.setCursor({ anchor: Y.relativePositionToJSON(start) as RelPosJSON, head: Y.relativePositionToJSON(end) as RelPosJSON });
    await delay(this.pacing.selectMs);
    const from = Y.createAbsolutePositionFromRelativePosition(start, doc);
    const to = Y.createAbsolutePositionFromRelativePosition(end, doc);
    if (from === null || to === null || from.type !== text || to.type !== text || this.disposed) throw new SkillError(409, `"${find}" changed while ${agent.name} was replacing it; try again`);
    const attributes = attributesAt(text, from.index);
    const origin = `agent:${agent.name}`;
    doc.transact(() => {
      text.delete(from.index, Math.max(0, to.index - from.index));
    }, origin);
    // The caret is relative to the character after it, so text typed at the caret pushes it along.
    const caret = Y.createRelativePositionFromTypeIndex(text, from.index);
    const caretJSON = Y.relativePositionToJSON(caret) as RelPosJSON;
    agent.setCursor({ anchor: caretJSON, head: caretJSON });
    const chars = Array.from(replace);
    const steps = Math.min(chars.length, 24);
    const size = steps === 0 ? 0 : Math.ceil(chars.length / steps);
    for (let at = 0; at < chars.length; at += size) {
      const position = Y.createAbsolutePositionFromRelativePosition(caret, doc);
      if (position?.type !== text) throw new SkillError(409, `${this.name} changed under ${agent.name}'s caret; try again`);
      const chunk = chars.slice(at, at + size).join("");
      doc.transact(() => {
        text.insert(position.index, chunk, attributes ?? {});
      }, origin);
      agent.setCursor({ anchor: caretJSON, head: caretJSON });
      if (at + size < chars.length) await delay(this.pacing.typeMs / steps);
    }
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
    const caret = Y.relativePositionToJSON(position) as RelPosJSON;
    agent.setCursor({ anchor: caret, head: caret });
  }

  private loadInPlace(text: string): void {
    this.loaded = text;
    this.base = readSkillFile(text, this.fallbackName);
    this.hints.clear();
    replaceFromFile(this.sync.doc, this.base, DISK_ORIGIN);
    clearTimeout(this.dirtyTimer);
    this.setState({ dirty: false, diskChanged: false, error: null });
    this.recompute();
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
