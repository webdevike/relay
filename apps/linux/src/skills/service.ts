// The Skills page's host side: the catalog with usage, and the live rooms of skills being edited.
// A room loads when a skill is opened or edited and unloads once nobody uses it (room.ts `idle`).
// Opening hands out a token for the room's websocket, valid 12 hours (memory only: a host restart
// invalidates them and Relay Desktop opens again). A comment Isaac writes in a skill goes to his
// assistant (the one it @mentions, else the thread's, else Nova) as a turn in its thread, the way
// Catch Up hands off; the assistant answers and suggests changes through `/skills/<name>/reply`
// and `/edit` (comments.ts says how).

import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { findMention } from "@relay/canvas-live/mentions";
import type { DocThreadSnap } from "@relay/canvas-live/doc-threads";
import type { ThreadMsg } from "@relay/canvas-live/threads";
import { CLI } from "../canvas/service";
import type { CanvasPeer } from "../canvas/room";
import { type CatalogEntry, type SkillCatalog, paletteColor } from "./catalog";
import { commentTurn } from "./comments";
import { type AgentLook, type EditRequest, type EditResult, type ReplyRequest, type RoomOptions, SkillRoom } from "./room";
import { SkillError, type SkillDetail, type SkillList, type SkillRow } from "./types";
import type { SkillUsageIndex } from "./usage";

export const SKILL_TOKEN_TTL_MS = 12 * 60 * 60_000;
const SWEEP_MS = 60_000;
/** The assistant a comment goes to when it names none and its thread has none yet. */
const DEFAULT_ASSISTANT = "nova";

export interface SkillsServiceDeps {
  readonly catalog: SkillCatalog;
  readonly usage: SkillUsageIndex;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
  /** Room options (pacing, file watching) on top of the service's clock, log, agent looks and threads files. */
  readonly room?: Omit<RoomOptions, "now" | "log" | "lookFor" | "threadsFile" | "onComment">;
  /** Where each skill's comment threads persist (`<dir>/<encoded name>.json`); none: they last as long as its room. */
  readonly threadsDir?: string | null;
  /** Hands `text` to assistant `assistant` (a registry id) as a turn in its thread; rejects when it cannot. */
  readonly deliver?: (assistant: string, text: string) => Promise<void>;
  /** How the delivered turn tells the assistant to run relay-linux (default: the canvas's). */
  readonly cli?: string;
}

export class SkillsService {
  private readonly rooms = new Map<string, SkillRoom>();
  private readonly tokens = new Map<string, { name: string; expiresAt: number }>();
  private readonly now: () => number;
  private sweepTimer: Timer | undefined;

  constructor(private readonly deps: SkillsServiceDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** Asks omp for the skills, starts the usage scan and the idle-room sweep. */
  start(): void {
    this.deps.catalog.refresh().catch((error: unknown) => {
      this.deps.log?.(`skills: omp skill discovery failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    this.deps.usage.refreshIfDue();
    this.sweepTimer = setInterval(() => {
      this.sweep();
    }, SWEEP_MS);
  }

  stop(): void {
    clearInterval(this.sweepTimer);
    for (const room of this.rooms.values()) room.dispose();
    this.rooms.clear();
  }

  /** Asks omp for the skills again when its last answer is stale; every route waits for this first. */
  refresh(): Promise<void> {
    return this.deps.catalog.refresh();
  }

  list(): SkillList {
    return { skills: this.deps.catalog.entries().map((entry) => this.row(entry)), assistants: this.deps.catalog.assistants() };
  }

  detail(name: string): SkillDetail | null {
    const entry = this.deps.catalog.entry(name);
    if (entry === null) return null;
    const assistants = this.deps.catalog.assistants();
    return {
      ...this.row(entry),
      files: this.deps.catalog.files(entry),
      stats: this.deps.usage.usage(name),
      profiles: Object.fromEntries(assistants.map((assistant) => [assistant.id, assistant.profile])),
    };
  }

  async setAccess(name: string, enabled: Readonly<Record<string, boolean>>): Promise<SkillRow> {
    await this.deps.catalog.setAccess(name, enabled);
    const entry = this.deps.catalog.entry(name);
    if (entry === null) throw new SkillError(404, `no skill ${name}`);
    return this.row(entry);
  }

  /** Loads the skill's room and issues a token for its websocket. */
  open(name: string): { token: string; path: string } {
    this.room(name);
    const now = this.now();
    for (const [token, grant] of this.tokens) if (grant.expiresAt <= now) this.tokens.delete(token);
    const token = randomBytes(24).toString("base64url");
    this.tokens.set(token, { name, expiresAt: now + SKILL_TOKEN_TTL_MS });
    return { token, path: `/skills/${encodeURIComponent(name)}` };
  }

  /** The room `token` opens for skill `name` (loaded again if it was unloaded); null when it does not. */
  authorize(name: string, token: string | null): SkillRoom | null {
    if (token === null || token === "") return null;
    const grant = this.tokens.get(token);
    if (grant?.name !== name) return null;
    if (grant.expiresAt <= this.now()) {
      this.tokens.delete(token);
      return null;
    }
    try {
      return this.room(name);
    } catch {
      return null;
    }
  }

  connect(room: SkillRoom, peer: CanvasPeer): void {
    room.lastActive = this.now();
    room.sync.connect(peer);
  }

  disconnect(room: SkillRoom, peer: CanvasPeer): void {
    room.lastActive = this.now();
    room.sync.disconnect(peer);
  }

  save(name: string, force: boolean): { saved: true; savedAt: number } {
    return { saved: true, savedAt: this.room(name).save(force) };
  }

  reload(name: string): { reloaded: true } {
    this.room(name).reload();
    return { reloaded: true };
  }

  edit(name: string, request: EditRequest): Promise<EditResult> {
    return this.room(name).edit(request);
  }

  reply(name: string, request: ReplyRequest): { ok: true } {
    this.room(name).reply(request);
    return { ok: true };
  }

  leave(name: string, as: string): void {
    this.rooms.get(name)?.leave(as);
  }

  /** Unloads rooms nobody uses. */
  sweep(): void {
    const now = this.now();
    for (const [name, room] of this.rooms) {
      if (!room.idle(now)) continue;
      room.dispose();
      this.rooms.delete(name);
    }
  }

  /** The loaded room of `name`, loading it from the catalog's primary copy; 404 for an unknown skill. */
  room(name: string): SkillRoom {
    const loaded = this.rooms.get(name);
    if (loaded !== undefined) return loaded;
    const entry = this.deps.catalog.entry(name);
    if (entry === null) throw new SkillError(404, `no skill ${name}`);
    const threadsDir = this.deps.threadsDir ?? null;
    const room: SkillRoom = new SkillRoom(name, entry.primary.source.file, {
      ...this.deps.room,
      now: this.now,
      ...(this.deps.log === undefined ? {} : { log: this.deps.log }),
      ...(threadsDir === null ? {} : { threadsFile: join(threadsDir, `${encodeURIComponent(name)}.json`) }),
      lookFor: (agent) => this.lookFor(agent),
      onComment: (thread, message) => {
        this.route(room, thread, message);
      },
    });
    this.rooms.set(name, room);
    return room;
  }

  /** A registry assistant (by title or id) as itself, with its face; anyone else by name in a palette color. */
  private lookFor(name: string): AgentLook {
    const key = name.toLowerCase();
    const assistant = this.deps.catalog.assistants().find((a) => a.title.toLowerCase() === key || a.id === key);
    return assistant === undefined ? { name, color: paletteColor(name) } : { name: assistant.title, color: assistant.color, avatar: `/canvas/avatar/${assistant.id}` };
  }

  /**
   * Isaac's comment `message` in `thread`, to its assistant: the one it @mentions, else the thread's,
   * else Nova (the registry's first without one). The thread is that assistant's from now on, and the
   * comment is a turn in its thread; a delivery that fails says so in the thread, as Relay.
   */
  private route(room: SkillRoom, thread: DocThreadSnap, message: ThreadMsg): void {
    const assistants = this.deps.catalog.assistants();
    const mention = findMention(
      message.text,
      assistants.map((a) => ({ id: a.id, name: a.title })),
    );
    const fallback = assistants.length === 0 || assistants.some((a) => a.id === DEFAULT_ASSISTANT) ? DEFAULT_ASSISTANT : (assistants[0]?.id ?? DEFAULT_ASSISTANT);
    const target = mention?.candidate.id ?? thread.assignee ?? fallback;
    if (target !== thread.assignee) room.assign(thread.id, target);
    const title = assistants.find((a) => a.id === target)?.title ?? `${target.charAt(0).toUpperCase()}${target.slice(1)}`;
    const deliver = this.deps.deliver;
    if (deliver === undefined) {
      room.note(thread.id, `${title} cannot answer here: this host runs no assistants.`);
      return;
    }
    const turn = commentTurn({ skill: room.name, file: room.file, thread: thread.id, quote: thread.quote, from: message.name, text: message.text, as: title, cli: this.deps.cli ?? CLI });
    deliver(target, turn).catch((error: unknown) => {
      const why = error instanceof Error ? error.message : String(error);
      this.deps.log?.(`skills: the comment in ${room.name} thread ${thread.id} did not reach ${title}: ${why}`);
      room.note(thread.id, `Could not reach ${title}: ${why}`);
    });
  }

  private row(entry: CatalogEntry): SkillRow {
    const stats = this.deps.usage.usage(entry.row.name);
    return { ...entry.row, lastUsedAt: stats?.lastUsedAt ?? null, uses: stats?.uses ?? null };
  }
}
