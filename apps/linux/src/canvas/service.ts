// Live canvas rooms on the host. Any omp session that Relay shows (a desktop chat, a phone
// session, an assistant thread, a subagent) starts a room on a board (`POST /canvas/sessions`,
// usually through `relay-linux canvas start`): the room is seeded from `<canvases>/<slug>.json`
// and writes back to it, the agent in it is that same session (name, color, avatar, its chat as
// context), and the chat gets the Join card, each canvas turn and the wrap-up as `relay-canvas`
// rows through the session's relay-bridge. Clients list rooms (`canvas.rooms`) and get a token for
// one (`canvas.open` -> `canvas.access`) to load the web client.

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { CanvasSlug, type AgentSession, type CanvasAgent as CanvasAgentInfo, type CanvasEntry, type CanvasRoomInfo, type ServerMessage } from "@relay/protocol";
import { exportBoard, type Board } from "@relay/canvas-live/board";
import { DOC_KEYS, type ChatMsg, type ModelKey, type SessionInfo, type User } from "@relay/canvas-live/shared";
import type { AssistantAgentConfig } from "../assistant/registry";
import type * as Y from "yjs";
import { CanvasAgent, systemPrompt, type AgentIdentity } from "./agent";
import type { BrainFactory, CanvasBrain } from "./brain";
import { chatFileOf, subagentName } from "./caller";
import { chatContext } from "./context";
import { ActRefused, CanvasParticipant, MAX_PARTICIPANTS, type ActResult, type ParticipantOptions } from "./participant";
import { BoardFile, boardPath } from "./persist";
import { portraitSeed } from "./portrait";
import { CanvasSync, type CanvasPeer } from "./room";
import { CanvasTokens, type CanvasGrant } from "./tokens";

/** The human every room is for: tokens are bound to this name. */
export const CANVAS_HUMAN = "Isaac";
/** Default look of the agent of a plain chat (Relay calls those chats' agent Eva). */
const EVA: CanvasAgentInfo = { name: "Eva", color: "#8b5cf6" };
/** Colors for joined agents, picked by name (the first one no one in the room wears yet). */
const PARTICIPANT_COLORS = ["#0ca678", "#f59f00", "#7048e8", "#e8590c", "#1098ad", "#d6336c", "#37b24d", "#4263eb"];
/** Wrap up this long after the last human left. */
export const END_AFTER_MS = 2 * 60_000;
/** Close a room nobody joined after this long (its warm brain costs a ping every few minutes). */
export const UNJOINED_END_MS = 30 * 60_000;
/** Ended rooms listed in `canvas.rooms` for their cards. */
const MAX_ENDED = 20;

/** A request the HTTP layer answers with `status` and `{ error: message }`. */
export class CanvasError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** What the rooms need of the omp bridge: its sessions, their files, and posting a canvas row into one. */
export interface CanvasChats {
  readonly sessions: readonly AgentSession[];
  sessionForFile(file: string): AgentSession | null;
  sessionFile(sessionId: string): string | null;
  /** Resolves false when the session's bridge predates canvas rows. */
  canvas(sessionId: string, content: string, details: CanvasEntry): Promise<boolean>;
}

export interface CanvasServiceDeps {
  /** `~/Library/Application Support/EvaOS/canvases` by default. */
  readonly canvasDir: string;
  readonly chats: CanvasChats;
  /** The assistant registry (names, colors); empty without an agent home. */
  readonly registry: readonly AssistantAgentConfig[];
  /** `<agent home>/work/assistant-avatars`: `<id>.png` per assistant (and `eva.png`). */
  readonly avatarsDir: string | null;
  readonly brains: BrainFactory;
  readonly log: (line: string) => void;
  readonly now?: () => number;
  /** Watch board files for outside writes (off in some tests). */
  readonly watch?: boolean;
  readonly endAfterMs?: number;
  readonly unjoinedEndMs?: number;
  /** Agent animation pacing; tests use 0. */
  readonly pacing?: { frameMs: number; typeMs: number };
  /** Joined agents' pacing and idle leave; tests shorten them. */
  readonly participants?: Pick<ParticipantOptions, "paceMs" | "idleLeaveMs">;
}

/** `POST /canvas/sessions` body. */
export interface StartRequest {
  readonly slug?: string | undefined;
  readonly title?: string | undefined;
  readonly prompt?: string | undefined;
  readonly caller: { readonly sessionFile?: string | undefined; readonly chatFile?: string | undefined; readonly assistant?: string | undefined; readonly name?: string | undefined };
}

export interface StartResult {
  readonly roomId: string;
  readonly slug: string;
  readonly board: string;
  readonly agent: CanvasAgentInfo;
  /** Host-relative path of the web client; clients add the token from `canvas.open`. */
  readonly joinPath: string;
  readonly chat: CanvasRoomInfo["chat"];
  /** False when a live room on this board for the same chat was reused. */
  readonly created: boolean;
}

/** `POST /canvas/sessions/<room>/participants` body: an agent joining a live room. */
export interface JoinRequest {
  readonly name: string;
  /** `#rrggbb`; picked from the name when absent. */
  readonly color?: string | undefined;
  /** What it is here to do; shown in the room's chat when it joins. */
  readonly purpose?: string | undefined;
}

/** One joined agent, as the API lists it. */
export interface ParticipantInfo {
  readonly id: string;
  readonly name: string;
  readonly color: string;
  readonly avatar?: string;
  readonly purpose: string;
}

export interface JoinResult {
  readonly roomId: string;
  readonly slug: string;
  readonly board: string;
  readonly participant: ParticipantInfo;
  /** False when an agent of that name was already in the room (the same participant again). */
  readonly created: boolean;
  /** The room's canvas self, and every joined agent now. */
  readonly agent: CanvasAgentInfo;
  readonly participants: readonly ParticipantInfo[];
}

/** `GET /canvas/sessions/<room>`: what a joined agent reads before it acts. */
export interface RoomView {
  readonly roomId: string;
  readonly slug: string;
  readonly live: boolean;
  readonly agent: CanvasAgentInfo;
  readonly humans: readonly string[];
  readonly participants: readonly ParticipantInfo[];
  /** The board in file shape (as `<slug>.json` holds it once saved). */
  readonly board: Board;
  /** The latest cursor-chat lines, oldest first. */
  readonly chat: readonly Pick<ChatMsg, "kind" | "name" | "text" | "nodeIds" | "ts">[];
}

/** One room the host holds: its doc and peers, its file, its agent, and where its chat rows go. */
export class CanvasRoom {
  readonly agents: CanvasAgent[] = [];
  readonly brains = new Map<ModelKey, CanvasBrain>();
  /** Agents that joined with `canvas join`, by lowercased name. */
  readonly participants = new Map<string, CanvasParticipant>();
  /** Everyone who ever joined as a participant, for the wrap-up row. */
  readonly participantNames = new Set<string>();
  endedAt: number | undefined;
  summary: string | null = null;
  humans: readonly string[] = [];
  everJoined = false;
  unjoinedTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    readonly id: string,
    readonly slug: string,
    readonly sync: CanvasSync,
    readonly file: BoardFile,
    readonly agent: CanvasAgentInfo,
    /** The bridge session the chat rows go to. */
    readonly chatSessionId: string,
    readonly chat: CanvasRoomInfo["chat"],
    readonly startedAt: number,
  ) {}

  get board(): string {
    const title = this.sync.doc.getMap(DOC_KEYS.meta).get("title");
    return typeof title === "string" && title !== "" ? title : this.slug;
  }

  get live(): boolean {
    return this.endedAt === undefined;
  }

  /** The image srcs the board holds (the only files `/img` serves). */
  imageSrcs(): Set<string> {
    const out = new Set<string>();
    for (const node of this.sync.doc.getMap<Y.Map<unknown>>(DOC_KEYS.nodes).values()) {
      const src = node.get("src");
      if (typeof src === "string" && src !== "") out.add(src);
    }
    return out;
  }

  info(): CanvasRoomInfo {
    return {
      id: this.id,
      slug: this.slug,
      board: this.board,
      live: this.live,
      agent: this.agent,
      chat: this.chat,
      humans: [...this.humans],
      startedAt: this.startedAt,
      ...(this.endedAt === undefined ? {} : { endedAt: this.endedAt }),
    };
  }
}

function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
  return slug === "" ? "board" : slug;
}

function nameHash(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return h;
}

export class CanvasService {
  /** Loaded rooms by slug: live ones, and ended ones while clients still have them open. */
  private readonly rooms = new Map<string, CanvasRoom>();
  /** Ended rooms that unloaded, newest last, still listed for their cards. */
  private ended: CanvasRoomInfo[] = [];
  private readonly tokens: CanvasTokens;
  private seq = 0;
  private revision = 0;
  /** Every change of the room list (`canvas.rooms` goes to every device). */
  onChange: (() => void) | null = null;

  constructor(private readonly deps: CanvasServiceDeps) {
    this.tokens = new CanvasTokens(deps.now);
  }

  get rev(): number {
    return this.revision;
  }

  list(): CanvasRoomInfo[] {
    return [...[...this.rooms.values()].map((room) => room.info()), ...this.ended.filter((info) => !this.rooms.has(info.slug))].sort((a, b) => b.startedAt - a.startedAt);
  }

  /** `canvas.rooms`. */
  snapshot(): Extract<ServerMessage, { t: "canvas.rooms" }> {
    return { t: "canvas.rooms", rev: this.revision, rooms: this.list() };
  }

  /** `canvas.open` from device `deviceId`: a token for a live room, else why not. */
  open(slug: string, deviceId: string): Extract<ServerMessage, { t: "canvas.access" | "canvas.unavailable" }> {
    const room = this.rooms.get(slug);
    if (!room?.live) {
      const board = room?.board ?? this.ended.find((info) => info.slug === slug)?.board;
      return { t: "canvas.unavailable", slug, reason: board === undefined ? "No live canvas session on this board." : `The canvas session on ${board} has ended.` };
    }
    const grant = this.tokens.issue(slug, deviceId, CANVAS_HUMAN);
    return { t: "canvas.access", slug, path: `/canvas/${slug}/?token=${encodeURIComponent(grant.token)}`, token: grant.token, expiresAt: grant.expiresAt };
  }

  /** The room `token` opens, with its grant; null when the token or the room is not valid. */
  authorize(slug: string, token: string | null): { room: CanvasRoom; grant: CanvasGrant } | null {
    const room = this.rooms.get(slug);
    const grant = this.tokens.check(slug, token);
    return room === undefined || grant === null ? null : { room, grant };
  }

  /** The PNG behind `/canvas/avatar/<key>`, when there is one. */
  avatarFile(key: string): string | null {
    if (this.deps.avatarsDir === null || !/^[a-z0-9-]{1,60}$/.test(key)) return null;
    const file = join(this.deps.avatarsDir, `${key}.png`);
    return existsSync(file) ? file : null;
  }

  /** Where a board's relative image srcs resolve (as EvaOS resolves them). */
  get canvasDir(): string {
    return this.deps.canvasDir;
  }

  /** Starts (or rejoins) a canvas session for the calling chat. Throws `CanvasError`. */
  async start(request: StartRequest): Promise<StartResult> {
    const { chatSession, sessionFile, chatFile } = this.resolveCaller(request.caller);
    const slug = this.pickSlug(request.slug, request.title);
    const existing = this.rooms.get(slug);
    if (existing?.live === true) {
      if (existing.chatSessionId !== chatSession.id) throw new CanvasError(409, `${existing.agent.name} already has a live canvas session on ${existing.board}.`);
      return this.result(existing, false);
    }
    if (existing !== undefined) this.unload(existing);

    const now = this.now();
    this.seq += 1;
    const roomId = `${slug}-${now.toString(36)}${String(this.seq)}`;
    // The canvas self is the chat's own agent (Nova in Nova's thread, Eva in a plain chat), with
    // the chat as context, whichever session ran `canvas start`. A command run while subagents
    // work cannot tell which session ran it (they share one omp process and its open files), and
    // a subagent that wants its own cursor joins the room with `canvas join --as <Name>` instead.
    const isSubagent = sessionFile !== chatFile;
    const agent = this.agentFor(chatSession, request.caller.name);
    const chat: CanvasRoomInfo["chat"] = {
      sessionId: chatSession.id,
      ...(chatSession.kind === "assistant" && chatSession.assistant !== undefined ? { assistant: chatSession.assistant } : {}),
      title: chatSession.title,
    };
    const sync = new CanvasSync();
    const file = new BoardFile(this.deps.canvasDir, slug, sync.doc, this.deps.log);
    let created: boolean;
    try {
      const title = request.title?.trim() ?? "";
      created = file.open(title === "" ? "New board" : title, { watch: this.deps.watch ?? true }).created;
    } catch (error) {
      sync.destroy();
      throw new CanvasError(422, `${slug}.json is not a board this Relay reads: ${error instanceof Error ? error.message : String(error)}`);
    }
    const room = new CanvasRoom(roomId, slug, sync, file, agent, chatSession.id, chat, now);
    const purpose = request.prompt?.trim() ?? "";
    const session: SessionInfo = { roomId, agent: { ...this.user(agent) }, chatTitle: chatSession.title, open: true, startedAt: now, endedAt: null, summary: null };
    sync.doc.transact(() => {
      sync.doc.getMap(DOC_KEYS.meta).set("session", session);
      const settings = sync.doc.getMap(DOC_KEYS.settings);
      if (settings.get("model") === undefined) settings.set("model", "sonnet");
    }, "host");

    const context = chatContext(chatFile, agent.name, CANVAS_HUMAN);
    const identity: AgentIdentity = { user: this.user(agent), human: CANVAS_HUMAN, chatTitle: chatSession.title, purpose, chat: context.turns, chatTurns: context.turnCount };
    const brain = (model: ModelKey): CanvasBrain => {
      let b = room.brains.get(model);
      if (b === undefined) {
        b = this.deps.brains(systemPrompt(identity), model);
        room.brains.set(model, b);
      }
      return b;
    };
    const canvasAgent = new CanvasAgent(
      sync.doc,
      sync.awareness,
      identity,
      brain,
      {
        turn: (human, reply) => {
          this.post(room, { kind: "turn", human: { name: human.name, text: human.text }, text: reply }, `Canvas "${room.board}" · ${human.name}: ${human.text}\n${agent.name}: ${reply}`);
        },
        ended: (summary) => {
          this.finish(room, summary);
        },
        log: this.deps.log,
      },
      { endAfterMs: this.deps.endAfterMs ?? END_AFTER_MS, ...this.deps.pacing },
    );
    room.agents.push(canvasAgent);
    sync.onHumans = (humans) => {
      room.humans = humans;
      if (humans.length > 0 && !room.everJoined) {
        room.everJoined = true;
        clearTimeout(room.unjoinedTimer);
      }
      this.changed();
    };
    this.rooms.set(slug, room);
    // The opener is generated now so it plays the moment Isaac joins.
    canvasAgent.prepare();
    room.unjoinedTimer = setTimeout(() => {
      if (!room.everJoined && room.live) void canvasAgent.wrapUp();
    }, this.deps.unjoinedEndMs ?? UNJOINED_END_MS);

    const startLine = [
      `Live canvas started on "${room.board}" (board ${slug}${created ? ", new" : ""}). ${CANVAS_HUMAN} has a Join card in this chat; ${agent.name} in the room is this session, with this chat as context.`,
      `Each canvas turn and the wrap-up summary will appear here as canvas rows; they are notes, not turns to answer. Subagents can work the board alongside with their own cursors: relay-linux canvas join ${slug} --as <Name>.`,
      ...(purpose === "" ? [] : [`Purpose: ${purpose}`]),
    ].join(" ");
    try {
      const posted = await this.deps.chats.canvas(chatSession.id, startLine, this.entry(room, { kind: "start", ...(purpose === "" ? {} : { text: purpose }) }));
      if (!posted) throw new Error("this chat's relay-bridge extension predates live canvas; restart the omp session to update it");
    } catch (error) {
      this.unload(room, true);
      throw new CanvasError(502, `Could not post the Join card to the chat: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.deps.log(`canvas ${slug}: ${agent.name} started a session for chat ${chatSession.id}${isSubagent ? ` (run from subagent ${subagentName(sessionFile)})` : ""}`);
    this.changed();
    return this.result(room, true);
  }

  /** Wraps up room `roomId` (the CLI, or the web client's Wrap up). Resolves with the summary. */
  async end(roomId: string): Promise<string> {
    const room = [...this.rooms.values()].find((candidate) => candidate.id === roomId);
    if (room === undefined) {
      const info = this.ended.find((candidate) => candidate.id === roomId);
      if (info !== undefined) return "";
      throw new CanvasError(404, "No such canvas session.");
    }
    if (!room.live) return room.summary ?? "";
    return (await room.agents[0]?.wrapUp()) ?? "";
  }

  /** The room with this id, when loaded. */
  roomById(roomId: string): CanvasRoom | undefined {
    return [...this.rooms.values()].find((room) => room.id === roomId);
  }

  /**
   * An agent joins the live room `ref` (slug or room id) as its own participant: its own cursor,
   * name, color and portrait. The same name again is the same participant. Throws `CanvasError`.
   */
  join(ref: string, request: JoinRequest): JoinResult {
    const room = this.liveRoom(ref);
    const name = request.name.trim().slice(0, 40);
    if (name === "") throw new CanvasError(400, "a participant needs a name (--as <Name>)");
    const key = name.toLowerCase();
    if (key === room.agent.name.toLowerCase() || key === CANVAS_HUMAN.toLowerCase())
      throw new CanvasError(409, `${name} is already in the room as its ${key === CANVAS_HUMAN.toLowerCase() ? "human" : "canvas self"}; join under another name.`);
    const existing = room.participants.get(key);
    if (existing !== undefined) return this.joinResult(room, existing, false);
    if (room.participants.size >= MAX_PARTICIPANTS) throw new CanvasError(429, `${room.board} already has ${String(MAX_PARTICIPANTS)} agents working on it.`);

    const user = this.participantUser(room, name, request.color);
    this.seq += 1;
    const id = `p${this.now().toString(36)}${String(this.seq)}`;
    // Cursors start in a column left of the board, one row per agent, so they never stack.
    const start = { x: -300, y: 240 + 90 * (room.participants.size + 1) };
    const participant = new CanvasParticipant(
      id,
      user,
      request.purpose?.trim() ?? "",
      room.sync.doc,
      room.sync.awareness,
      { ...this.deps.pacing, ...this.deps.participants },
      start,
      (gone) => {
        if (room.participants.get(key) === gone) room.participants.delete(key);
        this.deps.log(`canvas ${room.slug}: ${gone.user.name} left`);
      },
    );
    room.participants.set(key, participant);
    room.participantNames.add(name);
    this.deps.log(`canvas ${room.slug}: ${name} joined as a participant`);
    return this.joinResult(room, participant, true);
  }

  /** Runs one batch of action lines as participant `participantId` of room `ref`. Throws `CanvasError`. */
  async act(ref: string, participantId: string, script: string): Promise<ActResult> {
    const participant = this.participant(this.liveRoom(ref), participantId);
    try {
      return await participant.act(script);
    } catch (error) {
      if (error instanceof ActRefused) throw new CanvasError(error.status, error.message);
      throw error;
    }
  }

  /** Participant `participantId` leaves room `ref`; leaving twice is fine. */
  leave(ref: string, participantId: string): void {
    const room = this.findRoom(ref);
    if (room === undefined) return;
    for (const participant of room.participants.values()) if (participant.id === participantId) participant.leave();
  }

  /** What a joined agent reads: the board as it is now, who is here, the latest chat. Throws `CanvasError`. */
  view(ref: string): RoomView {
    const room = this.findRoom(ref);
    if (room === undefined) throw new CanvasError(404, `No canvas session on ${ref}.`);
    return {
      roomId: room.id,
      slug: room.slug,
      live: room.live,
      agent: room.agent,
      humans: [...room.humans],
      participants: this.participantInfos(room),
      board: exportBoard(room.sync.doc),
      chat: room.sync.doc
        .getArray<ChatMsg>(DOC_KEYS.chat)
        .toArray()
        .slice(-30)
        .map(({ kind, name, text, nodeIds, ts }) => ({ kind, name, text, nodeIds, ts })),
    };
  }

  /** Joined agents of every loaded room, by room id (for `GET /canvas/sessions`). */
  participantsByRoom(): Record<string, ParticipantInfo[]> {
    const out: Record<string, ParticipantInfo[]> = {};
    for (const room of this.rooms.values()) out[room.id] = this.participantInfos(room);
    return out;
  }

  /** A websocket joined `room`. */
  connect(room: CanvasRoom, peer: CanvasPeer): void {
    room.sync.connect(peer);
  }

  /** A websocket left `room`; an ended room unloads with its last client. */
  disconnect(room: CanvasRoom, peer: CanvasPeer): void {
    room.sync.disconnect(peer);
    if (!room.live && room.sync.peerCount === 0) this.unload(room);
  }

  /** Host shutdown: every file written, every brain gone. */
  stop(): void {
    for (const room of [...this.rooms.values()]) this.unload(room, true);
  }

  private result(room: CanvasRoom, created: boolean): StartResult {
    return { roomId: room.id, slug: room.slug, board: room.board, agent: room.agent, joinPath: `/canvas/${room.slug}/`, chat: room.chat, created };
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private changed(): void {
    this.revision += 1;
    this.onChange?.();
  }

  private user(agent: CanvasAgentInfo): User {
    return { name: agent.name, color: agent.color, kind: "agent", ...(agent.avatar === undefined ? {} : { avatar: agent.avatar }) };
  }

  private entry(room: CanvasRoom, row: Pick<CanvasEntry, "kind" | "human" | "text">): CanvasEntry {
    return {
      kind: row.kind,
      roomId: room.id,
      slug: room.slug,
      board: room.board,
      agent: room.agent,
      ...(row.human === undefined ? {} : { human: row.human }),
      ...(row.text === undefined ? {} : { text: row.text }),
    };
  }

  /** Posts a turn or end row; a chat that went away only costs the row. */
  private post(room: CanvasRoom, row: Pick<CanvasEntry, "kind" | "human" | "text">, content: string): void {
    this.deps.chats.canvas(room.chatSessionId, content, this.entry(room, row)).then(
      (posted) => {
        if (!posted) this.deps.log(`canvas ${room.slug}: the chat's bridge cannot take canvas rows`);
      },
      (error: unknown) => {
        this.deps.log(`canvas ${room.slug}: ${row.kind} row not posted: ${error instanceof Error ? error.message : String(error)}`);
      },
    );
  }

  /** The agent wrapped up: summary to the chat, room ended, brains gone, file written. */
  private finish(room: CanvasRoom, summary: string): void {
    if (!room.live) return;
    clearTimeout(room.unjoinedTimer);
    room.endedAt = this.now();
    room.summary = summary;
    const meta = room.sync.doc.getMap(DOC_KEYS.meta);
    const session = meta.get("session") as SessionInfo | undefined;
    if (session !== undefined) meta.set("session", { ...session, open: false, endedAt: room.endedAt, summary });
    const joined = [...room.participantNames];
    this.post(room, { kind: "end", text: summary }, `Canvas "${room.board}" wrap-up: ${summary}${joined.length === 0 ? "" : ` Agents who worked the board: ${joined.join(", ")}.`}`);
    for (const participant of [...room.participants.values()]) participant.leave(true);
    for (const brain of room.brains.values()) brain.dispose();
    room.brains.clear();
    room.file.flush();
    this.deps.log(`canvas ${room.slug}: wrapped up`);
    if (room.sync.peerCount === 0) this.unload(room);
    else this.changed();
  }

  private unload(room: CanvasRoom, silent = false): void {
    if (this.rooms.get(room.slug) !== room) return;
    this.rooms.delete(room.slug);
    clearTimeout(room.unjoinedTimer);
    for (const agent of room.agents) agent.dispose();
    for (const participant of [...room.participants.values()]) participant.leave(true);
    for (const brain of room.brains.values()) brain.dispose();
    room.brains.clear();
    try {
      room.file.close();
    } catch (error) {
      this.deps.log(`canvas ${room.slug}: final write failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    room.sync.closeAll(1001, "canvas session closed");
    room.sync.destroy();
    if (!room.live) {
      this.ended = [...this.ended.filter((info) => info.id !== room.id), room.info()].slice(-MAX_ENDED);
    }
    if (!silent) this.changed();
  }

  /** The chat session, the caller's transcript and the chat's transcript. Throws `CanvasError`. */
  private resolveCaller(caller: StartRequest["caller"]): { chatSession: AgentSession; sessionFile: string; chatFile: string } {
    const { chats } = this.deps;
    if (caller.sessionFile !== undefined && caller.sessionFile !== "") {
      const sessionFile = caller.sessionFile;
      const chatFile = caller.chatFile ?? chatFileOf(sessionFile);
      const chatSession = chats.sessionForFile(chatFile) ?? (caller.assistant === undefined ? null : this.assistantSession(caller.assistant));
      if (chatSession === null) throw new CanvasError(409, "This chat is not connected to Relay (no relay-bridge session reports its transcript), so it cannot get a Join card.");
      return { chatSession, sessionFile, chatFile };
    }
    if (caller.assistant !== undefined && caller.assistant !== "") {
      const chatSession = this.assistantSession(caller.assistant);
      if (chatSession === null) throw new CanvasError(409, `The ${caller.assistant} assistant thread is not running, so it cannot get a Join card.`);
      const file = chats.sessionFile(chatSession.id);
      if (file === null) throw new CanvasError(409, `The ${caller.assistant} assistant thread has no transcript yet.`);
      return { chatSession, sessionFile: file, chatFile: file };
    }
    throw new CanvasError(400, "caller needs a sessionFile or an assistant id");
  }

  private assistantSession(id: string): AgentSession | null {
    return this.deps.chats.sessions.find((session) => session.kind === "assistant" && session.assistant === id && session.status !== "ended") ?? null;
  }

  /** The canvas self's look: the chat's assistant (name, accent, avatar), else Eva; `name` overrides. */
  private agentFor(chat: AgentSession, name: string | undefined): CanvasAgentInfo {
    let agent: CanvasAgentInfo = EVA;
    if (chat.kind === "assistant" && chat.assistant !== undefined) agent = this.assistantLook(chat.assistant, chat.title);
    else if (this.avatarFile("eva") !== null) agent = { ...EVA, avatar: "/canvas/avatar/eva" };
    const override = name?.trim();
    return override === undefined || override === "" ? agent : { ...agent, name: override.slice(0, 100) };
  }

  /** Assistant `id` as the registry draws it: its title, accent and avatar PNG when there is one. */
  private assistantLook(id: string, fallbackTitle: string): CanvasAgentInfo {
    const config = this.deps.registry.find((entry) => entry.id === id);
    const accent = config?.portrait?.colors?.accent;
    const agent: CanvasAgentInfo = { name: config?.title ?? fallbackTitle, color: accent !== undefined && /^#[0-9a-fA-F]{6}$/.test(accent) ? accent : EVA.color };
    return this.avatarFile(id) === null ? agent : { ...agent, avatar: `/canvas/avatar/${id}` };
  }

  /**
   * A joined agent's look. An assistant joining under its own name (`--as Astra`) looks like that
   * assistant; anyone else gets the color asked for (else the first palette color no one in the
   * room wears, starting at its name's) and the Rooms portrait for its name.
   */
  private participantUser(room: CanvasRoom, name: string, color: string | undefined): User {
    const assistant = this.deps.registry.find((entry) => entry.id === name.toLowerCase() || entry.title.toLowerCase() === name.toLowerCase());
    if (assistant !== undefined) {
      const look = this.assistantLook(assistant.id, name);
      return { ...this.user({ ...look, name }), ...(color === undefined ? {} : { color }) };
    }
    const worn = new Set([room.agent.color.toLowerCase(), ...[...room.participants.values()].map((p) => p.user.color.toLowerCase())]);
    const first = nameHash(name) % PARTICIPANT_COLORS.length;
    const palette = [...PARTICIPANT_COLORS.slice(first), ...PARTICIPANT_COLORS.slice(0, first)];
    const picked = color ?? palette.find((candidate) => !worn.has(candidate)) ?? palette[0] ?? EVA.color;
    return { name, color: picked, kind: "agent", avatar: `/canvas/portrait/${portraitSeed(name)}` };
  }

  private participantInfos(room: CanvasRoom): ParticipantInfo[] {
    return [...room.participants.values()].map((p) => ({ id: p.id, name: p.user.name, color: p.user.color, ...(p.user.avatar === undefined ? {} : { avatar: p.user.avatar }), purpose: p.purpose }));
  }

  private joinResult(room: CanvasRoom, participant: CanvasParticipant, created: boolean): JoinResult {
    const participants = this.participantInfos(room);
    const self = participants.find((p) => p.id === participant.id);
    if (self === undefined) throw new CanvasError(500, "participant missing from its room");
    return { roomId: room.id, slug: room.slug, board: room.board, participant: self, created, agent: room.agent, participants };
  }

  /** The loaded room `ref` names (slug or room id), live or ended. */
  private findRoom(ref: string): CanvasRoom | undefined {
    return this.rooms.get(ref) ?? [...this.rooms.values()].find((room) => room.id === ref);
  }

  /** The live room `ref` names. Throws `CanvasError`: 404 when there is none, 409 once it ended. */
  private liveRoom(ref: string): CanvasRoom {
    const room = this.findRoom(ref);
    if (room === undefined) throw new CanvasError(404, `No live canvas session on ${ref}; start one first (relay-linux canvas start ${ref}).`);
    if (!room.live) throw new CanvasError(409, `The canvas session on ${room.board} has ended.`);
    return room;
  }

  private participant(room: CanvasRoom, id: string): CanvasParticipant {
    for (const participant of room.participants.values()) if (participant.id === id) return participant;
    throw new CanvasError(410, `Participant ${id} is not in ${room.board} (it left, or the host restarted); join again.`);
  }

  private pickSlug(slug: string | undefined, title: string | undefined): string {
    if (slug !== undefined && slug !== "") {
      if (!CanvasSlug.safeParse(slug).success) throw new CanvasError(400, `${slug} is not a board slug (lowercase letters, digits and dashes).`);
      return slug;
    }
    const trimmed = title?.trim() ?? "";
    const base = slugify(trimmed === "" ? "New board" : trimmed);
    let taken: Set<string>;
    try {
      taken = new Set(readdirSync(this.deps.canvasDir).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)));
    } catch {
      taken = new Set();
    }
    for (const loaded of this.rooms.keys()) taken.add(loaded);
    let candidate = base;
    for (let n = 2; taken.has(candidate) || existsSync(boardPath(this.deps.canvasDir, candidate)); n++) candidate = `${base}-${String(n)}`;
    return candidate;
  }
}
