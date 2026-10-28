// The host's assistant threads: one long-lived omp session per registry agent (`registry.ts`, e.g.
// Astra for eCard Systems work, Nova for personal) that Isaac talks to from the phone and EvaOS,
// apart from the Agent Inbox. Each thread's omp transcript is its only store. An `AssistantService`
//   - finds its agent's session among the provider's (the bridge reports it with `kind: "assistant"`
//     and `assistant: <id>`, started with `RELAY_ASSISTANT=<id>`), and starts or resumes it on the
//     first turn that needs it;
//   - remembers the session file (`assistants/<id>.json`) so a host or omp restart resumes the same
//     transcript (`omp --resume <file>`) rather than opening a new one;
//   - shapes the transcript into `assistant.snapshot` frames for the phones following the thread:
//     the earlier contexts (the transcripts in the store's `history`, which the nightly rollover
//     fills) followed by the live session, debounced, on every change of that session;
//   - hides the machinery: job lines, the prime, empty replies and the silence marker;
//   - pushes each settled reply to every registered phone not looking at the thread;
//   - takes messages from the host's own jobs (`relay-linux assistant say --agent <id>`) as
//     prefixed turns that the agent then relays to Isaac in its own words.
// `AssistantThreads` holds one service per registry agent and routes requests by agent id.

import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { untagged, type AgentImage, type AgentMessage, type AgentSession, type AssistantAgent, type AssistantMessage, type AssistantSnapshot, type AssistantStatus, type ServerMessage } from "@relay/protocol";
import type { LaunchOptions } from "../agents/herdr";
import { parseSessionRows } from "../agents/transcript";
import type { PushSender } from "../push/notifier";
import type { PushTokenSource } from "../push/token-store";
import { AckFailure, type AgentProvider, type AgentProviderChange, type AssistantRelaying, type AssistantThread } from "../seams";
import type { SessionClock } from "../session";
import type { AssistantAgentConfig } from "./registry";
import { type FillSpawn, runFill, signinHost, splitSignin } from "./signin";
import type { AssistantStore } from "./store";
import { splitVoiceTurn, withoutDetailsMarker } from "./voice";

/** A turn from the host's jobs rather than from Isaac, for agent `title`; the thread hides it (and the agent's silent answer to it). */
export function statusPrefix(title: string): string {
  return `[From ${title}'s background jobs] `;
}
/** Job-line prefixes and prime openings from before the multi-agent registry; recognized only to hide rows of old transcripts. */
const LEGACY_STATUS_PREFIXES = ["[From Astra's background jobs] ", "[From Eva's background jobs] "];
const LEGACY_PRIME_STARTS = ["You are Eva, Isaac's personal assistant", "You are Astra, Isaac's personal assistant"];
/** What an agent answers when a job line needs nothing from Isaac; the host hides the reply. */
export const SILENCE_MARKER = "(nothing to report)";

/** Whether `text` is exactly the silence marker. */
export function isSilent(text: string): boolean {
  return text.trim() === SILENCE_MARKER;
}

/** Where the persona for a brand-new thread of agent `id` is read from, under the agent home. */
export function primeFile(id: string): string {
  return join(".omp", "assistant", "agents", id, "prime.md");
}
export const MAX_PUSH_BODY = 180;
/** Characters of a reply kept for the agent list's preview line. */
export const MAX_LAST_REPLY = 140;
/** Streaming updates arrive every ~120 ms; snapshots go out at most this often. */
export const SNAPSHOT_DEBOUNCE_MS = 150;
/** How long a launched agent has to register (and, for a primed thread, to take the prime) before the turn fails. */
export const REGISTER_TIMEOUT_MS = 30_000;

export interface AssistantServiceDeps {
  /** The registry entry this thread runs. */
  readonly agent: AssistantAgentConfig;
  readonly agents: AgentProvider;
  /** Starts omp in the agent home with the given options (the bridge provider's `launchWith`). */
  readonly launch: (options: LaunchOptions) => Promise<void>;
  /** The transcript file of a live session, when omp reported one. */
  readonly sessionFile: (sessionId: string) => string | null;
  /** Where the agent runs and where its prime lives; null when the host has no `--agent-home`. */
  readonly agentHome: string | null;
  readonly store: AssistantStore;
  readonly tokens: PushTokenSource & { unregister(deviceId: string): void };
  readonly sender: PushSender;
  /** Sends `message` to every socket following this thread. */
  readonly broadcast: (message: ServerMessage) => void;
  /** Whether `deviceId` is looking at this thread right now; it sees the reply, no push. */
  readonly isViewing: (deviceId: string) => boolean;
  readonly clock: SessionClock;
  readonly log: (line: string) => void;
  /** Starts the browser tool that types credentials into a login page (`spawnFill` in the host). */
  readonly spawn: FillSpawn;
}

/**
 * The thread as the phone shows it: Isaac's turns and the agent's replies. Left out: tool rows,
 * omp's synthetic system rows, the host's job lines (`prefix` and the legacy prefixes), the persona
 * prime (including the pre-registry Eva and Astra primes), a reply with nothing to show (still empty
 * while streaming, or a prime turn that only ran tools) and the silence marker, whole or still
 * streaming in. Isaac's turns show without the surface tag the sending client put on them. A turn
 * said on a call shows its words without the voice note, marked `voice`; a reply's details marker
 * becomes a paragraph break.
 */
export function toAssistantMessages(messages: readonly AgentMessage[], prime: string | null, prefix: string): AssistantMessage[] {
  const out: AssistantMessage[] = [];
  let firstUser = true;
  for (const message of messages) {
    const images = message.images === undefined || message.images.length === 0 ? {} : { images: message.images };
    if (message.role === "user") {
      const said = untagged(message.text);
      // Earlier contexts may predate edits of prime.md or the move to per-agent primes.
      const isPrime =
        firstUser &&
        ((prime !== null && (said.trim() === prime || said.startsWith(prime.split("\n", 1)[0] ?? prime))) ||
          LEGACY_PRIME_STARTS.some((start) => said.startsWith(start)));
      firstUser = false;
      if (isPrime || said.startsWith(prefix) || LEGACY_STATUS_PREFIXES.some((legacy) => said.startsWith(legacy))) continue;
      const { text, voice } = splitVoiceTurn(said);
      out.push({ id: message.id, role: "user", text, at: message.at, ...images, ...(voice ? { voice } : {}) });
    } else if (message.role === "assistant" && (message.text.length > 0 || "images" in images)) {
      const trimmed = message.text.trim();
      if (trimmed === SILENCE_MARKER || (message.streaming === true && trimmed.length > 0 && SILENCE_MARKER.startsWith(trimmed))) continue;
      const { text, signin } = splitSignin(message.text, message.streaming === true);
      if (text.length === 0 && signin === undefined && !("images" in images)) continue;
      out.push({ id: message.id, role: "assistant", text: withoutDetailsMarker(text), at: message.at, ...images, ...(signin === undefined ? {} : { signin }) });
    }
  }
  return out;
}

/** Where an agent's thread stands from its live session: no session is "not_started" (never launched, or the bridge lists none). */
export function assistantStatus(session: AgentSession | undefined): AssistantStatus {
  if (session === undefined) return "not_started";
  switch (session.status) {
    case "working":
      return "working";
    case "waiting":
    case "needs_permission":
      return "needs_you";
    case "idle":
    case "ended":
      return "idle";
  }
}

/**
 * The newest reply worth previewing in `messages` (already the phone's view of the thread, so job
 * lines, the prime, empty rows and the silence marker are gone): the text of the last assistant
 * row without a surface tag, clipped to `MAX_LAST_REPLY`, or `Sign in to <host>` for a sign-in request with no words.
 * A row with only pictures has no text and is passed over. Null when the agent never said anything.
 */
export function lastReplyOf(messages: readonly AssistantMessage[]): { text: string; at: number } | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "assistant") continue;
    const said = untagged(message.text).trim();
    const text = said === "" && message.signin !== undefined ? `Sign in to ${message.signin.host}` : said;
    if (text === "") continue;
    const head = text.slice(0, MAX_LAST_REPLY - 1);
    const clipped = text.length <= MAX_LAST_REPLY ? text : `${/[\uD800-\uDBFF]$/.test(head) ? head.slice(0, -1) : head.trimEnd()}…`;
    return { text: clipped, at: message.at };
  }
  return null;
}

/** What a launched agent must report before a turn goes in: just a session, or the prime underway. */
interface Starting {
  readonly primed: boolean;
  readonly resolve: (session: AgentSession) => void;
}

export class AssistantService implements AssistantThread {
  readonly id: string;
  readonly title: string;
  /** The pocket-tts voice calls with this agent speak in; undefined for the host's default. */
  readonly voice: string | undefined;
  /** This agent's job-line prefix (`statusPrefix(title)`). */
  private readonly prefix: string;
  private rev = 0;
  /** Id and status of the assistant session as last seen, so unrelated session changes stay quiet. */
  private seen: string | null = null;
  private cancelFlush: (() => void) | null = null;
  private starting: Promise<AgentSession> | null = null;
  private waiter: Starting | null = null;
  private persisted: string | null = null;
  private primeCache: string | null | undefined;
  /** Parsed, filtered earlier transcripts by file; stale once the file's mtime or size moves. */
  private readonly transcripts = new Map<string, { mtimeMs: number; size: number; messages: AssistantMessage[] }>();
  /** Messages whose sign-in the host has filled. Kept in memory only; a host restart forgets it. */
  private readonly submitted = new Set<string>();

  constructor(private readonly deps: AssistantServiceDeps) {
    this.id = deps.agent.id;
    this.title = deps.agent.title;
    this.voice = deps.agent.voice;
    this.prefix = statusPrefix(deps.agent.title);
  }

  /** This agent's live session: the assistant session the bridge reports under this registry id, unless it has ended (a dead omp takes no turns). */
  current(): AgentSession | undefined {
    return this.deps.agents.sessions.find((session) => session.kind === "assistant" && session.assistant === this.id && session.status !== "ended");
  }

  async snapshot(): Promise<AssistantSnapshot> {
    const session = this.current();
    const rev = this.rev;
    const earlier = this.earlier(session === undefined ? null : this.deps.sessionFile(session.id));
    if (session === undefined) return { rev, messages: this.markSubmitted(earlier), busy: false, sessionId: "" };
    const messages = (await this.deps.agents.conversation(session.id)) ?? [];
    return { rev, messages: this.markSubmitted([...earlier, ...toAssistantMessages(messages, this.prime(), this.prefix)]), busy: session.status === "working", sessionId: session.id };
  }

  /**
   * This agent's row in `assistant.agents`. The reply comes from the transcripts the snapshot is
   * built from (earlier contexts, which are cached by mtime, then the live session) minus any
   * reply still streaming in, so the row changes once per settled reply, not once per token.
   */
  async listing(): Promise<AssistantAgent> {
    const session = this.current();
    const earlier = this.earlier(session === undefined ? null : this.deps.sessionFile(session.id));
    const live = session === undefined ? [] : ((await this.deps.agents.conversation(session.id)) ?? []).filter((message) => message.streaming !== true);
    const lastReply = lastReplyOf([...earlier, ...toAssistantMessages(live, this.prime(), this.prefix)]);
    return {
      id: this.id,
      title: this.title,
      ...(this.deps.agent.scope === undefined ? {} : { scope: this.deps.agent.scope }),
      ...(this.deps.agent.avatar === undefined ? {} : { avatar: this.deps.agent.avatar }),
      ...(this.deps.agent.portrait === undefined ? {} : { portrait: this.deps.agent.portrait }),
      status: assistantStatus(session),
      ...(lastReply === null ? {} : { lastReply }),
    };
  }

  async turn(text: string, images?: readonly AgentImage[]): Promise<void> {
    const session = await this.ensureSession();
    this.deps.log(`assistant ${this.id}: turn to session ${session.id} (${session.status})`);
    await this.deps.agents.reply(session.id, text, true, images);
  }

  say(text: string): Promise<void> {
    return this.turn(`${this.prefix}${text}`);
  }

  /**
   * Types Isaac's credentials into the login page the agent pointed him at (message `messageId`,
   * page `url`) through the browser tool, then marks the message submitted and tells the agent to
   * carry on in its tab. Rejects with `AckFailure`: `invalid_command` for a url that is not http(s) or the
   * tool's own error, `internal` when the tool cannot start. The credentials go to the tool's
   * stdin only; they are never logged.
   */
  async signin(messageId: string, url: string, username: string, password: string): Promise<void> {
    const home = this.deps.agentHome;
    if (home === null) throw new AckFailure({ code: "agent_launch_failed", message: "host was started without --agent-home" });
    const host = signinHost(url);
    if (host === null) throw new AckFailure({ code: "invalid_command", message: "sign-in url must be http(s)" });
    try {
      await runFill(this.deps.spawn, home, url, { username, password });
    } catch (error) {
      this.deps.log(`assistant ${this.id}: sign-in to ${host} failed: ${error instanceof AckFailure ? error.error.message : "tool did not run"}`);
      throw error;
    }
    this.deps.log(`assistant ${this.id}: credentials submitted for ${host}`);
    this.submitted.add(messageId);
    this.changed();
    this.say(`Credentials submitted for ${host} in your browser tab; continue there.`).catch((error: unknown) => {
      this.deps.log(`assistant ${this.id}: sign-in follow-up not delivered: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  private markSubmitted(messages: AssistantMessage[]): AssistantMessage[] {
    if (this.submitted.size === 0) return messages;
    return messages.map((message) =>
      message.signin !== undefined && this.submitted.has(message.id) ? { ...message, signin: { ...message.signin, submitted: true } } : message,
    );
  }

  /** Takes a provider change; true when this agent's `assistant.agents` row may have changed (its status moved or a reply settled). */
  observe(change: AgentProviderChange): boolean {
    if (change.kind === "sessions") {
      const session = this.current();
      // Before the key check: the file can arrive in a later status report that changes nothing else.
      if (session !== undefined) this.remember(session.id);
      const key = session === undefined ? null : `${session.id} ${session.status}`;
      if (key === this.seen) return false;
      this.seen = key;
      if (session !== undefined) {
        const waiter = this.waiter;
        if (waiter !== null && (!waiter.primed || session.status === "working")) {
          this.waiter = null;
          waiter.resolve(session);
        }
      }
      this.changed();
      return true;
    }
    if (change.kind !== "conversation" && change.kind !== "message") return false;
    if (change.sessionId !== this.current()?.id) return false;
    this.changed();
    if (change.kind === "conversation") {
      let settled = false;
      for (const message of change.appended) {
        if (message.role !== "assistant" || message.streaming === true) continue;
        settled = true;
        if (message.text.length > 0) this.push(message.text);
      }
      return settled;
    }
    if (change.streaming) return false;
    if (change.text.length > 0) this.push(change.text);
    return true;
  }

  private changed(): void {
    this.rev += 1;
    if (this.cancelFlush !== null) return;
    this.cancelFlush = this.deps.clock.after(SNAPSHOT_DEBOUNCE_MS, () => {
      this.cancelFlush = null;
      void this.snapshot().then(
        (snapshot) => {
          this.deps.broadcast({ t: "assistant.snapshot", agent: this.id, snapshot });
        },
        (error: unknown) => {
          this.deps.log(`assistant ${this.id}: snapshot failed: ${error instanceof Error ? error.message : String(error)}`);
        },
      );
    });
  }

  /** Writes the session file to the store once it is known and whenever it changes; the history stays as the rollover left it. */
  private remember(sessionId: string): void {
    const file = this.deps.sessionFile(sessionId);
    if (file === null || file === this.persisted) return;
    this.persisted = file;
    this.deps.store.save({ history: this.deps.store.load()?.history ?? [], sessionFile: file });
    this.deps.log(`assistant ${this.id}: thread is ${file}`);
  }

  /**
   * The thread before the live session, as the phone shows it: every earlier context's transcript
   * in `history` order, and, while no session is live, the one a restart will resume. Each file is
   * read once and again only when it changes. Text only: the host holds no bytes to serve the
   * images of a finished context.
   */
  private earlier(live: string | null): AssistantMessage[] {
    const record = this.deps.store.load();
    if (record === null) return [];
    const files = record.history.filter((file) => file !== live);
    if (live === null && record.sessionFile !== undefined && !files.includes(record.sessionFile)) files.push(record.sessionFile);
    for (const cached of [...this.transcripts.keys()]) if (!files.includes(cached)) this.transcripts.delete(cached);
    return files.flatMap((file) => this.transcript(file));
  }

  private transcript(file: string): AssistantMessage[] {
    let stat: { mtimeMs: number; size: number };
    try {
      stat = statSync(file);
    } catch {
      return [];
    }
    const cached = this.transcripts.get(file);
    if (cached?.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.messages;
    let raw: string;
    try {
      raw = readFileSync(file, "utf8");
    } catch {
      return [];
    }
    const stamp = basename(file, ".jsonl");
    let seq = 0;
    const messages = toAssistantMessages(
      parseSessionRows(raw, null, () => `${stamp}-${++seq}`),
      this.prime(),
      this.prefix,
    );
    this.transcripts.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, messages });
    return messages;
  }

  private ensureSession(): Promise<AgentSession> {
    const live = this.current();
    if (live !== undefined) return Promise.resolve(live);
    this.starting ??= this.start().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  /**
   * Starts the agent: resumes the remembered transcript when its file is still there, else a new
   * session primed from `<agentHome>/.omp/assistant/agents/<id>/prime.md`. The pane gets
   * `RELAY_ASSISTANT=<id>` and `RELAY_ASSISTANT_TITLE=<title>` and a herdr workspace labelled with
   * the title. Resolves once the session has registered with the bridge; a primed thread also
   * waits for the prime to be underway (status `working`), so the turn that follows steers in
   * behind it rather than racing the typed prime for the editor.
   */
  private async start(): Promise<AgentSession> {
    const home = this.deps.agentHome;
    if (home === null) throw new AckFailure({ code: "agent_launch_failed", message: "host was started without --agent-home" });
    const remembered = this.deps.store.load()?.sessionFile ?? null;
    const resume = remembered !== null && existsSync(remembered) ? remembered : null;
    const prime = resume === null ? this.prime() : null;
    const { promise, resolve, reject } = Promise.withResolvers<AgentSession>();
    const cancel = this.deps.clock.after(REGISTER_TIMEOUT_MS, () => {
      this.waiter = null;
      reject(new AckFailure({ code: "agent_launch_failed", message: `${this.title} did not come up within 30 s` }));
    });
    this.waiter = { primed: prime !== null, resolve };
    try {
      await this.deps.launch({
        env: { RELAY_ASSISTANT: this.id, RELAY_ASSISTANT_TITLE: this.title },
        label: this.title,
        ...(this.deps.agent.profile === undefined ? {} : { profile: this.deps.agent.profile }),
        ...(this.deps.agent.model === undefined ? {} : { model: this.deps.agent.model }),
        ...(resume === null ? {} : { resume }),
        ...(prime === null ? {} : { prompt: prime }),
      });
    } catch (error) {
      cancel();
      this.waiter = null;
      throw error;
    }
    this.deps.log(resume === null ? `assistant ${this.id}: starting a new thread${prime === null ? "" : " with its prime"}` : `assistant ${this.id}: resuming from ${resume}`);
    return promise.finally(cancel);
  }

  /** The persona prompt for a new thread; null when there is none. Read once. */
  private prime(): string | null {
    if (this.primeCache !== undefined) return this.primeCache;
    const home = this.deps.agentHome;
    let text: string | null = null;
    if (home !== null) {
      try {
        text = readFileSync(join(home, primeFile(this.id)), "utf8").trim();
      } catch {
        text = null;
      }
    }
    this.primeCache = text === null || text.length === 0 ? null : text;
    return this.primeCache;
  }

  /** A settled reply goes to every phone that is not already looking at it. */
  private push(reply: string): void {
    if (isSilent(reply)) return;
    // A push is display: no client's surface tag, even one an agent echoed back.
    const raw = untagged(reply);
    const { text: shown, signin } = splitSignin(raw, false);
    const text = signin === undefined ? raw : shown.trim().length > 0 ? shown.trim() : `Sign in to ${signin.host}`;
    const recipients: { deviceId: string; token: string }[] = [];
    for (const [deviceId, token] of this.deps.tokens.tokens()) {
      if (this.deps.isViewing(deviceId)) continue;
      recipients.push({ deviceId, token });
    }
    if (recipients.length === 0) return;
    const body = text.length > MAX_PUSH_BODY ? `${text.slice(0, MAX_PUSH_BODY - 1)}…` : text;
    void this.deps.sender.send(recipients.map((recipient) => ({ to: recipient.token, title: this.title, body, data: { assistant: true as const, agent: this.id } }))).then(
      (outcomes) => {
        outcomes.forEach((outcome, index) => {
          if (outcome.ok) return;
          const recipient = recipients[index];
          if (recipient === undefined) return;
          this.deps.log(`assistant ${this.id} push to ${recipient.deviceId} failed: ${outcome.error}`);
          if (outcome.unregistered) this.deps.tokens.unregister(recipient.deviceId);
        });
      },
      (error: unknown) => {
        this.deps.log(`assistant ${this.id} push failed: ${error instanceof Error ? error.message : String(error)}`);
      },
    );
  }
}

export interface AssistantThreadsDeps {
  /** Sends the refreshed `assistant.agents` frame to every connected phone. */
  readonly broadcast: (message: ServerMessage) => void;
  readonly clock: SessionClock;
  readonly log: (line: string) => void;
}

/**
 * Every registry agent's thread, in registry order; the first answers requests that name no agent.
 * With `deps`, it also keeps the phones' agent list live: when an agent's status moves or a reply
 * settles it sends a fresh `assistant.agents` frame, debounced like snapshots and skipped when the
 * list came out the same as the last one sent.
 */
export class AssistantThreads implements AssistantRelaying {
  private cancelFlush: (() => void) | null = null;
  /** The last list broadcast, serialized; null before the first and after a request (which makes the next change always go out). */
  private lastSent: string | null = null;
  private flushes = 0;

  constructor(
    readonly threads: readonly AssistantService[],
    private readonly deps?: AssistantThreadsDeps,
  ) {}

  thread(id: string | undefined): AssistantService | undefined {
    return id === undefined ? this.threads[0] : this.threads.find((thread) => thread.id === id);
  }

  /** One listing per thread; a thread whose transcript cannot be read still appears, with its registry entry alone. */
  async agents(): Promise<AssistantAgent[]> {
    this.lastSent = null;
    return this.list();
  }

  observe(change: AgentProviderChange): void {
    let listed = false;
    for (const thread of this.threads) listed = thread.observe(change) || listed;
    if (listed) this.scheduleBroadcast();
  }

  private list(): Promise<AssistantAgent[]> {
    return Promise.all(
      this.threads.map((thread) =>
        thread.listing().catch((error: unknown): AssistantAgent => {
          this.deps?.log(`assistant ${thread.id}: listing failed: ${error instanceof Error ? error.message : String(error)}`);
          return { id: thread.id, title: thread.title };
        }),
      ),
    );
  }

  private scheduleBroadcast(): void {
    const deps = this.deps;
    if (deps === undefined || this.cancelFlush !== null) return;
    this.cancelFlush = deps.clock.after(SNAPSHOT_DEBOUNCE_MS, () => {
      this.cancelFlush = null;
      const flush = (this.flushes += 1);
      void this.list().then((agents) => {
        // A later flush owns the newer list.
        if (flush !== this.flushes) return;
        const key = JSON.stringify(agents);
        if (key === this.lastSent) return;
        this.lastSent = key;
        deps.broadcast({ t: "assistant.agents", agents });
      });
    });
  }
}
