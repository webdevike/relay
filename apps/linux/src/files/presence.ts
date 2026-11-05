// Live file presence: the agent cursors Relay desktop shows in its Files editor. Desktops say
// which files they have open (`files.open`, absolute host paths); this watches exactly those, and
// when one changes on disk it tells every desktop that has it open which lines changed and whose
// edit it was (`files.edit`). Whose: the session whose editing tool call last named that file
// (its tool rows carry `paths`, see agents/transcript.ts), drawn like that session's agent on a
// canvas; a change no tool claimed is the generic "Agent". Isaac's own saves (`files.saved`) are
// not edits. Desktops also say where Isaac's caret is (`files.caret`); every other desktop hears
// it (`files.presence`), so an agent asking any of them knows where he is working.

import { createHash } from "node:crypto";
import { readFileSync, statSync, watch } from "node:fs";
import { basename, dirname, isAbsolute, resolve, sep } from "node:path";
import type { AgentSession, DeviceFileFocus, FileEdit, FileEditAgent, FileFocus, ServerMessage } from "@relay/protocol";
import { changedRanges } from "@relay/protocol/text-diff";
import type { AssistantAgentConfig } from "../assistant/registry";
import { assistantLook, EVA_LOOK, portraitSeed, sessionAssistant } from "../canvas/portrait";
import type { AgentProviderChange, FileClient, FilePresenceRelaying, FrameSink } from "../seams";
import type { SessionClock } from "../session";

/** A change no tool claimed. */
export const UNKNOWN_AGENT: FileEditAgent = { name: "Agent", color: "#868e96" };
/** How long a tool call's claim on a file lasts: its write lands within this. */
export const CLAIM_MS = 2 * 60_000;
/** How long Isaac's `files.saved` marks the bytes he saved as his. */
export const HUMAN_SAVE_MS = 30_000;
/** Writes in quick succession (a temp file renamed over, several edits in one call) settle into one edit. */
export const SETTLE_MS = 120;
/** Files larger than this are not diffed (the editor does not open them as text either). */
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_FOCUS = 20;
/** Suffix claims kept for paths the session named relative to some other folder. */
const MAX_LOOSE_CLAIMS = 200;

interface Claim {
  readonly sessionId: string;
  readonly intent: string;
  readonly at: number;
}

interface Snapshot {
  readonly hash: string;
  readonly text: string;
}

export interface FilePresenceDeps {
  /** The bridge's sessions now (who is who, their cwd, parents and assistants). */
  sessions(): readonly AgentSession[];
  /** The assistant registry now (titles, accents, avatars). */
  registry(): readonly AssistantAgentConfig[];
  /** What plain chats' agent is called (the canvas uses the same); Eva when unset. */
  defaultAgentName(): string | undefined;
  /** Watches folder `dir`; `onChange` gets the changed entry's name (null when unknown). Returns the stop. */
  watchDir?: (dir: string, onChange: (name: string | null) => void) => () => void;
  /** The file's bytes, or null when it is gone, not a file or too large. */
  read?: (path: string) => Buffer | null;
  clock: SessionClock;
  log(line: string): void;
}

function defaultWatchDir(dir: string, onChange: (name: string | null) => void): () => void {
  try {
    const w = watch(dir, { persistent: false }, (_event, name) => { onChange(name); });
    w.on("error", () => { w.close(); });
    return () => { w.close(); };
  } catch {
    return () => undefined;
  }
}

function defaultRead(path: string): Buffer | null {
  try {
    const st = statSync(path);
    if (!st.isFile() || st.size > MAX_BYTES) return null;
    return readFileSync(path);
  } catch {
    return null;
  }
}

const sha1 = (bytes: Buffer): string => createHash("sha1").update(bytes).digest("hex");

export class FilePresence implements FilePresenceRelaying {
  private readonly clients = new Map<FrameSink, { client: FileClient; paths: Set<string> }>();
  private readonly focus = new Map<FrameSink, DeviceFileFocus>();
  /** Watched folders: their stop and the open files in them. */
  private readonly dirs = new Map<string, { stop: () => void; files: Set<string> }>();
  private readonly snapshots = new Map<string, Snapshot>();
  private readonly pending = new Map<string, () => void>();
  private readonly claims = new Map<string, Claim>();
  /** Claims on paths named relative to a folder other than the file's: matched by suffix. */
  private loose: { suffix: string; claim: Claim }[] = [];
  private readonly humanSaves = new Map<string, { hash: string; at: number }>();
  private readonly watchDir: NonNullable<FilePresenceDeps["watchDir"]>;
  private readonly read: NonNullable<FilePresenceDeps["read"]>;

  constructor(private readonly deps: FilePresenceDeps) {
    this.watchDir = deps.watchDir ?? defaultWatchDir;
    this.read = deps.read ?? defaultRead;
  }

  open(client: FileClient, paths: readonly string[]): void {
    const first = !this.clients.has(client.sink);
    const next = new Set(paths.map((p) => resolve(p)));
    this.clients.set(client.sink, { client, paths: next });
    this.rewatch();
    if (first) client.sink.send(this.presenceFor(client.device));
  }

  caret(client: FileClient, focus: FileFocus | null): void {
    if (focus === null) {
      if (!this.focus.delete(client.sink)) return;
    } else {
      this.focus.set(client.sink, { ...focus, path: resolve(focus.path), device: client.device, deviceName: client.deviceName, at: this.deps.clock.now() });
    }
    this.sendPresence(client.device);
  }

  saved(path: string, hash: string): void {
    this.humanSaves.set(resolve(path), { hash, at: this.deps.clock.now() });
  }

  drop(sink: FrameSink): void {
    const entry = this.clients.get(sink);
    this.clients.delete(sink);
    const hadFocus = this.focus.delete(sink);
    if (entry !== undefined) this.rewatch();
    if (hadFocus && entry !== undefined) this.sendPresence(entry.client.device);
  }

  /** Tool rows that name the files they write claim those files for their session. */
  observe(change: AgentProviderChange): void {
    if (change.kind !== "conversation") return;
    let session: AgentSession | undefined;
    for (const message of change.appended) {
      const paths = message.tool?.paths;
      if (paths === undefined || paths.length === 0) continue;
      session ??= this.deps.sessions().find((s) => s.id === change.sessionId);
      const claim: Claim = { sessionId: change.sessionId, intent: message.tool?.summary ?? "", at: this.deps.clock.now() };
      for (const p of paths) {
        if (isAbsolute(p)) this.claims.set(resolve(p), claim);
        else {
          if (session !== undefined) this.claims.set(resolve(session.projectPath, p), claim);
          this.loose.push({ suffix: `${sep}${p.replace(/^\.\//, "")}`, claim });
        }
      }
    }
    if (this.loose.length > MAX_LOOSE_CLAIMS) this.loose = this.loose.slice(-MAX_LOOSE_CLAIMS);
  }

  close(): void {
    for (const cancel of this.pending.values()) cancel();
    this.pending.clear();
    for (const d of this.dirs.values()) d.stop();
    this.dirs.clear();
  }

  /** Watches the folders of every open file, reads the files newly opened, stops the rest. */
  private rewatch(): void {
    const wanted = new Set<string>();
    for (const { paths } of this.clients.values()) for (const p of paths) wanted.add(p);
    for (const [dir, d] of this.dirs) {
      for (const file of d.files) if (!wanted.has(file)) {
        d.files.delete(file);
        this.snapshots.delete(file);
        this.pending.get(file)?.();
        this.pending.delete(file);
      }
      if (d.files.size === 0) {
        d.stop();
        this.dirs.delete(dir);
      }
    }
    for (const file of wanted) {
      const dir = dirname(file);
      let d = this.dirs.get(dir);
      if (d === undefined) {
        const files = new Set<string>();
        d = {
          files,
          stop: this.watchDir(dir, (name) => {
            for (const f of files) if (name === null || basename(f) === name) this.schedule(f);
          }),
        };
        this.dirs.set(dir, d);
      }
      if (d.files.has(file)) continue;
      d.files.add(file);
      const bytes = this.read(file);
      if (bytes !== null) this.snapshots.set(file, { hash: sha1(bytes), text: bytes.toString("utf8") });
    }
  }

  private schedule(file: string): void {
    this.pending.get(file)?.();
    this.pending.set(
      file,
      this.deps.clock.after(SETTLE_MS, () => {
        this.pending.delete(file);
        this.changed(file);
      }),
    );
  }

  /** Reads `file` again; a new version that is not Isaac's save goes to every socket that has it open. */
  changed(file: string): void {
    const bytes = this.read(file);
    if (bytes === null || bytes.subarray(0, 8192).includes(0)) {
      this.snapshots.delete(file);
      return;
    }
    const hash = sha1(bytes);
    const before = this.snapshots.get(file);
    if (before?.hash === hash) return;
    const text = bytes.toString("utf8");
    this.snapshots.set(file, { hash, text });
    if (before === undefined) return;
    const now = this.deps.clock.now();
    const human = this.humanSaves.get(file);
    if (human?.hash === hash && now - human.at <= HUMAN_SAVE_MS) {
      this.humanSaves.delete(file);
      return;
    }
    const ranges = changedRanges(before.text, text);
    const last = ranges.at(-1);
    if (last === undefined) return;
    const lines = text.split("\n");
    const caretLine = Math.min(last.endLine, lines.length);
    const claim = this.claimOf(file, now);
    const edit: FileEdit = {
      path: file,
      hash,
      ranges: ranges.slice(0, 50),
      caret: { line: caretLine, column: (lines[caretLine - 1] ?? "").length + 1 },
      agent: claim === null ? UNKNOWN_AGENT : this.agentOf(claim.sessionId),
      ...(claim === null || claim.intent === "" ? {} : { intent: claim.intent.slice(0, 300) }),
      at: now,
    };
    const frame: ServerMessage = { t: "files.edit", ...edit };
    for (const { client, paths } of this.clients.values()) if (paths.has(file)) client.sink.send(frame);
  }

  /** The newest live claim on `file`: its absolute path first, else a relative path it ends with. */
  private claimOf(file: string, now: number): Claim | null {
    let best = this.claims.get(file) ?? null;
    for (const { suffix, claim } of this.loose) {
      if (file.endsWith(suffix) && (best === null || claim.at > best.at)) best = claim;
    }
    return best !== null && now - best.at <= CLAIM_MS ? best : null;
  }

  /**
   * The look of the session's agent, as a canvas draws it: an assistant's thread (or work it
   * started) wears the assistant; a plain chat is Eva; a subagent (helper) goes by its own name in
   * its top session's color, with the Rooms portrait for that name.
   */
  agentOf(sessionId: string): FileEditAgent {
    const sessions = this.deps.sessions();
    const session = sessions.find((s) => s.id === sessionId);
    if (session === undefined) return UNKNOWN_AGENT;
    const { top, assistant } = sessionAssistant(sessions, session);
    const name = this.deps.defaultAgentName();
    const look = assistant !== undefined ? assistantLook(this.deps.registry(), assistant, top.title) : name === undefined ? EVA_LOOK : { ...EVA_LOOK, name };
    if (session.parentId === undefined) return { ...look, sessionId };
    return { name: session.title, color: look.color, avatar: `/canvas/portrait/${portraitSeed(session.title)}`, sessionId };
  }

  /** Every other device's caret, newest first. */
  private presenceFor(device: string): ServerMessage {
    const focus = [...this.focus.values()]
      .filter((f) => f.device !== device)
      .sort((a, b) => b.at - a.at)
      .slice(0, MAX_FOCUS);
    return { t: "files.presence", focus };
  }

  /** Tells every socket but `from`'s device where the carets are now. */
  private sendPresence(from: string): void {
    for (const { client } of this.clients.values()) if (client.device !== from) client.sink.send(this.presenceFor(client.device));
  }
}
