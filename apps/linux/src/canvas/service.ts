// Live canvas rooms on the host. Any omp session that Relay shows (a desktop chat, a phone
// session, an assistant thread, a subagent) starts a room on a board (`POST /canvas/sessions`,
// usually through `relay-linux canvas start`): the room is seeded from `<canvases>/<slug>.json`
// and writes back to it, the agent in it is that same session (name, color, avatar, its chat as
// context), and the chat gets the Join card, each canvas turn and the wrap-up as `relay-canvas`
// rows through the session's relay-bridge. Clients list rooms (`canvas.rooms`) and get a token for
// one (`canvas.open` -> `canvas.access`) to load the web client.
// Handoffs: the canvas self is a full agent with tools and does its own work on the board; what is
// outside its lane (pushes, deploys, messages, purchases: things that need Isaac's yes) it hands to
// the chat ("main"), or to a worker (a participant joined with `--session`), as a message into that
// omp session through the bridge's `reply` (a turn when idle, a steer mid-turn). Isaac's
// `@<Worker> ...` notes go the same way without a canvas self turn. The session lands the work with
// an act carrying the handoff id, and the canvas self confirms it in the room.

import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CanvasSlug, type AgentSession, type CanvasAgent as CanvasAgentInfo, type CanvasEntry, type CanvasRoomInfo, type ServerMessage } from "@relay/protocol";
import { exportBoard, putEdge, putNode, type Board, type BoardEdge, type BoardNode } from "@relay/canvas-live/board";
import { FIRST_PAGE, pageMaps, pagesOf } from "@relay/canvas-live/pages";
import { findMention, type Mentionable } from "@relay/canvas-live/mentions";
import { setAssignee, snapThread } from "@relay/canvas-live/threads";
import { lastDeleted, sinceYourLastTurn, summarizeHistory, type HistoryEntry } from "@relay/canvas-live/history";
import { DOC_KEYS, type ChatMsg, type ModelKey, type Presence, type SessionInfo, type User } from "@relay/canvas-live/shared";
import type { AssistantAgentConfig } from "../assistant/registry";
import { human } from "../host-config";
import { readThreadMemory } from "../live/brief";
import { AGENT_ORIGIN, str } from "./actor";
import { CanvasAgent, systemPrompt, type AgentIdentity } from "./agent";
import type { CanvasMind, HostTool, MindFactory, MindUsage } from "./brain";
import { chatFileOf, subagentName } from "./caller";
import { chatContext } from "./context";
import { ActRefused, CanvasParticipant, MAX_BATCH_ACTIONS, MAX_PARTICIPANTS, parseScript, type ActResult, type ParticipantOptions } from "./participant";
import { BoardFile, boardPath } from "./persist";
import { BoardHistory, HistoryRecorder, historyPath, type Who } from "./history";
import { assistantAvatar, assistantLook, assistantNamed, EVA_LOOK, portraitSeed, sessionAssistant } from "./portrait";
import { CanvasSync, type CanvasPeer } from "./room";
import { CanvasTokens, type CanvasGrant } from "./tokens";
import { sessionActivity } from "./session-activity";
/** How often the bridge sessions behind a room's seats are mirrored into presence. */
const ACTIVITY_MS = 1000;

/** The human every room is for: tokens are bound to this name (the host's owner, see host-config.ts). */
export const canvasHuman = human;
/** Colors for joined agents, picked by name (the first one no one in the room wears yet). */
const PARTICIPANT_COLORS = ["#0ca678", "#f59f00", "#7048e8", "#e8590c", "#1098ad", "#d6336c", "#37b24d", "#4263eb"];
/** Wrap up this long after the last human left. */
export const END_AFTER_MS = 2 * 60_000;
/** Close a room nobody joined after this long (its agent process waits for them). */
export const UNJOINED_END_MS = 30 * 60_000;
/** Ended rooms listed in `canvas.rooms` for their cards. */
const MAX_ENDED = 20;
/**
 * The CLI an agent session runs to work a room (skill://canvas): the owner's checkout when it is
 * there, else this very binary (the packaged relay-host).
 */
const CLI = existsSync(join(homedir(), "Eva", "work", "relay", "apps", "linux", "src", "main.ts"))
  ? "bun ~/Eva/work/relay/apps/linux/src/main.ts"
  : `"${process.execPath}"`;

/** A request the HTTP layer answers with `status` and `{ error: message }`. */
export class CanvasError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** What the rooms need of the omp bridge: its sessions, their files, posting a canvas row into one, and messaging one. */
export interface CanvasChats {
  readonly sessions: readonly AgentSession[];
  sessionForFile(file: string): AgentSession | null;
  sessionFile(sessionId: string): string | null;
  /** Resolves false when the session's bridge predates canvas rows. */
  canvas(sessionId: string, content: string, details: CanvasEntry): Promise<boolean>;
  /** A message into the session as if Isaac typed it (`submit`): a turn when idle, a steer mid-turn. */
  reply(sessionId: string, text: string, submit: boolean): Promise<void>;
}

export interface CanvasServiceDeps {
  /** `~/Library/Application Support/EvaOS/canvases` by default. */
  readonly canvasDir: string;
  readonly chats: CanvasChats;
  /** The assistant registry (names, colors); empty without an agent home. */
  readonly registry: readonly AssistantAgentConfig[];
  /** Name of a plain chat's canvas agent; absent: "Eva". */
  readonly defaultAgentName?: string;
  readonly minds: MindFactory;
  /** The model a new room starts on (the room's model toggle switches it); default opus. */
  readonly model?: ModelKey;
  /** The agent home: the canvas self works there, writes under its work/, and reads its assistants' thread memory. */
  readonly agentHome?: string | null;
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
  /** A comment thread already in the board file (saved by Relay Desktop's Canvas page) the canvas self answers once the room is up. */
  readonly thread?: { readonly id: string; readonly page?: string | undefined } | undefined;
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
  /** The omp session behind it (a bridge session id, or a subagent's id): it joins as a worker. */
  readonly session?: string | undefined;
}

/** One joined agent, as the API lists it. */
export interface ParticipantInfo {
  readonly id: string;
  readonly name: string;
  readonly color: string;
  readonly avatar?: string;
  readonly purpose: string;
  /** Joined with a session behind it: handoffs and `@Name` notes reach it. */
  readonly worker: boolean;
  /** Working: a batch running or a handed-off request not landed yet. */
  readonly status: "working" | "idle";
  readonly task?: string;
}

/** Work the canvas self (or Isaac with `@Name`) handed to the chat or a worker. */
export interface Handoff {
  readonly id: string;
  /** "main" (the chat that started the room) or a worker's lowercased name. */
  readonly to: string;
  readonly toName: string;
  readonly request: string;
  /** Who asked (the human whose note it came from). */
  readonly from: string;
  readonly at: number;
  state: "open" | "landed" | "failed";
  /** The comment thread the request came from; the worker answers there and the landing is confirmed there. */
  readonly thread: string | null;
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
  /** Handoffs still open, oldest first. */
  readonly handoffs: readonly Handoff[];
  /** What the canvas self's agent has spent in this room so far. */
  readonly usage: MindUsage;
  /** Every page in order: its node count and who is on it now (humans, the canvas self, joined agents). */
  readonly pages: readonly PageView[];
  /** The board in file shape (as `<slug>.json` holds it once saved): page-1 at the top level, the others under `pages`. */
  readonly board: Board;
  /** The latest cursor-chat lines, oldest first. */
  readonly chat: readonly Pick<ChatMsg, "kind" | "name" | "text" | "nodeIds" | "ts">[];
}

/** One page of a room, as `GET /canvas/sessions/<room>` lists it. */
export interface PageView {
  readonly id: string;
  readonly title: string;
  readonly nodes: number;
  /** Names of who is on this page now. */
  readonly here: readonly string[];
}

/** One room the host holds: its doc and peers, its file, its agent, and where its chat rows go. */
export class CanvasRoom {
  readonly agents: CanvasAgent[] = [];
  /** Agents that joined with `canvas join`, by lowercased name. */
  readonly participants = new Map<string, CanvasParticipant>();
  /** Everyone who ever joined as a participant, for the wrap-up row. */
  readonly participantNames = new Set<string>();
  /** Every handoff of the room, by id. */
  readonly handoffs = new Map<string, Handoff>();
  endedAt: number | undefined;
  summary: string | null = null;
  humans: readonly string[] = [];
  everJoined = false;
  unjoinedTimer: ReturnType<typeof setTimeout> | undefined;
  /** The board's change log (`<slug>.history.jsonl`) and what fills it from the doc. */
  history: BoardHistory | null = null;
  recorder: HistoryRecorder | null = null;

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

  /** The image srcs the board holds on any page (the only files `/img` serves). */
  imageSrcs(): Set<string> {
    const out = new Set<string>();
    for (const page of pagesOf(this.sync.doc)) {
      for (const node of pageMaps(this.sync.doc, page.id).nodes.values()) {
        const src = node.get("src");
        if (typeof src === "string" && src !== "") out.add(src);
      }
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
  private activityTimer: Timer | undefined;

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
    const grant = this.tokens.issue(slug, deviceId, canvasHuman());
    return { t: "canvas.access", slug, path: `/canvas/${slug}/?token=${encodeURIComponent(grant.token)}`, token: grant.token, expiresAt: grant.expiresAt };
  }

  /** The room `token` opens, with its grant; null when the token or the room is not valid. */
  authorize(slug: string, token: string | null): { room: CanvasRoom; grant: CanvasGrant } | null {
    const room = this.rooms.get(slug);
    const grant = this.tokens.check(slug, token);
    return room === undefined || grant === null ? null : { room, grant };
  }

  /** The SVG behind `/canvas/avatar/<key>`: assistant `key` drawn exactly as Relay desktop draws it, else null. */
  avatarSvg(key: string): string | null {
    return assistantAvatar(this.deps.registry, key);
  }

  /** Where a board's relative image srcs resolve (as EvaOS resolves them). */
  get canvasDir(): string {
    return this.deps.canvasDir;
  }

  /** Starts (or rejoins) a canvas session for the calling chat. Throws `CanvasError`. */
  async start(request: StartRequest): Promise<StartResult> {
    const { chatSession, sessionFile, chatFile } = this.resolveCaller(request.caller);
    const agentHome = this.deps.agentHome ?? homedir();
    // An assistant thread's own memory file comes along (a plain chat has none).
    const memory = chatSession.kind === "assistant" && chatSession.assistant !== undefined ? ((await readThreadMemory(agentHome, chatSession.assistant)) ?? "") : "";
    const slug = this.pickSlug(request.slug, request.title);
    const existing = this.rooms.get(slug);
    if (existing?.live === true) {
      if (existing.chatSessionId !== chatSession.id) {
        // Another assistant is asked about a comment (an @mention on Relay Desktop's Canvas page): it joins the live room as a worker for that thread.
        if (request.thread !== undefined && chatSession.kind === "assistant" && chatSession.assistant !== undefined) {
          this.handThread(existing, chatSession.assistant, request.thread);
          return this.result(existing, false);
        }
        throw new CanvasError(409, `${existing.agent.name} already has a live canvas session on ${existing.board}.`);
      }
      if (request.thread !== undefined) this.handThread(existing, this.selfKey(existing), request.thread);
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
    room.history = new BoardHistory(historyPath(this.deps.canvasDir, slug));
    room.recorder = new HistoryRecorder(sync.doc, room.history, (origin) => this.whoOf(room, origin), () => this.now());
    room.recorder.start();
    const purpose = request.prompt?.trim() ?? "";
    const session: SessionInfo = { roomId, agent: { ...this.user(agent) }, chatTitle: chatSession.title, open: true, startedAt: now, endedAt: null, summary: null };
    sync.doc.transact(() => {
      sync.doc.getMap(DOC_KEYS.meta).set("session", session);
      const settings = sync.doc.getMap(DOC_KEYS.settings);
      if (settings.get("model") === undefined) settings.set("model", this.deps.model ?? "opus");
    }, "host");

    const context = chatContext(chatFile, agent.name, canvasHuman());
    const identity: AgentIdentity = {
      user: this.user(agent),
      human: canvasHuman(),
      chatTitle: chatSession.title,
      purpose,
      chat: context.turns,
      chatTurns: context.turnCount,
      memory: memory.trim(),
      slug,
      workDir: join(agentHome, "work"),
      cli: CLI,
    };
    const model = (sync.doc.getMap(DOC_KEYS.settings).get("model") as ModelKey | undefined) ?? "opus";
    const mind = (tools: readonly HostTool[]): CanvasMind => this.deps.minds({ roomId, slug, systemPrompt: systemPrompt(identity), model, tools });
    const canvasAgent = new CanvasAgent(
      sync.doc,
      sync.awareness,
      identity,
      mind,
      {
        turn: (human, reply) => {
          this.post(room, { kind: "turn", human: { name: human.name, text: human.text }, text: reply }, `Canvas "${room.board}" · ${human.name}: ${human.text}\n${agent.name}: ${reply}`);
        },
        ended: (summary) => {
          this.finish(room, summary);
        },
        log: this.deps.log,
        handoff: (target, request, from) => {
          this.handOff(room, target, request, from?.name ?? canvasHuman(), from?.thread ?? null);
        },
        direct: (msg) => this.route(room, msg),
        changes: (since) => this.changesSince(room, since),
        workers: () => {
          const main = [...room.handoffs.values()].filter((h) => h.state === "open" && h.to === "main");
          return [
            `- main: ${agent.name} in the chat "${chatSession.title}", where ${canvasHuman()} approves what is outside the canvas's lane (pushes, deploys, messages, purchases)${main.length > 0 ? `; working on: ${main.map((h) => h.request).join(" | ")}` : ""}`,
            ...[...room.participants.values()]
              .filter((p) => p.sessionId !== null)
              .map((p) => `- ${p.user.name}: ${p.purpose === "" ? "no purpose given" : p.purpose}; ${p.task === null ? "idle" : `working on: ${p.task}`}`),
          ];
        },
      },
      { endAfterMs: this.deps.endAfterMs ?? END_AFTER_MS, ...this.deps.pacing, restore: (id, origin) => this.restoreIn(room, id, origin) },
    );
    room.agents.push(canvasAgent);
    this.publishMentionables(room);
    sync.onHumans = (humans) => {
      room.humans = humans;
      if (humans.length > 0 && !room.everJoined) {
        room.everJoined = true;
        clearTimeout(room.unjoinedTimer);
      }
      this.changed();
    };
    this.rooms.set(slug, room);
    this.watchActivity();
    // The opener runs now: its cards are on the board and its lines play the moment Isaac joins.
    canvasAgent.prepare();
    if (request.thread !== undefined) this.handThread(room, this.selfKey(room), request.thread);
    room.unjoinedTimer = setTimeout(() => {
      if (!room.everJoined && room.live) void canvasAgent.wrapUp();
    }, this.deps.unjoinedEndMs ?? UNJOINED_END_MS);

    const startLine = [
      `Live canvas started on "${room.board}" (board ${slug}${created ? ", new" : ""}). ${canvasHuman()} has a Join card in this chat; ${agent.name} in the room is this session, with this chat as context.`,
      `Each canvas turn and the wrap-up summary will appear here as canvas rows; they are notes, not turns to answer. ${agent.name} on the canvas is a full agent with your tools and does its own work on the board; only what needs ${canvasHuman()}'s yes (pushes, deploys, messages, purchases) comes back here as a "[Canvas request from ${canvasHuman()}]" message: confirm it with ${canvasHuman()} in this chat, do it, and land it with the command that message gives. Subagents can work the board alongside with their own cursors: relay-linux canvas join ${slug} --as <Name> (add --session <their id> to take requests too).`,
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
   * name, color and portrait. The same name again is the same participant. With `session` it is a
   * worker: handoffs and `@Name` notes go to that omp session. Throws `CanvasError`.
   */
  join(ref: string, request: JoinRequest): JoinResult {
    const room = this.liveRoom(ref);
    const name = request.name.trim().slice(0, 40);
    if (name === "") throw new CanvasError(400, "a participant needs a name (--as <Name>)");
    const key = name.toLowerCase();
    if (key === room.agent.name.toLowerCase() || key === canvasHuman().toLowerCase() || key === "main")
      throw new CanvasError(409, `${name} is already in the room as its ${key === canvasHuman().toLowerCase() ? "human" : "canvas self"}; join under another name.`);
    const session = request.session === undefined || request.session.trim() === "" ? null : this.workerSession(request.session.trim());
    const existing = room.participants.get(key);
    if (existing !== undefined) {
      if (session !== null) existing.sessionId = session;
      return this.joinResult(room, existing, false);
    }
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
      session,
      room.sync.doc,
      room.sync.awareness,
      { ...this.deps.pacing, ...this.deps.participants, restore: (id, origin) => this.restoreIn(room, id, origin) },
      start,
      (gone) => {
        if (room.participants.get(key) === gone) {
          room.participants.delete(key);
          this.publishMentionables(room);
        }
        this.deps.log(`canvas ${room.slug}: ${gone.user.name} left`);
      },
    );
    room.participants.set(key, participant);
    this.publishMentionables(room);
    room.participantNames.add(name);
    this.deps.log(`canvas ${room.slug}: ${name} joined as a ${session === null ? "participant" : `worker for session ${session}`}`);
    return this.joinResult(room, participant, true);
  }

  /**
   * Runs one batch of action lines as participant `participantId` of room `ref`; with `handoffId`,
   * the batch lands that handoff and the canvas self confirms it. Throws `CanvasError`.
   */
  async act(ref: string, participantId: string, script: string, handoffId?: string): Promise<ActResult> {
    const room = this.liveRoom(ref);
    const participant = this.participant(room, participantId);
    const handoff = this.openHandoff(room, handoffId);
    let result: ActResult;
    try {
      result = await participant.act(script);
    } catch (error) {
      if (error instanceof ActRefused) throw new CanvasError(error.status, error.message);
      throw error;
    }
    if (handoff !== undefined) this.land(room, handoff, participant.user.name, result);
    return result;
  }

  /**
   * Runs one batch as the room's canvas self (the chat that started the room acting on the board as
   * itself), after its queued turns; with `handoffId`, the batch lands that handoff. Throws `CanvasError`.
   */
  async selfAct(ref: string, script: string, handoffId?: string): Promise<ActResult> {
    const room = this.liveRoom(ref);
    const handoff = this.openHandoff(room, handoffId);
    const steps = parseScript(script);
    const actions = steps.filter((step) => step.kind === "action").length;
    if (steps.length === 0) throw new CanvasError(400, "nothing to do: no @say or action lines");
    if (actions > MAX_BATCH_ACTIONS) throw new CanvasError(400, `${String(actions)} actions in one batch; send at most ${String(MAX_BATCH_ACTIONS)}`);
    const self = room.agents[0];
    if (self === undefined) throw new CanvasError(500, "the room has no canvas self");
    const result = await self.act(steps);
    if (handoff !== undefined) this.land(room, handoff, room.agent.name, result);
    return result;
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
      handoffs: [...room.handoffs.values()].filter((h) => h.state === "open"),
      usage: room.agents[0]?.usage ?? { requests: 0, tokens: 0, costUsd: 0 },
      pages: this.pageViews(room),
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

  /** The key a room's canvas self answers to in `@name` and thread assignees: its assistant's id, else its lowercased name. */
  private selfKey(room: CanvasRoom): string {
    return room.chat.assistant ?? room.agent.name.toLowerCase();
  }

  /** The participant standing for agent `id`: joined under that key, else under the name of the registry assistant `id`. */
  private workerOf(room: CanvasRoom, id: string): CanvasParticipant | undefined {
    return room.participants.get(id) ?? [...room.participants.values()].find((p) => assistantNamed(this.deps.registry, p.user.name)?.id === id);
  }

  /** Who an `@name` can mean in `room`: its canvas self, the registry's assistants and the agents joined to it (joined ones win a shared id). */
  mentionables(room: CanvasRoom): Mentionable[] {
    const self = this.selfKey(room);
    const byId = new Map<string, Mentionable>();
    for (const a of this.deps.registry) {
      byId.set(a.id, { id: a.id, name: a.title, hint: a.scope, avatar: `/canvas/avatar/${a.id}`, joined: a.id === self });
    }
    byId.set(self, { ...byId.get(self), id: self, name: room.agent.name, color: room.agent.color, avatar: byId.get(self)?.avatar ?? room.agent.avatar, joined: true });
    for (const [key, p] of room.participants) {
      const id = assistantNamed(this.deps.registry, p.user.name)?.id ?? key;
      const was = byId.get(id);
      byId.set(id, { ...was, id, name: p.user.name, color: p.user.color, avatar: p.user.avatar ?? was?.avatar, hint: p.purpose === "" ? was?.hint : p.purpose, joined: true });
    }
    return [...byId.values()];
  }

  /** Puts who the room's `@` menu offers into the doc (`meta.mentionables`), so the room page lists the same names the host routes by. */
  private publishMentionables(room: CanvasRoom): void {
    const meta = room.sync.doc.getMap(DOC_KEYS.meta);
    const next = this.mentionables(room);
    if (JSON.stringify(meta.get("mentionables")) !== JSON.stringify(next)) room.sync.doc.transact(() => meta.set("mentionables", next), "host");
  }

  /** Who made a doc change, by the origin of its transaction, for the board's history. */
  private whoOf(room: CanvasRoom, origin: unknown): Who {
    if (origin === AGENT_ORIGIN) return { name: room.agent.name, role: "agent" };
    if (typeof origin === "string" && origin.startsWith("participant:")) {
      const p = [...room.participants.values()].find((c) => `participant:${c.id}` === origin);
      return { name: p?.user.name ?? "an agent", role: p?.sessionId == null ? "agent" : "worker" };
    }
    if (origin === "host") return { name: "Relay", role: "agent" };
    return { name: room.sync.nameOf(origin) ?? canvasHuman(), role: "human" };
  }

  private pageTitles(room: CanvasRoom): Map<string, string> {
    return new Map(pagesOf(room.sync.doc).map((p) => [p.id, p.title]));
  }

  /** What changed on the board since `since` by anyone but the canvas self, as its turn should read it ("" when nothing). */
  private changesSince(room: CanvasRoom, since: number): string {
    room.recorder?.flush();
    const entries = room.history?.read({ limit: 400 }) ?? [];
    return sinceYourLastTurn(entries, since, room.agent.name, this.pageTitles(room));
  }

  /**
   * Puts back the card or link `id` that the board's history says was deleted (with the links that
   * went with a card), acting as the actor with `origin`. "" when done, else why not.
   */
  private restoreIn(room: CanvasRoom, id: string, origin: string, page?: string): string {
    const { history, recorder } = room;
    if (history === null || recorder === null) return "this room keeps no history";
    recorder.flush();
    const entries = history.read();
    const found = lastDeleted(entries, id, page);
    if (!found?.saved) return `no deleted card or link ${id} in this board's history`;
    if (!pagesOf(room.sync.doc).some((p) => p.id === found.page)) return `page ${found.page} is gone`;
    const maps = pageMaps(room.sync.doc, found.page);
    if (found.kind === "edge" ? maps.edges.has(id) : maps.nodes.has(id)) return `${id} is on the board already`;
    const back: { edge: boolean; id: string; saved: BoardNode | BoardEdge }[] = [{ edge: found.kind === "edge", id, saved: found.saved }];
    if (found.kind === "node") {
      // The links deleted with a card (the same hand, the same moment) come back with it once both ends are there.
      for (const e of entries) {
        const saved = e.saved as BoardEdge | undefined;
        if (e.kind !== "edge" || e.op !== "delete" || saved === undefined || e.page !== found.page || e.who !== found.who || Math.abs(e.ts - found.ts) > 2_000) continue;
        if (!maps.edges.has(e.id) && (saved.source === id || maps.nodes.has(saved.source)) && (saved.target === id || maps.nodes.has(saved.target))) back.push({ edge: true, id: e.id, saved });
      }
    }
    for (const b of back) recorder.markRestore(found.page, b.id);
    room.sync.doc.transact(() => {
      for (const b of back) {
        if (b.edge) putEdge(maps.edges, b.id, b.saved as BoardEdge);
        else putNode(maps.nodes, b.saved as BoardNode);
      }
    }, origin);
    return "";
  }

  /** `canvas restore <slug> <id>`: puts the deleted card or link back, as `as` (a joined agent) or the canvas self. Throws `CanvasError`. */
  restore(ref: string, id: string, as?: string, page?: string): { restored: string } {
    const room = this.liveRoom(ref);
    let origin = AGENT_ORIGIN;
    if (as !== undefined && as !== "") {
      const p = room.participants.get(as.toLowerCase());
      if (p === undefined) throw new CanvasError(404, `${as} is not in ${room.board}; join first.`);
      origin = `participant:${p.id}`;
    }
    const why = this.restoreIn(room, id, origin, page);
    if (why !== "") throw new CanvasError(why.startsWith("no deleted") ? 404 : 409, why);
    return { restored: id };
  }

  /** The board's change log (`canvas show <slug> --history`): entries after `since` (newest `limit`), and them folded. */
  historyOf(slug: string, options: { since?: number; limit?: number } = {}): { entries: HistoryEntry[]; summary: string[] } {
    if (!CanvasSlug.safeParse(slug).success) throw new CanvasError(400, `${slug} is not a board slug.`);
    const room = this.rooms.get(slug);
    room?.recorder?.flush();
    const entries = (room?.history ?? new BoardHistory(historyPath(this.deps.canvasDir, slug))).read(options);
    return { entries, summary: summarizeHistory(entries, room === undefined ? new Map() : this.pageTitles(room)) };
  }

  /**
   * Thread `thread` (saved in the board file before this room, or by someone in it) goes to agent
   * `assistantId`: the thread keeps it as its assignee, and the agent answers the human message that
   * ends it, the canvas self in the room, any other as a worker it joins as for this. Nothing when the
   * thread is missing or already answered, and a thread whose request that worker still holds open is
   * not handed over again.
   */
  private handThread(room: CanvasRoom, assistantId: string, thread: { readonly id: string; readonly page?: string | undefined }): void {
    const page = thread.page ?? FIRST_PAGE;
    const threads = pageMaps(room.sync.doc, page).threads;
    const map = threads.get(thread.id);
    const last = map === undefined ? undefined : snapThread(thread.id, map)?.messages.at(-1);
    if (last?.kind !== "human") return;
    room.sync.doc.transact(() => setAssignee(threads, thread.id, assistantId), "host");
    if (assistantId === this.selfKey(room)) {
      room.agents[0]?.answer(page, thread.id);
      return;
    }
    if ([...room.handoffs.values()].some((h) => h.state === "open" && h.thread === thread.id)) return;
    this.route(room, { id: last.id, kind: "human", name: last.name, color: last.color, text: last.text, nodeIds: [], at: null, ts: last.ts, thread: thread.id, page });
  }

  /**
   * A human's note or comment in `room`: who it is for, by an `@name` anywhere in it, else the
   * thread's assignee (a thread keeps its agent until someone else is mentioned). The thread then
   * stores that agent. True when it went to an agent other than the canvas self (a worker, joined
   * now when it is a registry assistant with a running thread); false leaves the note to the self.
   */
  route(room: CanvasRoom, msg: ChatMsg & { readonly page?: string | undefined }): boolean {
    if (!room.live) return false;
    const page = msg.page ?? FIRST_PAGE;
    const threads = msg.thread === undefined ? undefined : pageMaps(room.sync.doc, page).threads;
    const was = msg.thread === undefined ? undefined : threads?.get(msg.thread)?.get("assignee");
    const mention = findMention(msg.text, this.mentionables(room));
    const target = mention?.candidate.id ?? (typeof was === "string" ? was : null);
    if (target === null) return false;
    if (msg.thread !== undefined && threads !== undefined && target !== was) {
      room.sync.doc.transact(() => setAssignee(threads, msg.thread ?? "", target), "host");
    }
    if (target === this.selfKey(room)) return false;
    let worker = this.workerOf(room, target);
    if (worker?.sessionId == null) {
      const assistant = this.deps.registry.find((a) => a.id === target);
      if (assistant === undefined) return false;
      const session = this.assistantSession(assistant.id);
      if (session === null) {
        this.event(room, `${assistant.title} has no running thread to answer in, so ${room.agent.name} answers instead.`);
        return false;
      }
      try {
        this.join(room.slug, { name: assistant.title, session: session.id, purpose: `answers the comment threads handed to ${assistant.title}` });
      } catch (error) {
        this.event(room, `${assistant.title} could not join: ${error instanceof Error ? error.message : String(error)}`);
        return false;
      }
      worker = this.workerOf(room, target);
    }
    if (worker?.sessionId == null) return false;
    const request = (mention === null ? msg.text : `${msg.text.slice(0, mention.start)}${msg.text.slice(mention.end)}`).replace(/^[\s,:]+/, "").trim();
    const name = worker.user.name;
    // Out of the chat observer that saw the note, so its own chat line is a separate change.
    queueMicrotask(() => {
      this.handOff(room, name, request === "" ? msg.text : request, msg.name, msg.thread ?? null, msg.thread === undefined ? undefined : page);
    });
    return true;
  }

  /**
   * Hands `request` to `target` ("main", the canvas self's own name, or a worker's name): a chat
   * line in the room, the target shown as working on it, and the request delivered into the target
   * session as a message telling it how to land the work. A participant with no session behind it,
   * or an unknown name, gets nothing: the request goes to main instead.
   */
  private handOff(room: CanvasRoom, target: string, request: string, from: string, thread: string | null, threadPage?: string): void {
    if (!room.live || request.trim() === "") return;
    const key = target.replace(/^@/, "").toLowerCase();
    const named = key === "main" || key === room.agent.name.toLowerCase() ? undefined : room.participants.get(key);
    const worker = named?.sessionId == null ? undefined : named;
    if (worker === undefined && key !== "main" && key !== room.agent.name.toLowerCase())
      this.deps.log(`canvas ${room.slug}: handoff to ${target} goes to main (${named === undefined ? "no such participant" : "it has no session behind it"})`);
    this.seq += 1;
    const handoff: Handoff = {
      id: `h${this.now().toString(36)}${String(this.seq)}`,
      to: worker === undefined ? "main" : key,
      toName: worker?.user.name ?? room.agent.name,
      request: request.trim(),
      from,
      at: this.now(),
      state: "open",
      thread,
    };
    room.handoffs.set(handoff.id, handoff);
    this.event(room, `Handed to ${handoff.toName}: ${handoff.request}`);
    this.showTask(room, handoff.to);
    const as = worker === undefined ? "" : ` --as "${worker.user.name}"`;
    // On a board with pages, the batch goes to the page the request came from (a comment's page, else where the canvas self is now).
    const page = threadPage ?? room.agents[0]?.page ?? FIRST_PAGE;
    const pages = pagesOf(room.sync.doc);
    const text = [
      `[Canvas request from ${from}] ${handoff.request}`,
      `(Live canvas "${room.board}", board ${room.slug}, handoff ${handoff.id}.) ${worker === undefined ? `The canvas hands you what needs ${from}'s yes (it acts outside this machine or in ${from}'s name): ask ${from} here first, in one line, and do it only once the answer is yes. ` : ""}Do it with your tools, then put the result on the board ${worker === undefined ? `as ${room.agent.name} (your cursor in the room)` : `as ${worker.user.name}`} and close the handoff, in one batch:`,
      `${CLI} canvas act ${room.slug}${as} --handoff ${handoff.id} - <<'EOF'`,
      ...(pages.length > 1 ? [`@page ${page}`] : []),
      "@add_image <new-id> <x> <y> <w> </absolute/path.png>",
      "<title>",
      "<caption>",
      "@end",
      "EOF",
      `Any action lines work (@add_node, @add_frame, @say ...; skill://canvas section 9). Free space: ${CLI} canvas show ${room.slug}. ${room.agent.name} confirms it to ${from} ${thread === null ? "in the room" : "in the comment thread"} when it lands.`,
      ...(thread === null ? [] : [`${from} asked in comment thread ${thread} on the board: answer there with "@reply ${thread} <one line>" in the batch, not @say.`]),
    ].join("\n");
    const sessionId = worker?.sessionId ?? room.chatSessionId;
    this.deps.chats.reply(sessionId, text, true).then(
      () => {
        this.deps.log(`canvas ${room.slug}: handoff ${handoff.id} delivered to ${handoff.toName} (session ${sessionId})`);
      },
      (error: unknown) => {
        const why = error instanceof Error ? error.message : String(error);
        handoff.state = "failed";
        this.showTask(room, handoff.to);
        this.event(room, `Could not reach ${handoff.toName}: ${why}`);
        this.deps.log(`canvas ${room.slug}: handoff ${handoff.id} to ${handoff.toName} failed: ${why}`);
      },
    );
  }

  /** The handoff an act lands; undefined without an id. Throws `CanvasError` for one this room does not have open. */
  private openHandoff(room: CanvasRoom, id: string | undefined): Handoff | undefined {
    if (id === undefined || id === "") return undefined;
    const handoff = room.handoffs.get(id);
    if (handoff === undefined) throw new CanvasError(404, `No handoff ${id} in ${room.board}.`);
    if (handoff.state === "landed") throw new CanvasError(409, `Handoff ${id} already landed; act without --handoff to add more.`);
    return handoff;
  }

  /** A handoff's work is on the board: the target goes back to idle and the canvas self confirms it. */
  private land(room: CanvasRoom, handoff: Handoff, by: string, result: ActResult): void {
    handoff.state = "landed";
    this.showTask(room, handoff.to);
    // A card id is per page: name the page of a card that is not on page-1.
    const pages = pagesOf(room.sync.doc);
    const cards = result.added.map((id) => {
      const page = pages.find((p) => pageMaps(room.sync.doc, p.id).nodes.has(id));
      const node = page === undefined ? undefined : pageMaps(room.sync.doc, page.id).nodes.get(id);
      return `${id} ("${node === undefined ? "" : str(node, "title")}")${page === undefined || page.id === FIRST_PAGE ? "" : ` on page ${page.id}`}`;
    });
    const text = [
      `${by} finished what ${handoff.from} asked for: "${handoff.request}".`,
      cards.length === 0 ? "No new cards." : `New cards: ${cards.join(", ")}.`,
      ...(result.said.length === 0 ? [] : [`${by} said: ${result.said.join(" / ")}`]),
      ...(result.skipped.length === 0 ? [] : [`Did not run: ${result.skipped.join("; ")}`]),
    ].join(" ");
    this.deps.log(`canvas ${room.slug}: handoff ${handoff.id} landed by ${by} (${String(result.ran)} actions)`);
    room.agents[0]?.landed(text, handoff.thread);
  }

  /** Shows on `to` ("main" or a worker's key) the oldest request it still has open, or none. */
  private showTask(room: CanvasRoom, to: string): void {
    const next = [...room.handoffs.values()].find((h) => h.state === "open" && h.to === to)?.request ?? null;
    if (to === "main") room.agents[0]?.setTask(next);
    else room.participants.get(to)?.setTask(next);
  }

  /** A session notice in the room's chat, in the canvas self's name. */
  private event(room: CanvasRoom, text: string): void {
    const { name, color } = room.agent;
    room.sync.doc.transact(() => {
      room.sync.doc.getArray<ChatMsg>(DOC_KEYS.chat).push([{ id: `ev-${this.now().toString(36)}-${String(this.seq)}`, kind: "event", name, color, text, nodeIds: [], at: null, ts: this.now() }]);
    }, "host");
  }

  /**
   * The live bridge session `ref` names: its id, or a subagent's (bridge id `<parent>:<agent id>`;
   * a nested agent id may come dotted, `Parent.Child`, or bare). Throws `CanvasError`.
   */
  private workerSession(ref: string): string {
    const live = this.deps.chats.sessions.filter((session) => session.status !== "ended");
    const leaf = (id: string): string => id.split(":").at(-1)?.split(".").at(-1) ?? id;
    const found = live.find((session) => session.id === ref) ?? live.find((session) => session.id.includes(":") && leaf(session.id) === leaf(ref));
    if (found === undefined) throw new CanvasError(404, `No live omp session ${ref} on this host (give a session id, or a subagent's id).`);
    return found.id;
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
    clearInterval(this.activityTimer);
    this.activityTimer = undefined;
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

  /** The agent wrapped up (its mind is gone): summary to the chat, room ended, file written. */
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
    room.file.flush();
    this.deps.log(`canvas ${room.slug}: wrapped up`);
    if (room.sync.peerCount === 0) this.unload(room);
    else this.changed();
  }

  private unload(room: CanvasRoom, silent = false): void {
    if (this.rooms.get(room.slug) !== room) return;
    this.rooms.delete(room.slug);
    clearTimeout(room.unjoinedTimer);
    room.recorder?.stop();
    for (const agent of room.agents) agent.dispose();
    for (const participant of [...room.participants.values()]) participant.leave(true);
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

  /** Mirrors the bridge sessions behind the rooms' seats (the chat, each worker) into presence once a second while a room is live. */
  private watchActivity(): void {
    if (this.activityTimer !== undefined) return;
    this.activityTimer = setInterval(() => {
      const live = [...this.rooms.values()].filter((room) => room.live);
      if (live.length === 0) {
        clearInterval(this.activityTimer);
        this.activityTimer = undefined;
        return;
      }
      const { sessions } = this.deps.chats;
      const activity = (id: string): string | null => sessionActivity(sessions.find((session) => session.id === id));
      for (const room of live) {
        room.agents[0]?.showChatActivity(activity(room.chatSessionId));
        for (const participant of room.participants.values()) if (participant.sessionId !== null) participant.setDoing(activity(participant.sessionId));
      }
    }, ACTIVITY_MS);
    this.activityTimer.unref();
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

  /**
   * The canvas self's look: the assistant the chat belongs to (its own thread, work it started, or
   * the top session of a helper), else the plain-chat agent; `name` overrides. Whatever the name,
   * when it is a registry assistant's it wears that assistant's face and accent, the same drawing
   * as Relay desktop's chat header.
   */
  private agentFor(chat: AgentSession, name: string | undefined): CanvasAgentInfo {
    const { top, assistant } = sessionAssistant(this.deps.chats.sessions, chat);
    const override = name?.trim().slice(0, 100) ?? "";
    const named = assistantNamed(this.deps.registry, override !== "" ? override : assistant === undefined ? (this.deps.defaultAgentName ?? "") : "");
    const id = named?.id ?? assistant;
    const agent: CanvasAgentInfo = id !== undefined ? assistantLook(this.deps.registry, id, top.title) : { ...EVA_LOOK, ...(this.deps.defaultAgentName === undefined ? {} : { name: this.deps.defaultAgentName }) };
    return override === "" ? agent : { ...agent, name: override };
  }

  /**
   * A joined agent's look. An assistant joining under its own name (`--as Astra`) looks like that
   * assistant; anyone else gets the color asked for (else the first palette color no one in the
   * room wears, starting at its name's) and the Rooms portrait for its name.
   */
  private participantUser(room: CanvasRoom, name: string, color: string | undefined): User {
    const assistant = assistantNamed(this.deps.registry, name);
    if (assistant !== undefined) {
      const look = assistantLook(this.deps.registry, assistant.id, name);
      return { ...this.user({ ...look, name }), ...(color === undefined ? {} : { color }) };
    }
    const worn = new Set([room.agent.color.toLowerCase(), ...[...room.participants.values()].map((p) => p.user.color.toLowerCase())]);
    const first = nameHash(name) % PARTICIPANT_COLORS.length;
    const palette = [...PARTICIPANT_COLORS.slice(first), ...PARTICIPANT_COLORS.slice(0, first)];
    const picked = color ?? palette.find((candidate) => !worn.has(candidate)) ?? palette[0] ?? EVA_LOOK.color;
    return { name, color: picked, kind: "agent", avatar: `/canvas/portrait/${portraitSeed(name)}` };
  }

  private pageViews(room: CanvasRoom): PageView[] {
    const here = new Map<string, string[]>();
    for (const state of (room.sync.awareness.getStates() as Map<number, Partial<Presence>>).values()) {
      if (state.user === undefined) continue;
      const page = state.page ?? FIRST_PAGE;
      here.set(page, [...(here.get(page) ?? []), state.user.name]);
    }
    return pagesOf(room.sync.doc).map((p) => ({ id: p.id, title: p.title, nodes: pageMaps(room.sync.doc, p.id).nodes.size, here: here.get(p.id) ?? [] }));
  }

  private participantInfos(room: CanvasRoom): ParticipantInfo[] {
    return [...room.participants.values()].map((p) => ({
      id: p.id,
      name: p.user.name,
      color: p.user.color,
      ...(p.user.avatar === undefined ? {} : { avatar: p.user.avatar }),
      purpose: p.purpose,
      worker: p.sessionId !== null,
      status: p.working ? "working" : "idle",
      ...(p.task === null ? {} : { task: p.task }),
    }));
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
