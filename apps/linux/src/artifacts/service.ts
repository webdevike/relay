// Per-thread artifacts: the host mines each thread's omp transcripts (`extract.ts`) as they grow and
// keeps what it finds, deduped by key, in `$XDG_CONFIG_HOME/relay/artifacts/<thread>/artifacts.json`
// (items, plus how far each transcript was read) and `tabs.json` (the tab bar), dir 0700, files
// 0600, written atomically. It is the only writer: every change goes out to every device as the
// thread's `artifacts.snapshot`, and `artifacts.act` (pins, tabs, items, live states from Relay
// desktop) comes back through `act`.
//
// Threads load lazily: on the first `artifacts.get`, or when one of their sessions appends
// messages. The first read of a thread only takes transcripts written in the last week (older
// mentions would have faded anyway). Subagent rows follow their transcripts on disk while they run:
// the latest tool intent is their status line, `<name>.md` (omp's result file) ends them, and
// their own subagents (`<name>/<name>.<child>.jsonl`) nest under them.
//
// Images Isaac pasted are stored once under `artifacts/media/<sha>` and served over HTTP at
// `/artifacts/media/<sha>/<token>` (the token, like a drop's, only ever travels to paired devices).

import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  ARTIFACT_STALE_MS,
  Artifact,
  DAY_MS,
  ArtifactTab,
  MAX_ARTIFACTS,
  MAX_ARTIFACT_SOURCES,
  MAX_ARTIFACT_TABS,
  defaultTabFor,
  defaultTabs,
  isDefaultTab,
  sameRule,
  type ArtifactAction,
  type ArtifactStatus,
  type Drop,
  type ServerMessage,
} from "@relay/protocol";
import { z } from "zod";
import type { AgentProviderChange, DropBlob } from "../seams";
import type { SessionClock } from "../session";
import { classifyUrl, scanTranscript, subagentItem, type Found } from "./extract";

/** How long a thread's transcript settles after new messages before it is read again. */
export const ARTIFACT_SCAN_DELAY_MS = 1500;
/** How often running subagents are looked at on disk. */
export const SUBAGENT_POLL_MS = 15_000;
/** A subagent transcript nobody wrote to for this long, with no result, is over (its session died). */
export const SUBAGENT_STALL_MS = 30 * 60_000;
/** Bytes of a subagent transcript's tail read for its latest status line. */
const TAIL_BYTES = 48 * 1024;
/** Largest pasted image the host keeps (base64 is about 4/3 of it). */
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const ISAAC = "isaac";

const Scan = z.object({ offset: z.number().int().nonnegative(), fresh: z.boolean() });
const ItemsFile = z.object({
  version: z.literal(1),
  items: z.array(Artifact),
  /** How far each transcript was read (bytes) and whether its first user turn is still ahead. */
  scans: z.record(z.string(), Scan).default({}),
  /** Transcripts of a `session:` thread seen so far (its session may end and take the path with it). */
  files: z.array(z.string()).default([]),
  /** The chat repo bare `#n` resolves against, from the transcript's working directory. */
  repo: z.string().nullable().default(null),
  /** Pasted images: sha -> token. */
  media: z.record(z.string(), z.string()).default({}),
});
type ItemsFile = z.infer<typeof ItemsFile>;
const TabsFile = z.object({ version: z.literal(1), tabs: z.array(ArtifactTab) });

interface ThreadState {
  readonly thread: string;
  readonly items: Map<string, Artifact>;
  tabs: ArtifactTab[];
  scans: Record<string, z.infer<typeof Scan>>;
  files: string[];
  repo: string | null;
  media: Record<string, string>;
}

export interface ArtifactServiceDeps {
  /** `$XDG_CONFIG_HOME/relay/artifacts`. */
  readonly root: string;
  /** Eva root for Eva-relative paths; null: they are skipped. */
  readonly evaRoot: string | null;
  /** Sends `message` to every authenticated device. */
  readonly broadcast: (message: ServerMessage) => void;
  /** Every transcript of `thread` the host knows now, oldest first (an assistant's earlier contexts and its live one). */
  readonly threadFiles: (thread: string) => readonly string[];
  /** The thread a live session belongs to; null for an unknown one. */
  readonly threadOf: (sessionId: string) => string | null;
  /** The drop behind a `drop:` item, for its file facts; undefined when it is gone. */
  readonly drop: (id: string) => Drop | undefined;
  /** `owner/name` of the GitHub repo checked out at `cwd`; null when it is none. */
  readonly repoOf: (cwd: string) => string | null;
  readonly clock: SessionClock;
  readonly log: (line: string) => void;
}

/** What a phone session and the server need of the artifacts. */
export interface ArtifactRelaying {
  /** Reads what is new in `thread` and pushes its snapshot to every device. */
  get(thread: string): void;
  /** Applies `action` as `by`; `error` is a sentence for whoever asked (an agent sees it as is). */
  act(thread: string, by: string, action: ArtifactAction): { ok: boolean; error?: string; id?: string };
  /** A pasted image's bytes iff `token` matches; null otherwise. */
  openMedia(sha: string, token: string): DropBlob | null;
  observe(change: AgentProviderChange): void;
}

export function defaultArtifactsRoot(): string {
  const base = process.env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config");
  return join(base, "relay", "artifacts");
}

/** `assistant:nova` -> `assistant-nova`: a directory name per thread. */
function threadDir(thread: string): string {
  return thread.replace(/[^A-Za-z0-9._-]/g, "-");
}

function writeAtomic(path: string, text: string | Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

function slug(title: string): string {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return base === "" ? "tab" : base;
}

/** The fields of a status that mean something to a reader (everything but when it was read). */
function statusShape(status: ArtifactStatus | undefined): string {
  if (status === undefined) return "";
  return JSON.stringify({ ...status, fetchedAt: 0, changedAt: 0 });
}

export class ArtifactService implements ArtifactRelaying {
  private readonly threads = new Map<string, ThreadState>();
  /** Threads waiting out ARTIFACT_SCAN_DELAY_MS before their transcripts are read again. */
  private readonly timers = new Map<string, () => void>();
  private poll: (() => void) | null = null;

  constructor(private readonly deps: ArtifactServiceDeps) {}

  get(thread: string): void {
    const state = this.load(thread);
    this.refresh(state);
    this.publish(state);
  }

  observe(change: AgentProviderChange): void {
    if (change.kind !== "conversation") return;
    const thread = this.deps.threadOf(change.sessionId);
    if (thread === null || this.timers.has(thread)) return;
    this.timers.set(
      thread,
      this.deps.clock.after(ARTIFACT_SCAN_DELAY_MS, () => {
        this.timers.delete(thread);
        const state = this.load(thread);
        if (this.refresh(state)) this.publish(state);
      }),
    );
  }

  openMedia(sha: string, token: string): DropBlob | null {
    if (!/^[0-9a-f]{32}$/.test(sha)) return null;
    for (const state of this.threads.values()) {
      const expected = state.media[sha];
      if (expected?.length !== token.length) continue;
      if (!timingSafeEqual(Buffer.from(expected), Buffer.from(token))) continue;
      const path = join(this.deps.root, "media", sha);
      const meta = this.mediaMeta(sha);
      if (meta === null || !existsSync(path)) return null;
      return { path, mimeType: meta, name: `${sha}.${meta.split("/")[1] ?? "bin"}`, size: statSync(path).size };
    }
    return null;
  }

  /** Loads every thread that has data on disk, so media links keep working after a restart. */
  loadAll(): void {
    if (!existsSync(this.deps.root)) return;
    for (const name of readdirSync(this.deps.root)) {
      const file = join(this.deps.root, name, "artifacts.json");
      if (!existsSync(file)) continue;
      const thread = name.replace(/^(assistant|session)-/, "$1:");
      this.load(thread);
    }
  }

  act(thread: string, by: string, action: ArtifactAction): { ok: boolean; error?: string; id?: string } {
    const state = this.load(thread);
    const result = this.apply(state, by, action);
    if (result.changed) this.publish(state);
    return { ok: result.error === undefined, ...(result.error === undefined ? {} : { error: result.error }), ...(result.id === undefined ? {} : { id: result.id }) };
  }

  private apply(state: ThreadState, by: string, action: ArtifactAction): { changed: boolean; error?: string; id?: string } {
    const isaac = by === ISAAC;
    const now = this.deps.clock.now();
    switch (action.op) {
      case "pin": {
        const item = state.items.get(action.id);
        if (item === undefined) return { changed: false, error: `No artifact ${action.id} in this thread; artifacts.list shows the ids.` };
        if (action.pinned === (item.pinned !== undefined)) return { changed: false };
        const next: Artifact = { ...item };
        if (action.pinned) next.pinned = { by, at: now };
        else delete next.pinned;
        state.items.set(item.id, next);
        return { changed: true };
      }
      case "add": {
        const found = this.addable(action);
        if (typeof found === "string") return { changed: false, error: found };
        const before = state.items.get(found.id);
        const item: Artifact = before ?? {
          id: found.id,
          kind: found.kind,
          title: action.title,
          ...(found.url === undefined ? {} : { url: found.url }),
          ...(found.path === undefined ? {} : { path: found.path }),
          ...(found.repo === undefined ? {} : { repo: found.repo }),
          ...(found.media === undefined ? {} : { media: found.media }),
          ...(action.caption === undefined ? {} : { caption: action.caption }),
          mentions: 0,
          firstSeen: now,
          lastSeen: now,
          sources: [],
          addedBy: by,
        };
        state.items.set(item.id, { ...item, lastSeen: now });
        if (action.tab !== undefined) {
          const tab = state.tabs.find((candidate) => candidate.id === action.tab);
          if (tab === undefined) return { changed: true, id: item.id, error: `Added ${item.id}, but there is no tab ${action.tab}.` };
          if (tab.items !== undefined && !tab.items.includes(item.id)) this.replaceTab(state, { ...tab, items: [...tab.items, item.id] });
        }
        return { changed: true, id: item.id };
      }
      case "tab.add": {
        if ((action.rule === undefined) === (action.items === undefined)) return { changed: false, error: "Give the tab either a rule or a list of items, not both." };
        if (state.tabs.length >= MAX_ARTIFACT_TABS) return { changed: false, error: `This thread already has ${MAX_ARTIFACT_TABS} tabs; remove one first.` };
        if (action.rule !== undefined && !isaac) {
          const same = defaultTabFor(action.rule);
          if (same !== null) {
            const title = state.tabs.find((tab) => tab.id === same)?.title ?? same;
            return { changed: false, error: `That rule is the default "${title}" tab. Reuse it (artifacts.list {"tab":"${same}"}) instead of adding a tab.` };
          }
        }
        const title = action.title.toLowerCase();
        const clash = state.tabs.find(
          (tab) => tab.title.toLowerCase() === title || (action.rule !== undefined && tab.rule !== undefined && sameRule(tab.rule, action.rule)),
        );
        if (clash !== undefined && clash.hidden && !isaac) return { changed: false, error: `Isaac hid the "${clash.title}" tab; do not add it back.` };
        if (clash !== undefined && !clash.hidden) return { changed: false, error: `The "${clash.title}" tab (${clash.id}) already shows this; reuse it.` };
        const unknown = action.items?.filter((id) => !state.items.has(id)) ?? [];
        if (unknown.length > 0) return { changed: false, error: `Unknown artifact ids: ${unknown.slice(0, 5).join(", ")}. Add them with artifacts.add first.` };
        let id = slug(action.title);
        for (let n = 2; state.tabs.some((tab) => tab.id === id) || isDefaultTab(id); n++) id = `${slug(action.title).slice(0, 44)}-${n}`;
        const tab: ArtifactTab = {
          id,
          title: action.title,
          ...(action.icon === undefined ? {} : { icon: action.icon }),
          createdBy: by,
          createdAt: now,
          ...(action.rule === undefined ? {} : { rule: action.rule }),
          ...(action.items === undefined ? {} : { items: action.items }),
          hidden: false,
          ...(isaac ? {} : { fresh: true }),
        };
        state.tabs = [...state.tabs, tab];
        return { changed: true, id };
      }
      case "tab.update": {
        const tab = state.tabs.find((candidate) => candidate.id === action.tab);
        if (tab === undefined) return { changed: false, error: `No tab ${action.tab}; artifacts.list shows the tabs.` };
        if (!isaac) {
          if (tab.createdBy !== by) return { changed: false, error: `The "${tab.title}" tab is ${tab.createdBy === "default" ? "a default tab" : `${tab.createdBy}'s`}; only its maker or Isaac can change it.` };
          if (action.hidden !== undefined || action.fresh !== undefined) return { changed: false, error: "Only Isaac hides and shows tabs." };
          if (action.rule !== undefined && defaultTabFor(action.rule) !== null) return { changed: false, error: "That rule is a default tab's; reuse the default instead." };
        }
        if (action.rule !== undefined && action.items !== undefined) return { changed: false, error: "Give the tab either a rule or a list of items, not both." };
        if (isDefaultTab(tab.id) && (action.rule !== undefined || action.items !== undefined)) return { changed: false, error: "Default tabs keep their rules." };
        const next: ArtifactTab = { ...tab };
        if (action.title !== undefined) next.title = action.title;
        if (action.icon !== undefined) next.icon = action.icon;
        if (action.rule !== undefined) {
          next.rule = action.rule;
          delete next.items;
        }
        if (action.items !== undefined) {
          next.items = action.items;
          delete next.rule;
        }
        if (action.hidden !== undefined) next.hidden = action.hidden;
        if (action.fresh === false) delete next.fresh;
        this.replaceTab(state, next);
        if (action.index !== undefined) {
          const rest = state.tabs.filter((candidate) => candidate.id !== next.id);
          const index = Math.min(action.index, rest.length);
          state.tabs = [...rest.slice(0, index), next, ...rest.slice(index)];
        }
        return { changed: true };
      }
      case "tab.remove": {
        const tab = state.tabs.find((candidate) => candidate.id === action.tab);
        if (tab === undefined) return { changed: false, error: `No tab ${action.tab}.` };
        if (isDefaultTab(tab.id)) return { changed: false, error: "Default tabs are never removed; Isaac can hide them." };
        if (!isaac && tab.createdBy !== by) return { changed: false, error: `The "${tab.title}" tab is ${tab.createdBy}'s; agents remove only tabs they made.` };
        state.tabs = state.tabs.filter((candidate) => candidate.id !== tab.id);
        return { changed: true };
      }
      case "status": {
        let changed = false;
        for (const [id, status] of Object.entries(action.statuses)) {
          const item = state.items.get(id);
          if (item === undefined) continue;
          const { title, ...rest } = status;
          const prior = item.status;
          const stateChanged = prior !== undefined && prior.state !== rest.state;
          const next: ArtifactStatus = {
            ...rest,
            ...(stateChanged ? { changedAt: now } : prior?.changedAt === undefined ? {} : { changedAt: prior.changedAt }),
          };
          const retitled = title !== undefined && title !== item.title;
          if (retitled || statusShape(prior) !== statusShape(next)) changed = true;
          state.items.set(id, { ...item, status: next, ...(title === undefined ? {} : { title }) });
        }
        // A read that changed nothing is kept (so the next one waits) but goes to no device.
        if (!changed) this.save(state);
        return { changed };
      }
    }
  }

  /** The item an `add` names, or why it cannot be added. */
  private addable(action: Extract<ArtifactAction, { op: "add" }>): Found | string {
    if (action.url !== undefined) {
      const found = classifyUrl(action.url, true);
      if (found === null) return `Cannot add ${action.url}: only http(s) links.`;
      return action.kind === "url" || action.kind === found.kind ? found : { ...found, kind: action.kind };
    }
    if (action.path === undefined) return "Give the artifact a url or a path.";
    if (!existsSync(action.path)) return `No such file: ${action.path}`;
    if (action.kind === "subagent") return subagentItem(basename(action.path, ".jsonl"), { file: `${dirname(action.path)}.jsonl`, evaRoot: null, repo: null, exists: existsSync, fresh: false });
    return { id: `${action.kind}:${action.path}`, kind: action.kind, title: action.title, path: action.path };
  }

  private replaceTab(state: ThreadState, tab: ArtifactTab): void {
    state.tabs = state.tabs.map((candidate) => (candidate.id === tab.id ? tab : candidate));
  }

  private load(thread: string): ThreadState {
    const known = this.threads.get(thread);
    if (known !== undefined) return known;
    const dir = join(this.deps.root, threadDir(thread));
    let items: ItemsFile = { version: 1, items: [], scans: {}, files: [], repo: null, media: {} };
    let tabs: ArtifactTab[] = defaultTabs();
    try {
      if (existsSync(join(dir, "artifacts.json"))) items = ItemsFile.parse(JSON.parse(readFileSync(join(dir, "artifacts.json"), "utf8")));
    } catch (error) {
      this.deps.log(`artifacts: ${thread} items unreadable, starting over: ${String(error)}`);
    }
    try {
      if (existsSync(join(dir, "tabs.json"))) tabs = TabsFile.parse(JSON.parse(readFileSync(join(dir, "tabs.json"), "utf8"))).tabs;
    } catch (error) {
      this.deps.log(`artifacts: ${thread} tabs unreadable, back to the defaults: ${String(error)}`);
    }
    const state: ThreadState = {
      thread,
      items: new Map(items.items.map((item) => [item.id, item])),
      tabs,
      scans: items.scans,
      files: items.files,
      repo: items.repo,
      media: items.media,
    };
    this.threads.set(thread, state);
    return state;
  }

  private save(state: ThreadState): void {
    const dir = join(this.deps.root, threadDir(state.thread));
    const file: ItemsFile = { version: 1, items: [...state.items.values()], scans: state.scans, files: state.files, repo: state.repo, media: state.media };
    writeAtomic(join(dir, "artifacts.json"), JSON.stringify(file));
    writeAtomic(join(dir, "tabs.json"), JSON.stringify({ version: 1, tabs: state.tabs }, null, 2));
  }

  private publish(state: ThreadState): void {
    this.save(state);
    const items = [...state.items.values()].sort((a, b) => b.lastSeen - a.lastSeen);
    this.deps.broadcast({ t: "artifacts.snapshot", thread: state.thread, items, tabs: state.tabs });
    this.schedulePoll();
  }

  /** Reads what is new in the thread's transcripts and looks at its running subagents; true when anything changed. */
  private refresh(state: ThreadState): boolean {
    const now = this.deps.clock.now();
    const live = this.deps.threadFiles(state.thread);
    for (const file of live) if (!state.files.includes(file)) state.files.push(file);
    let changed = false;
    for (const file of state.files) {
      try {
        changed = this.scanFile(state, file, now) || changed;
      } catch (error) {
        this.deps.log(`artifacts: ${state.thread} could not read ${file}: ${String(error)}`);
      }
    }
    changed = this.followSubagents(state, now) || changed;
    if (state.items.size > MAX_ARTIFACTS) {
      const drop = [...state.items.values()]
        .filter((item) => item.pinned === undefined)
        .sort((a, b) => a.lastSeen - b.lastSeen)
        .slice(0, state.items.size - MAX_ARTIFACTS);
      for (const item of drop) state.items.delete(item.id);
    }
    return changed;
  }

  private scanFile(state: ThreadState, file: string, now: number): boolean {
    if (!existsSync(file)) return false;
    const stat = statSync(file);
    const scan = state.scans[file];
    // A thread seen for the first time skips contexts nobody touched this week.
    if (scan === undefined && now - stat.mtimeMs > ARTIFACT_STALE_MS) {
      state.scans[file] = { offset: stat.size, fresh: false };
      return false;
    }
    const from = scan !== undefined && scan.offset <= stat.size ? scan.offset : 0;
    if (from === stat.size) return false;
    const bytes = Buffer.alloc(stat.size - from);
    const fd = openSync(file, "r");
    try {
      readSync(fd, bytes, 0, bytes.length, from);
    } finally {
      closeSync(fd);
    }
    // Only whole lines: a half-written tail waits for the next read.
    const end = bytes.lastIndexOf(0x0a) + 1;
    if (end === 0) return false;
    const result = scanTranscript(bytes.subarray(0, end).toString("utf8"), {
      file,
      evaRoot: this.deps.evaRoot,
      repo: state.repo,
      exists: existsSync,
      fresh: scan?.fresh ?? from === 0,
    });
    state.scans[file] = { offset: from + end, fresh: result.fresh };
    if (result.cwd !== null && state.repo === null && state.thread.startsWith("session:")) state.repo = this.deps.repoOf(result.cwd);
    let changed = false;
    for (const message of result.messages) {
      for (const found of message.found) changed = this.mention(state, found, message.key, message.role, message.at) || changed;
    }
    for (const ended of result.ended) {
      const id = subagentItem(ended.name, { file, evaRoot: null, repo: null, exists: existsSync, fresh: false }).id;
      const item = state.items.get(id);
      if (item?.subagent?.state !== "running") continue;
      state.items.set(id, { ...item, subagent: { ...item.subagent, state: ended.failed ? "failed" : "done", endedAt: ended.at } });
      changed = true;
    }
    return changed;
  }

  /** Counts one message's mention of `found`. */
  private mention(state: ThreadState, found: Found, key: string, role: "user" | "assistant", at: number): boolean {
    const before = state.items.get(found.id);
    if (before?.sources.includes(key) === true) return false;
    let media = found.media;
    let url = found.url;
    if (found.drop !== undefined) {
      const drop = this.deps.drop(found.drop);
      const file = drop?.file;
      if (file !== undefined) {
        media = {
          mimeType: file.mimeType,
          ...(file.width === undefined ? {} : { width: file.width }),
          ...(file.height === undefined ? {} : { height: file.height }),
          ...(file.durationMs === undefined ? {} : { durationMs: file.durationMs }),
          ...(file.poster === undefined ? {} : { poster: file.poster }),
        };
        url = file.path;
      } else if (drop === undefined && before === undefined) {
        // A drop the host no longer has (removed, or from another host) shows nothing.
        return false;
      }
    }
    if (found.image !== undefined) {
      const token = this.storeImage(state, found.image.sha, found.image.data, found.image.mimeType);
      if (token === null) return false;
      url = `/artifacts/media/${found.image.sha}/${token}`;
    }
    const sources = [key, ...(before?.sources ?? [])].slice(0, MAX_ARTIFACT_SOURCES);
    const item: Artifact = before
      ? {
          ...before,
          mentions: before.mentions + 1,
          lastSeen: Math.max(before.lastSeen, at),
          firstSeen: Math.min(before.firstSeen, at),
          sources,
          ...(media === undefined ? {} : { media }),
          ...(url === undefined ? {} : { url }),
          // A slug-derived ticket title or an embed's caption beats the bare key.
          ...(before.title === before.id.slice(before.id.indexOf(":") + 1) && found.title !== before.title ? { title: found.title } : {}),
          ...(before.caption === undefined && found.caption !== undefined ? { caption: found.caption } : {}),
        }
      : {
          id: found.id,
          kind: found.kind,
          title: found.title.slice(0, 300),
          ...(url === undefined ? {} : { url }),
          ...(found.path === undefined ? {} : { path: found.path }),
          ...(found.repo === undefined ? {} : { repo: found.repo }),
          ...(found.caption === undefined ? {} : { caption: found.caption.slice(0, 300) }),
          ...(media === undefined ? {} : { media }),
          ...(found.kind === "subagent" ? { subagent: { state: "running" as const, startedAt: at } } : {}),
          mentions: 1,
          firstSeen: at,
          lastSeen: at,
          sources,
          addedBy: "extractor",
          from: role,
        };
    state.items.set(found.id, item);
    return true;
  }

  /** Stores a pasted image once; its serving token, or null when it is too big or unreadable. */
  private storeImage(state: ThreadState, sha: string, data: string, mimeType: string): string | null {
    const known = state.media[sha] ?? [...this.threads.values()].map((other) => other.media[sha]).find((token) => token !== undefined);
    const path = join(this.deps.root, "media", sha);
    if (known !== undefined && existsSync(path)) {
      state.media[sha] = known;
      return known;
    }
    const bytes = Buffer.from(data, "base64");
    if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) return null;
    writeAtomic(path, bytes);
    writeAtomic(`${path}.type`, mimeType);
    const token = known ?? randomBytes(32).toString("hex");
    state.media[sha] = token;
    return token;
  }

  private mediaMeta(sha: string): string | null {
    try {
      return readFileSync(join(this.deps.root, "media", `${sha}.type`), "utf8").trim() || null;
    } catch {
      return null;
    }
  }

  /** Brings running subagents up to date from their transcripts, and finds the subagents today's ones started. */
  private followSubagents(state: ThreadState, now: number): boolean {
    let changed = false;
    for (const item of [...state.items.values()]) {
      const sub = item.subagent;
      if (sub === undefined || item.path === undefined) continue;
      if (sub.state === "running") changed = this.followSubagent(state, item, now) || changed;
      else if (now - (sub.endedAt ?? item.lastSeen) < DAY_MS) changed = this.followChildren(state, item, item.path, now) || changed;
    }
    return changed;
  }

  private followSubagent(state: ThreadState, item: Artifact, now: number): boolean {
    const sub = item.subagent;
    const path = item.path;
    if (sub === undefined || path === undefined) return false;
    const result = path.replace(/\.jsonl$/, ".md");
    let next = { ...sub };
    let changed = false;
    if (existsSync(path)) {
      const stat = statSync(path);
      const line = lastIntent(path, stat.size);
      if (line !== null && line !== sub.line) next = { ...next, line };
      if (existsSync(result)) next = { ...next, state: "done", endedAt: statSync(result).mtimeMs };
      else if (now - stat.mtimeMs > SUBAGENT_STALL_MS) next = { ...next, state: "done", endedAt: stat.mtimeMs };
      changed = this.followChildren(state, item, path, now) || changed;
    } else if (now - sub.startedAt > SUBAGENT_STALL_MS) {
      next = { ...next, state: "done", endedAt: now };
    }
    if (JSON.stringify(next) !== JSON.stringify(sub)) {
      state.items.set(item.id, { ...item, subagent: next, lastSeen: Math.max(item.lastSeen, next.endedAt ?? item.lastSeen) });
      changed = true;
    }
    return changed;
  }

  /** Subagents a subagent started: `<its dir>/<its name>.<child>.jsonl`. */
  private followChildren(state: ThreadState, parent: Artifact, path: string, now: number): boolean {
    const dir = path.replace(/\.jsonl$/, "");
    if (!existsSync(dir)) return false;
    let changed = false;
    const prefix = `${basename(dir)}.`;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".jsonl")) continue;
      const file = join(dir, name);
      const id = `subagent:${file}`;
      if (state.items.has(id)) continue;
      const startedAt = statSync(file).birthtimeMs || now;
      const title = name.slice(0, -".jsonl".length);
      state.items.set(id, {
        id,
        kind: "subagent",
        title: (title.startsWith(prefix) ? title.slice(prefix.length) : title).slice(0, 300),
        path: file,
        subagent: { state: "running", parent: parent.id, startedAt },
        mentions: 1,
        firstSeen: startedAt,
        lastSeen: startedAt,
        sources: parent.sources.slice(0, 1),
        addedBy: "extractor",
        from: "assistant",
      });
      changed = true;
    }
    return changed;
  }

  /** While any loaded thread has a running subagent, look at them every SUBAGENT_POLL_MS. */
  private schedulePoll(): void {
    if (this.poll !== null) return;
    const running = [...this.threads.values()].some((state) => [...state.items.values()].some((item) => item.subagent?.state === "running"));
    if (!running) return;
    this.poll = this.deps.clock.after(SUBAGENT_POLL_MS, () => {
      this.poll = null;
      const now = this.deps.clock.now();
      for (const state of this.threads.values()) {
        if (this.followSubagents(state, now)) this.publish(state);
      }
      this.schedulePoll();
    });
  }
}

/** The intent of the last tool call in a transcript's tail: the subagent's status line. */
function lastIntent(path: string, size: number): string | null {
  const length = Math.min(size, TAIL_BYTES);
  const bytes = Buffer.alloc(length);
  const fd = openSync(path, "r");
  try {
    readSync(fd, bytes, 0, length, size - length);
  } finally {
    closeSync(fd);
  }
  const matches = [...bytes.toString("utf8").matchAll(/"intent":"((?:[^"\\]|\\.){1,400})"/g)];
  const last = matches.at(-1)?.[1];
  if (last === undefined) return null;
  try {
    return (JSON.parse(`"${last}"`) as string).slice(0, 200);
  } catch {
    return null;
  }
}
