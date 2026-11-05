// The Skills page's host side: the catalog with usage, and the live rooms of skills being edited.
// A room loads when a skill is opened or edited and unloads once nobody uses it (room.ts `idle`).
// Opening hands out a token for the room's websocket, valid 12 hours (memory only: a host restart
// invalidates them and Relay Desktop opens again).

import { randomBytes } from "node:crypto";
import type { CanvasPeer } from "../canvas/room";
import { type CatalogEntry, type SkillCatalog, paletteColor } from "./catalog";
import { type EditRequest, type EditResult, type RoomOptions, SkillRoom } from "./room";
import { SkillError, type SkillDetail, type SkillList, type SkillRow } from "./types";
import type { SkillUsageIndex } from "./usage";

export const SKILL_TOKEN_TTL_MS = 12 * 60 * 60_000;
const SWEEP_MS = 60_000;

export interface SkillsServiceDeps {
  readonly catalog: SkillCatalog;
  readonly usage: SkillUsageIndex;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
  /** Room options (pacing, file watching) on top of the service's clock, log and agent colors. */
  readonly room?: Omit<RoomOptions, "now" | "log" | "colorFor">;
}

export class SkillsService {
  private readonly rooms = new Map<string, SkillRoom>();
  private readonly tokens = new Map<string, { name: string; expiresAt: number }>();
  private readonly now: () => number;
  private sweepTimer: Timer | undefined;

  constructor(private readonly deps: SkillsServiceDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** Starts the usage scan and the idle-room sweep. */
  start(): void {
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

  list(): SkillList {
    return { skills: this.deps.catalog.entries().map((entry) => this.row(entry)), assistants: this.deps.catalog.assistants() };
  }

  detail(name: string): SkillDetail | null {
    const entry = this.deps.catalog.entry(name);
    if (entry === null) return null;
    const assistants = this.deps.catalog.assistants();
    const usage = this.deps.usage.usage(name);
    const by = usage.lastUsedAt === null ? [] : assistants.filter((assistant) => assistant.profile === usage.lastProfile).map((assistant) => assistant.title);
    return {
      ...this.row(entry),
      files: this.deps.catalog.files(entry),
      usage: { lastUsedAt: usage.lastUsedAt, lastUsedBy: by.length === 0 ? null : by.join(", "), loads30d: usage.loads },
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
    const room = new SkillRoom(name, entry.primary.source.file, {
      ...this.deps.room,
      now: this.now,
      ...(this.deps.log === undefined ? {} : { log: this.deps.log }),
      colorFor: (agent) => this.deps.catalog.assistants().find((assistant) => assistant.title.toLowerCase() === agent.toLowerCase())?.color ?? paletteColor(agent),
    });
    this.rooms.set(name, room);
    return room;
  }

  private row(entry: CatalogEntry): SkillRow {
    return { ...entry.row, lastUsedAt: this.deps.usage.usage(entry.row.name).lastUsedAt };
  }
}
