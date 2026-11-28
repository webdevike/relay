// Per-item assistant sessions for Reviews (evaos-electron astra-sessions.ts, on the host's
// omp-in-herdr machinery). The first @Astra (or any registry assistant's) ask on a PR, ticket or
// Slack thread launches a real omp session with that assistant's registry profile and model in its
// own herdr workspace titled `<Name> · <label>`, registered with this host's agent socket, so it is
// in the Agent Inbox and her approvals reach Isaac as usual. It is NOT her main thread: no
// RELAY_ASSISTANT. The seed is her prime, her thread memory, the item and the question; later asks
// go to the live session as turns, or resume its file once it ended. Each assistant has its own
// session per item: store key `<agent>|<url>`, Astra's under the bare url as before. Every change of
// an item's session goes out as `reviews.astra`.

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { splitPins, untagged, type AgentMessage, type AstraItem, type AstraTurn } from "@relay/protocol";
import { z } from "zod";
import type { LaunchOptions } from "../agents/herdr";
import { parseSessionRows } from "../agents/transcript";
import { loadRegistry, type AssistantAgentConfig } from "../assistant/registry";
import { splitReplies } from "../assistant/replies";
import type { AgentProvider, AgentProviderChange } from "../seams";
import type { SessionClock } from "../session";
import { readJson, writeJson } from "./exec";

const ASTRA = "astra";
/** A registry id: also a path segment of the prime and memory, so nothing else gets in. */
const AGENT_ID = /^[a-z][a-z0-9-]*$/;
/** Streamed updates go out at most this often per item. */
const EMIT_MS = 150;
/** Where Isaac's own words start in a prompt Reviews sent; the seed above it is not shown. */
export const ASK_MARK = "\n\n---\nIsaac asks:\n";
/** The only tools a read-only item session gets: nothing that writes, runs commands or posts. */
export const ITEM_SESSION_TOOLS = "read,grep,glob,web_search";
/** Provider credentials a read-only item session must not see. */
const SCRUBBED_ENV = ["LINEAR_API_KEY", "GH_TOKEN", "GITHUB_TOKEN"] as const;

const Store = z.record(
  z.string(),
  z.object({
    title: z.string(),
    sessionFile: z.string().nullable(),
    sessionId: z.string().nullable(),
    /** Launched with ITEM_SESSION_TOOLS and the scrubbed env. */
    readOnly: z.literal(true).optional(),
  }),
);
type StoreEntry = z.infer<typeof Store>[string];

/** Where an assistant's session on an item is kept: Astra's under the bare url (older entries too). */
export function storeKey(agent: string, url: string): string {
  return agent === ASTRA ? url : `${agent}|${url}`;
}

function keyParts(key: string): { agent: string; url: string } {
  const m = /^([a-z][a-z0-9-]*)\|(.*)$/.exec(key);
  return m === null ? { agent: ASTRA, url: key } : { agent: m[1] ?? ASTRA, url: m[2] ?? "" };
}

/** An assistant's name before its registry entry is read: `nova` -> `Nova`. */
const named = (agent: string): string => agent.charAt(0).toUpperCase() + agent.slice(1);

const errText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * The first message of an item session: the assistant's prime, what is different about this
 * session, her thread memory, the item, then Isaac's question after `ASK_MARK`. `agent` and `name`
 * default to Astra's.
 */
export function seedPrompt(o: {
  prime: string;
  memory: string | null;
  title: string;
  label: string;
  url: string;
  context: string;
  question: string;
  agent?: string;
  name?: string;
  /** The session runs with ITEM_SESSION_TOOLS and no Linear or GitHub credentials. */
  readOnly?: boolean;
}): string {
  const name = o.name ?? "Astra";
  const memoryPath = `work/eva/agents/${o.agent ?? ASTRA}/thread.md`;
  const readOnly =
    o.readOnly === true
      ? `\n- This session can only read: its tools are ${ITEM_SESSION_TOOLS.split(",").join(", ")}, and it has no Linear or GitHub credentials, so nothing you do here can post, comment or change anything.`
      : "";
  return `${o.prime}

---
This session is not your main thread. Isaac opened it from Reviews in Relay on his phone to talk with you about one item: ${o.label} (${o.url}). It is titled "${o.title}" and stays about that item: every @${name} question he asks on it comes here, and he reads your answers inline under the item's comment box.
Everything in your prime still holds: your scope, tools, skills, delegation, approvals, and the hard rules (Slack sends only from the desktop app, nothing posted, commented or sent on GitHub, Linear or Slack without his OK on the exact text). ${readOnly === "" ? "Three" : "Four"} differences:
- Your thread memory is below, so skip reading it on start; do the other start reads only if you need them.
- This first message carries his question: answer it instead of replying "(nothing to report)".
- Leave ${memoryPath} alone from here unless he asks.${readOnly}
When he wants something posted, write the exact text he could send: Reviews has a "Use as reply" button that copies your answer into the comment box, and he confirms before anything posts.

## Your thread memory (${memoryPath})

${o.memory === null || o.memory.trim() === "" ? "(empty)" : o.memory.trim()}

## The item

${o.context.trim()}${ASK_MARK}${o.question.trim()}`;
}

/** A transcript row: the provider's `AgentMessage` or a parsed session-file row (a streamed one has no time yet). */
type Row = Pick<AgentMessage, "id" | "role" | "text" | "tool" | "streaming"> & {
  readonly at?: number;
};

/**
 * Rows as Reviews shows them: Isaac's words only (the seed above `ASK_MARK` hidden), tool rows as
 * one line; omp's notices and empty rows dropped.
 */
export function toTurns(messages: readonly Row[]): AstraTurn[] {
  const turns: AstraTurn[] = [];
  for (const m of messages) {
    const streaming = m.streaming === true;
    const at = m.at === undefined ? {} : { at: m.at };
    if (m.role === "system") continue;
    if (m.role === "user") {
      const mark = m.text.lastIndexOf(ASK_MARK);
      turns.push({
        id: m.id,
        role: "user",
        text: mark >= 0 ? m.text.slice(mark + ASK_MARK.length) : m.text,
        streaming: false,
        ...at,
      });
    } else if (m.role === "tool") {
      const line =
        (m.tool === undefined ? m.text : `${m.tool.name} ${m.tool.summary}`)
          .trim()
          .split("\n")[0] ?? "";
      if (line !== "") turns.push({ id: m.id, role: "tool", text: line, streaming, ...at });
    } else if (m.text.trim() !== "" || streaming) {
      // Her prime ends replies with a `[[replies: a | b]]` chip token for the phone's thread; Reviews has no chips.
      const { text } = splitReplies(splitPins(m.text, streaming).text, streaming);
      if (text.trim() !== "" || streaming)
        turns.push({ id: m.id, role: "assistant", text, streaming, ...at });
    }
  }
  return turns;
}

/** How many of Isaac's turns carry `text` (a surface tag or the seed around it does not matter). */
function userTurns(turns: readonly AstraTurn[], text: string): number {
  const asked = text.trim();
  return turns.filter((t) => t.role === "user" && untagged(t.text).includes(asked)).length;
}

/** A session file's rows; none when it is missing (the next ask starts a new session). */
function fileRows(file: string | null | undefined): Row[] {
  if (file === null || file === undefined) return [];
  try {
    let next = 0;
    return parseSessionRows(readFileSync(file, "utf8"), null, () => `r${String((next += 1))}`);
  } catch {
    return [];
  }
}

/** What a live session is blocked on, as the item shows it. */
function waitingOf(live: AgentProvider["sessions"][number], name: string): string | null {
  const detail = live.statusDetail?.trim();
  if (live.status === "needs_permission")
    return `Waiting for your approval${detail ? `: ${detail}` : ""}`;
  if (live.status !== "waiting") return null;
  return detail !== undefined && detail !== "" ? detail : `${name} is asking you something`;
}

export interface AstraSessionsDeps {
  readonly agents: Pick<AgentProvider, "sessions" | "conversation" | "reply" | "configure">;
  /** The bridge's `launchJoined`; null when the host has no agent home. */
  readonly launch:
    ((options: LaunchOptions) => Promise<{ readonly joined: Promise<string> }>) | null;
  /** A live session's transcript file, when omp reported one. */
  readonly sessionFile: (sessionId: string) => string | null;
  readonly agentHome: string | null;
  /** This host's agent socket: the item's omp registers here (a test host's sessions come back to it). */
  readonly socketPath: string;
  /** `astra.json`: per `storeKey` its title, session id and file. */
  readonly storePath: string;
  readonly emit: (item: AstraItem) => void;
  readonly clock: SessionClock;
  readonly log: (line: string) => void;
  /** The first message of a new session; Reviews' `seedPrompt` when absent. */
  readonly seed?: (o: Parameters<typeof seedPrompt>[0]) => string;
  /**
   * Every launch and resume gets only ITEM_SESSION_TOOLS and no provider credentials (empty
   * LINEAR_API_KEY, GH_TOKEN, GITHUB_TOKEN; GH_CONFIG_DIR an empty dir beside the store), so hostile
   * item text can't write to Linear or GitHub. A live session started without them is not reused.
   */
  readonly readOnly?: boolean;
}

/** A launch that has not registered yet, or failed. */
interface Pending {
  readonly question: string;
  /** Epoch ms he asked. */
  readonly at: number;
  readonly starting: boolean;
  readonly error: string | null;
}

/** One launch of an item session. */
interface Launch {
  readonly key: string;
  readonly url: string;
  readonly agent: string;
  readonly title: string;
  readonly label: string;
  readonly text: string;
  readonly askedAt: number;
  readonly file: string | null;
  readonly prompt: string;
  readonly config: AssistantAgentConfig;
}

type ItemBase = Pick<AstraItem, "url" | "title" | "agent">;

export class AstraSessions {
  private readonly store: Record<string, StoreEntry>;
  /** Per store key below. */
  private readonly pending = new Map<string, Pending>();
  /** Streamed text per session and message id, until the message settles into the conversation. */
  private readonly streams = new Map<string, Map<string, { text: string; streaming: boolean }>>();
  private readonly timers = new Map<string, () => void>();
  /** Each item's last seen session status, so a `sessions` change pushes only the items it moved. */
  private readonly statusKeys = new Map<string, string>();
  /**
   * The newest ask per item until the session's transcript shows it (`before` = how many of his
   * turns with those words it showed when he asked). A launched omp registers before its first
   * prompt is submitted, so its first snapshots have no turns at all.
   */
  private readonly asked = new Map<string, { text: string; before: number; at: number }>();

  constructor(private readonly deps: AstraSessionsDeps) {
    const parsed = Store.safeParse(readJson(deps.storePath, {}));
    this.store = parsed.success ? parsed.data : {};
  }

  private remember(key: string, entry: StoreEntry): void {
    this.store[key] = entry;
    writeJson(this.deps.storePath, this.store);
  }

  private entry(title: string, sessionFile: string | null, sessionId: string | null): StoreEntry {
    return { title, sessionFile, sessionId, ...(this.deps.readOnly === true ? { readOnly: true as const } : {}) };
  }

  private live(
    sessionId: string | null | undefined,
  ): AgentProvider["sessions"][number] | undefined {
    return sessionId === null || sessionId === undefined
      ? undefined
      : this.deps.agents.sessions.find((s) => s.id === sessionId && s.status !== "ended");
  }

  /** The live session an ask goes to: none when it was started without this host's read-only rules. */
  private reusable(saved: StoreEntry | undefined): AgentProvider["sessions"][number] | undefined {
    if (this.deps.readOnly === true && saved?.readOnly !== true) return undefined;
    return this.live(saved?.sessionId);
  }

  /** The file a launch resumes: none when it is gone, or a session it can't reuse still runs on it. */
  private resumable(saved: StoreEntry | undefined): string | null {
    const file = saved?.sessionFile ?? null;
    if (file === null || !existsSync(file)) return null;
    return this.live(saved?.sessionId) === undefined ? file : null;
  }

  private readHome(rel: string): string | null {
    if (this.deps.agentHome === null) return null;
    try {
      return readFileSync(join(this.deps.agentHome, rel), "utf8");
    } catch {
      return null;
    }
  }

  private registryAgent(agent: string): AssistantAgentConfig {
    if (!AGENT_ID.test(agent)) throw new Error(`Not an assistant id: ${agent}`);
    let found: AssistantAgentConfig | undefined;
    try {
      found = loadRegistry(this.deps.agentHome ?? "").find((a) => a.id === agent);
    } catch (error) {
      throw new Error(errText(error));
    }
    if (found === undefined) throw new Error(`${named(agent)} is not in .omp/assistant/agents.json`);
    return found;
  }

  /** The assistant's registry title (`Astra`, `Nova`); its id capitalized when the registry can't say. */
  agentName(agent: string = ASTRA): string {
    try {
      return this.registryAgent(agent).title;
    } catch {
      return named(agent);
    }
  }

  /** The first message of a new session: the assistant's prime, memory, the item and the question. */
  private seedFor(
    agent: string,
    name: string,
    o: Pick<Parameters<typeof seedPrompt>[0], "title" | "label" | "url" | "context" | "question">,
  ): string {
    const primePath = join(".omp", "assistant", "agents", agent, "prime.md");
    const prime = this.readHome(primePath)?.trim();
    if (!prime) throw new Error(`${name}'s prime (${primePath}) is missing`);
    return (this.deps.seed ?? seedPrompt)({
      prime,
      memory: this.readHome(join("work", "eva", "agents", agent, "thread.md")),
      ...o,
      ...(agent === ASTRA ? {} : { agent, name }),
      ...(this.deps.readOnly === true ? { readOnly: true } : {}),
    });
  }

  /**
   * Isaac's question to the item's session with assistant `agent` (Astra by default): a turn in the
   * live one, else a launch (resuming its file, or seeded with `context()` for a first ask). Answers
   * the item as it stands; the launch's join and every later change go out through `emit`. `turn`
   * is what a live or resumed session receives instead of the bare question (Meetings adds the
   * transcript since the last ask above ASK_MARK); the question alone is what the item shows.
   */
  async ask(
    url: string,
    title: string,
    label: string,
    context: () => Promise<string>,
    text: string,
    turn: string = text,
    agent: string = ASTRA,
  ): Promise<AstraItem> {
    const launch = this.deps.launch;
    if (launch === null || this.deps.agentHome === null)
      throw new Error(`${named(agent)} asks need the host's --agent-home`);
    const key = storeKey(agent, url);
    const saved = this.store[key];
    const live = this.reusable(saved);
    const askedAt = await this.markAsked(key, text);
    if (live !== undefined) {
      await this.deps.agents.reply(live.id, turn, true);
      return (await this.snapshotOf(key)) ?? this.empty(key, title);
    }
    if (this.pending.get(key)?.starting === true)
      throw new Error(`${named(agent)} is still starting on this item`);
    const config = this.registryAgent(agent);
    const file = this.resumable(saved);
    const prompt =
      file === null
        ? this.seedFor(agent, config.title, { title, label, url, context: await context(), question: text })
        : turn;
    return this.launchSession(launch, { key, url, agent, title, label, text, askedAt, file, prompt, config });
  }

  /** omp's options for an item session; a resume gets the same tools and env as the launch. */
  private launchOptions(s: Launch): LaunchOptions {
    const readOnly = this.deps.readOnly === true;
    return {
      prompt: s.prompt,
      label: s.title,
      // Named by the host (below), as Relay Desktop names its item sessions; omp's auto-title would rename it.
      ompArgs: readOnly ? ["--no-title", `--tools=${ITEM_SESSION_TOOLS}`] : ["--no-title"],
      env: { RELAY_AGENTS_SOCKET: this.deps.socketPath, ...(readOnly ? this.scrubbedEnv() : {}) },
      ...(s.config.profile === undefined ? {} : { profile: s.config.profile }),
      ...(s.config.model === undefined ? {} : { model: s.config.model }),
      ...(s.file === null ? {} : { resume: s.file }),
    };
  }

  /**
   * The provider credentials blanked (herdr can only set pane env, and an empty token reads as none
   * to gh and Linear clients) and gh pointed at an empty config dir beside the store.
   */
  private scrubbedEnv(): Record<string, string> {
    const ghConfigDir = join(dirname(this.deps.storePath), "assistant-gh");
    mkdirSync(ghConfigDir, { recursive: true, mode: 0o700 });
    return { ...Object.fromEntries(SCRUBBED_ENV.map((key) => [key, ""])), GH_CONFIG_DIR: ghConfigDir };
  }

  private async launchSession(launch: NonNullable<AstraSessionsDeps["launch"]>, s: Launch): Promise<AstraItem> {
    const { key, title, text, askedAt, file } = s;
    const failed = (error: unknown): string => `Couldn't start ${s.config.title}: ${errText(error)}`;
    this.remember(key, this.entry(title, file, null));
    this.pending.set(key, { question: text, at: askedAt, starting: true, error: null });
    let joined: Promise<string>;
    try {
      ({ joined } = await launch(this.launchOptions(s)));
    } catch (error) {
      this.pending.set(key, { question: text, at: askedAt, starting: false, error: failed(error) });
      this.schedule(key);
      throw new Error(failed(error));
    }
    joined.then(
      (sessionId) => {
        this.pending.delete(key);
        this.remember(key, this.entry(title, this.deps.sessionFile(sessionId) ?? file, sessionId));
        this.deps.agents.configure({ sessionId, title }).catch((error: unknown) => {
          this.deps.log(`reviews: could not name ${sessionId}: ${errText(error)}`);
        });
        this.schedule(key);
      },
      (error: unknown) => {
        this.pending.set(key, { question: text, at: askedAt, starting: false, error: failed(error) });
        this.schedule(key);
      },
    );
    this.deps.log(
      `reviews: ${s.config.title} session for ${s.label} launching${file === null ? "" : ` (resuming ${file})`}`,
    );
    return (await this.snapshotOf(key)) ?? this.empty(key, title);
  }

  private base(key: string, title: string): ItemBase {
    const { agent, url } = keyParts(key);
    return { url, title, ...(agent === ASTRA ? {} : { agent }) };
  }

  private empty(key: string, title: string): AstraItem {
    return { ...this.base(key, title), sessionId: null, turns: [], working: false, waiting: null, error: null };
  }

  /** The item's session with `agent`: live from the provider, else its file; null when it never had one. */
  async snapshot(url: string, agent: string = ASTRA): Promise<AstraItem | null> {
    return this.snapshotOf(storeKey(agent, url));
  }

  private async snapshotOf(key: string): Promise<AstraItem | null> {
    const saved = this.store[key];
    const pending = this.pending.get(key);
    if (saved === undefined && pending === undefined) return null;
    const base = this.base(key, saved?.title ?? named(keyParts(key).agent));
    const live = this.live(saved?.sessionId);
    if (live !== undefined) return this.liveItem(key, base, live);
    return this.fileItem(base, saved?.sessionFile, pending);
  }

  /** Remembers his newest ask until the transcript shows it; answers when he asked. */
  private async markAsked(key: string, text: string): Promise<number> {
    const shown = await this.snapshotOf(key);
    const at = this.deps.clock.now();
    this.asked.set(key, { text: text.trim(), before: userTurns(shown?.turns ?? [], text), at });
    return at;
  }

  /** An item without a live session: its file's turns, and his question while it starts. */
  private fileItem(base: ItemBase, file: string | null | undefined, pending: Pending | undefined): AstraItem {
    const turns = toTurns(fileRows(file));
    const starting = pending?.starting === true;
    if (starting)
      turns.push({ id: "pending", role: "user", text: pending.question, streaming: false, at: pending.at });
    return { ...base, sessionId: null, turns, working: starting, waiting: null, error: pending?.error ?? null };
  }

  /** A live session's rows with the streamed text it has not settled yet. */
  private async rows(sessionId: string): Promise<Row[]> {
    const rows: Row[] = (await this.deps.agents.conversation(sessionId)) ?? [];
    const streams = this.streams.get(sessionId);
    if (streams === undefined) return rows;
    const merged: Row[] = rows.map((row) => {
      const stream = streams.get(row.id);
      return stream === undefined ? row : { ...row, ...stream };
    });
    const known = new Set(rows.map((row) => row.id));
    for (const [id, stream] of streams)
      if (!known.has(id)) merged.push({ id, role: "assistant", ...stream });
    return merged;
  }

  private async liveItem(
    key: string,
    base: ItemBase,
    live: AgentProvider["sessions"][number],
  ): Promise<AstraItem> {
    const turns = toTurns(await this.rows(live.id));
    const item = { ...base, sessionId: live.id, turns, waiting: waitingOf(live, named(keyParts(key).agent)), error: null };
    const asked = this.asked.get(key);
    if (asked !== undefined && userTurns(turns, asked.text) <= asked.before) {
      // Sent, not in the transcript yet: his bubble stays and she counts as working.
      turns.push({ id: "pending", role: "user", text: asked.text, streaming: false, at: asked.at });
      return { ...item, working: true };
    }
    this.asked.delete(key);
    return { ...item, working: live.status === "working" };
  }

  /** Every provider change: the items whose session it touches are pushed (debounced). */
  observe(change: AgentProviderChange): void {
    if (change.kind === "gate") return;
    if (change.kind === "sessions") {
      this.observeSessions();
      return;
    }
    const key = Object.keys(this.store).find((k) => this.store[k]?.sessionId === change.sessionId);
    if (key === undefined) return;
    if (change.kind === "message") {
      const streams =
        this.streams.get(change.sessionId) ??
        new Map<string, { text: string; streaming: boolean }>();
      streams.set(change.id, { text: change.text, streaming: change.streaming });
      this.streams.set(change.sessionId, streams);
    } else if (change.kind === "conversation") {
      const streams = this.streams.get(change.sessionId);
      for (const message of change.appended) streams?.delete(message.id);
    }
    this.schedule(key);
  }

  private observeSessions(): void {
    for (const [key, entry] of Object.entries(this.store)) {
      if (entry.sessionId === null) continue;
      const live = this.live(entry.sessionId);
      const file = live === undefined ? null : this.deps.sessionFile(live.id);
      if (file !== null && file !== entry.sessionFile) this.remember(key, { ...entry, sessionFile: file });
      const status = live === undefined ? "gone" : `${live.status}|${live.statusDetail ?? ""}`;
      if (this.statusKeys.get(key) === status) continue;
      this.statusKeys.set(key, status);
      this.schedule(key);
    }
  }

  private schedule(key: string): void {
    if (this.timers.has(key)) return;
    this.timers.set(
      key,
      this.deps.clock.after(EMIT_MS, () => {
        this.timers.delete(key);
        this.snapshotOf(key).then(
          (item) => {
            if (item !== null) this.deps.emit(item);
          },
          (error: unknown) => {
            this.deps.log(`reviews: item session ${key}: ${errText(error)}`);
          },
        );
      }),
    );
  }

  stop(): void {
    for (const cancel of this.timers.values()) cancel();
    this.timers.clear();
  }
}
