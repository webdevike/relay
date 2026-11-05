// Subagent sessions read from their transcript files, for helpers the omp extension did not mirror.
//
// A thread's helpers normally reach the phone as sessions of their own (`<parent id>:<name>`, with
// `parentId`): the omp extension mirrors each one from the task tool's lifecycle events
// (omp-extension/relay-bridge.ts `mirrorSubagent`). When those events never arrive (an omp whose
// extension missed them, or one started before the extension did) the helper still runs and still
// shows in the activity list, which the host builds from the transcript files, but the phone has no
// session to open. This registers the same session from the file: it speaks the bridge's own
// protocol over the bridge socket as one more extension would, so the phone's subagent screen,
// chips and Artifacts rows need nothing new. Read-only: nothing here can steer or stop a helper.
import { statSync, openSync, readSync, closeSync } from "node:fs";
import { basename, dirname } from "node:path";
import type { ActivityItem, AgentSession, Artifact } from "@relay/protocol";
import { helperItems } from "../activity/sources";
import { firstLine, parseSessionRows, type Image, type InboxMessage } from "./transcript";

/** How often the helpers are looked at, and every mirrored transcript for new lines. */
export const MIRROR_POLL_MS = 1000;
/** Finished helpers kept listed, the newest first; the extension's mirrors keep the same number. */
const MAX_FINISHED = 20;
/** Rows kept per session for `conversation`; older ones fall off. */
const MAX_HISTORY = 500;
/** How many directories up from a helper's file the thread's own transcript is looked for (a helper's helper is one deeper). */
const MAX_DEPTH = 4;

/** A frame the host sends the extension (`bridge.ts` `request`): `{ t, id, ...body }`. */
interface HostFrame {
  readonly t: string;
  readonly id: string;
  readonly imageId?: string;
}

/** One socket to the bridge carrying one session; the production one is `bridgeLink`. */
export interface MirrorLink {
  send(frame: object): void;
  close(): void;
}

export interface MirrorDeps {
  /** `ArtifactService.helpers()`: running helpers and ones that ended today, with their thread. */
  readonly helpers: () => readonly { thread: string; item: Artifact }[];
  /** Every session the host lists (real mirrors included). */
  readonly sessions: () => readonly AgentSession[];
  /** The live session whose transcript is `file`; null when none is (`OmpBridgeProvider.sessionForFile`). */
  readonly sessionForFile: (file: string) => AgentSession | null;
  /** Opens a socket to the bridge; `onFrame` gets each host request, `onClose` runs once it is gone for any reason. */
  readonly open: (onFrame: (frame: HostFrame) => void, onClose: () => void) => MirrorLink;
  readonly now: () => number;
  readonly log: (line: string) => void;
}

/** Where a helper's mirror is: its session id and what the thread's own session says about it. */
interface Target {
  readonly id: string;
  readonly parent: AgentSession;
  readonly item: ActivityItem;
}

/** The thread's live session that owns the helper transcript `file`, found by walking up its folders. */
function parentOf(file: string, sessionForFile: MirrorDeps["sessionForFile"]): AgentSession | null {
  let dir = dirname(file);
  for (let depth = 0; depth < MAX_DEPTH && dir !== dirname(dir); depth++) {
    const session = sessionForFile(`${dir}.jsonl`);
    if (session !== null) return session;
    dir = dirname(dir);
  }
  return null;
}

class Mirror {
  private readonly history: InboxMessage[] = [];
  private readonly images = new Map<string, Image>();
  private link: MirrorLink | null = null;
  private seq = 0;
  private offset = 0;
  private partial = "";
  private lastActivity: string;
  private lastActivityAt: number;
  private status: "working" | "ended";
  private detail: string | undefined;
  /** Set when this side closes the socket, so `onGone` does not run for it. */
  private closing = false;

  constructor(
    private target: Target,
    private readonly file: string,
    private readonly deps: MirrorDeps,
    private readonly onGone: (mirror: Mirror) => void,
    private readonly onDismiss: (mirror: Mirror) => void,
  ) {
    this.lastActivity = target.item.intent !== "" ? target.item.intent : target.item.title;
    this.lastActivityAt = target.item.updatedAt;
    this.status = target.item.status === "working" ? "working" : "ended";
    this.detail = this.detailOf(target.item);
    this.read();
    this.link = deps.open(
      (frame) => {
        this.answer(frame);
      },
      () => {
        this.link = null;
        if (!this.closing) this.onGone(this);
      },
    );
    this.link.send(this.hello());
  }

  get id(): string {
    return this.target.id;
  }

  get running(): boolean {
    return this.status === "working";
  }

  /** When it last did something: how recent a finished one is among the ones kept. */
  get at(): number {
    return this.target.item.updatedAt;
  }

  get path(): string {
    return this.file;
  }

  /** The state the activity list reports now, and any lines the helper wrote since the last look. */
  refresh(target: Target): void {
    this.target = target;
    const next = target.item.status === "working" ? "working" : "ended";
    const detail = this.detailOf(target.item);
    const changed = next !== this.status || detail !== this.detail;
    this.status = next;
    this.detail = detail;
    const grew = this.read();
    if (changed || grew) this.link?.send(this.statusFrame());
  }

  close(): void {
    this.closing = true;
    this.link?.close();
    this.link = null;
  }

  private detailOf(item: ActivityItem): string | undefined {
    if (item.status === "working") return item.intent === "" ? undefined : item.intent;
    return item.status === "failed" ? "Failed" : "Done";
  }

  private nextId = (): string => {
    this.seq += 1;
    return `${this.target.id}-${String(this.seq)}`;
  };

  /** Reads what the helper appended to its file since the last look; true when that moved the last-activity line. */
  private read(): boolean {
    let size: number;
    try {
      size = statSync(this.file).size;
    } catch {
      return false; // not written yet, or gone
    }
    if (size < this.offset) {
      // Rewritten under us: start over rather than parse the middle of something else.
      this.offset = 0;
      this.partial = "";
      this.history.length = 0;
    }
    if (size === this.offset) return false;
    const chunk = Buffer.alloc(size - this.offset);
    const fd = openSync(this.file, "r");
    try {
      readSync(fd, chunk, 0, chunk.length, this.offset);
    } finally {
      closeSync(fd);
    }
    this.offset = size;
    const lines = (this.partial + chunk.toString("utf8")).split("\n");
    this.partial = lines.pop() ?? "";
    const appended = parseSessionRows(lines.join("\n"), this.images, this.nextId);
    if (appended.length === 0) return false;
    for (const row of appended) this.history.push(row);
    if (this.history.length > MAX_HISTORY) this.history.splice(0, this.history.length - MAX_HISTORY);
    // Before the link exists the history is what `conversation` answers; afterwards the phone also gets the rows live.
    this.link?.send({ t: "messages", append: appended });
    const said = appended.findLast((row) => row.role === "assistant");
    if (said === undefined) return false;
    this.lastActivity = firstLine(said.text);
    this.lastActivityAt = said.at;
    return true;
  }

  private base(): Record<string, unknown> {
    const { parent, item } = this.target;
    return {
      title: item.title,
      kind: "manual",
      status: this.status,
      lastActivity: this.lastActivity,
      lastActivityAt: this.lastActivityAt,
      canRespond: false,
      ...(this.detail === undefined ? {} : { statusDetail: this.detail }),
      ...(parent.account === undefined ? {} : { account: parent.account }),
    };
  }

  private hello(): object {
    const { id, parent } = this.target;
    return { t: "hello", sessionId: id, provider: "omp", projectPath: parent.projectPath, parentId: parent.id, ...this.base() };
  }

  private statusFrame(): object {
    return { t: "status", ...this.base() };
  }

  /** Answers one host request the way the extension's mirror does, minus anything that needs a live omp. */
  private answer(frame: HostFrame): void {
    const ok = (value?: unknown): void => {
      this.link?.send({ t: "result", id: frame.id, ok: true, ...(value === undefined ? {} : { value }) });
    };
    const refuse = (error: string): void => {
      this.link?.send({ t: "result", id: frame.id, ok: false, error });
    };
    switch (frame.t) {
      case "conversation":
        ok(this.history);
        return;
      case "image":
        ok(this.images.get(frame.imageId ?? "") ?? null);
        return;
      case "options":
        ok({ models: [], skills: [] });
        return;
      case "end":
        // Clearing a finished helper off the phone. A running one cannot be stopped from here (no live
        // omp behind this), so it only leaves the list until it does something new.
        ok();
        setTimeout(() => {
          this.onDismiss(this);
        }, 0);
        return;
      case "reply":
      case "note":
      case "abort":
        refuse(`${this.target.item.title} is read from its transcript: it cannot be messaged or stopped from here`);
        return;
      default:
        refuse(`${this.target.item.title} is read from its transcript: ${frame.t} is not available`);
    }
  }
}

/**
 * Keeps one read-only session per helper of the thread sessions this host lists, for helpers no
 * real mirror covers. `refresh` runs on a timer (`MIRROR_POLL_MS`); it opens a mirror for a helper
 * with no listed session of its id, feeds each open one the helper's current state and new
 * transcript lines, and closes those whose thread is gone or whose helper dropped off the list.
 */
export class SubagentFileMirrors {
  private readonly mirrors = new Map<string, Mirror>();
  /** Helpers cleared from the phone, by transcript file, with when they last did something. */
  private readonly dismissed = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: MirrorDeps) {}

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      this.refresh();
    }, MIRROR_POLL_MS);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer ?? undefined);
    this.timer = null;
    for (const mirror of this.mirrors.values()) mirror.close();
    this.mirrors.clear();
  }

  /** Session ids this host mirrors from files (tests). */
  get ids(): string[] {
    return [...this.mirrors.keys()];
  }

  refresh(): void {
    const now = this.deps.now();
    const wanted = new Map<string, Target>();
    for (const item of helperItems(this.deps.helpers(), now)) {
      if (item.open.to !== "subagent") continue;
      const file = item.open.file;
      const parent = parentOf(file, this.deps.sessionForFile);
      if (parent === null) continue;
      const id = `${parent.id}:${basename(file).replace(/\.jsonl$/, "")}`;
      const cleared = this.dismissed.get(file);
      if (cleared !== undefined && item.status !== "working" && item.updatedAt <= cleared) continue;
      wanted.set(file, { id, parent, item });
    }
    // Drop mirrors whose helper left the list, whose thread is gone, or that were closed from the host's side.
    for (const mirror of [...this.mirrors.values()]) {
      const target = wanted.get(mirror.path);
      if (target?.id !== mirror.id) {
        mirror.close();
        this.mirrors.delete(mirror.id);
      }
    }
    const listed = new Set(this.deps.sessions().map((session) => session.id));
    const finished = [...wanted.values()]
      .filter((target) => target.item.status !== "working")
      .sort((a, b) => b.item.updatedAt - a.item.updatedAt)
      .slice(MAX_FINISHED);
    const skipped = new Set(finished.map((target) => target.item.id));
    for (const [file, target] of wanted) {
      const mirror = this.mirrors.get(target.id);
      if (mirror !== undefined) {
        mirror.refresh(target);
        continue;
      }
      // A real mirror from the extension (or any session of that id) is the one to show.
      if (listed.has(target.id) || skipped.has(target.item.id)) continue;
      this.mirrors.set(
        target.id,
        new Mirror(
          target,
          file,
          this.deps,
          (gone) => {
            if (this.mirrors.get(gone.id) === gone) this.mirrors.delete(gone.id);
          },
          (dismissed) => {
            this.dismissed.set(dismissed.path, dismissed.at);
            dismissed.close();
            if (this.mirrors.get(dismissed.id) === dismissed) this.mirrors.delete(dismissed.id);
          },
        ),
      );
      this.deps.log(`subagent ${target.id} mirrored from its transcript (${target.item.status})`);
    }
  }
}

/**
 * The production `MirrorDeps.open`: one JSONL socket to the host's own bridge at `socketPath`, as
 * an omp extension holds. Frames from the host come back through `onFrame`; `onClose` runs once
 * when the socket ends, whoever ended it (a real mirror of the same session replaces this one).
 */
export function openBridgeLink(socketPath: string, log: (line: string) => void): MirrorDeps["open"] {
  return (onFrame, onClose) => {
    let buffer = "";
    // Bytes the socket has not taken yet (before it opens, or past what the kernel buffer held).
    let outbound = Buffer.alloc(0);
    let socket: { write(data: Uint8Array): number; end(): void } | null = null;
    let closed = false;
    const flush = (): void => {
      if (socket === null || outbound.length === 0) return;
      const written = socket.write(outbound);
      outbound = outbound.subarray(Math.max(written, 0));
    };
    const finish = (): void => {
      if (closed) return;
      closed = true;
      onClose();
    };
    void Bun.connect({
      unix: socketPath,
      socket: {
        open: (opened) => {
          socket = opened;
          if (closed) opened.end();
          else flush();
        },
        drain: flush,
        data: (_socket, chunk) => {
          buffer += Buffer.from(chunk).toString("utf8");
          let newline = buffer.indexOf("\n");
          while (newline !== -1) {
            const line = buffer.slice(0, newline);
            buffer = buffer.slice(newline + 1);
            if (line.trim().length > 0) {
              try {
                onFrame(JSON.parse(line) as HostFrame);
              } catch {
                log("subagent mirror: dropping a malformed host frame");
              }
            }
            newline = buffer.indexOf("\n");
          }
        },
        close: finish,
        error: (_socket, error) => {
          log(`subagent mirror socket error: ${error.message}`);
          finish();
        },
        connectError: (_socket, error) => {
          log(`subagent mirror could not reach the bridge: ${error.message}`);
          finish();
        },
      },
    });
    return {
      send: (frame) => {
        if (closed) return;
        outbound = Buffer.concat([outbound, Buffer.from(`${JSON.stringify(frame)}\n`, "utf8")]);
        flush();
      },
      close: () => {
        closed = true;
        socket?.end();
      },
    };
  };
}
