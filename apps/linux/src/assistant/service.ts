// Eva, the personal assistant: one long-lived omp session on the host that Isaac talks to from the
// phone and EvaOS, apart from the Agent Inbox. Its omp transcript is the only store. This service
//   - finds that session among the provider's (the bridge reports it with `kind: "assistant"`,
//     started with `EVA_ASSISTANT=1`), and starts or resumes it on the first turn that needs it;
//   - remembers the session file (assistant.json) so a host or omp restart resumes the same
//     transcript (`omp --resume <file>`) rather than opening a new one;
//   - shapes the transcript into `AssistantSnapshot` frames for the phones following the thread:
//     the earlier contexts (the transcripts in assistant.json's `history`, which the nightly
//     rollover fills) followed by the live session, debounced, on every change of that session;
//   - hides the machinery: job lines, the prime, empty replies and the silence marker;
//   - pushes each settled reply of Eva's to every registered phone not looking at the thread;
//   - takes messages from the host's own jobs (`relay-linux assistant say`) as prefixed turns
//     that Eva then relays to Isaac in her own words.

import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { AgentImage, AgentMessage, AgentSession, AssistantMessage, AssistantSnapshot, ServerMessage } from "@relay/protocol";
import type { LaunchOptions } from "../agents/herdr";
import { parseSessionRows } from "../agents/transcript";
import type { PushSender } from "../push/notifier";
import type { PushTokenSource } from "../push/token-store";
import { AckFailure, type AgentProvider, type AgentProviderChange, type AssistantRelaying } from "../seams";
import type { SessionClock } from "../session";
import { type FillSpawn, runFill, signinHost, splitSignin } from "./signin";
import type { AssistantStore } from "./store";

/** A turn from the host's jobs rather than from Isaac; the thread hides it (and Astra's silent answer to it). */
export const STATUS_PREFIX = "[From Astra's background jobs] ";
const LEGACY_STATUS_PREFIX = "[From Eva's background jobs] ";
const LEGACY_PRIME_START = "You are Eva, Isaac's personal assistant";
/** What Astra answers when a job line needs nothing from Isaac; the host hides the reply. */
export const SILENCE_MARKER = "(nothing to report)";

/** Whether `text` is exactly the silence marker. */
export function isSilent(text: string): boolean {
  return text.trim() === SILENCE_MARKER;
}

/** Where the persona for a brand-new thread is read from, under the agent home. */
export const PRIME_FILE = join(".omp", "assistant", "prime.md");
export const PUSH_TITLE = "Astra";
export const MAX_PUSH_BODY = 180;
/** Streaming updates arrive every ~120 ms; snapshots go out at most this often. */
export const SNAPSHOT_DEBOUNCE_MS = 150;
/** How long a launched Astra has to register (and, for a primed thread, to take the prime) before the turn fails. */
export const REGISTER_TIMEOUT_MS = 30_000;

export interface AssistantServiceDeps {
  readonly agents: AgentProvider;
  /** Starts omp in the agent home with the given options (the bridge provider's `launchWith`). */
  readonly launch: (options: LaunchOptions) => Promise<void>;
  /** The transcript file of a live session, when omp reported one. */
  readonly sessionFile: (sessionId: string) => string | null;
  /** Where Astra runs and where her prime lives; null when the host has no `--agent-home`. */
  readonly agentHome: string | null;
  readonly store: AssistantStore;
  readonly tokens: PushTokenSource & { unregister(deviceId: string): void };
  readonly sender: PushSender;
  /** Sends `message` to every socket following the thread. */
  readonly broadcast: (message: ServerMessage) => void;
  /** Whether `deviceId` is looking at the thread right now; it sees the reply, no push. */
  readonly isViewing: (deviceId: string) => boolean;
  readonly clock: SessionClock;
  readonly log: (line: string) => void;
  /** Starts the browser tool that types credentials into a login page (`spawnFill` in the host). */
  readonly spawn: FillSpawn;
}

/**
 * The thread as the phone shows it: Isaac's turns and Astra's replies. Left out: tool rows, omp's
 * synthetic system rows, the host's job lines (current and legacy prefixes), the persona prime
 * (including the pre-rename Eva prime), a reply with nothing to show (still empty while streaming,
 * or a prime turn that only ran tools) and the silence marker, whole or still streaming in.
 */
export function toAssistantMessages(messages: readonly AgentMessage[], prime: string | null): AssistantMessage[] {
  const out: AssistantMessage[] = [];
  let firstUser = true;
  for (const message of messages) {
    const images = message.images === undefined || message.images.length === 0 ? {} : { images: message.images };
    if (message.role === "user") {
      // Earlier contexts may predate edits of prime.md or Astra's rename.
      const isPrime =
        firstUser &&
        ((prime !== null && (message.text.trim() === prime || message.text.startsWith(prime.split("\n", 1)[0] ?? prime))) ||
          message.text.startsWith(LEGACY_PRIME_START));
      firstUser = false;
      if (isPrime || message.text.startsWith(STATUS_PREFIX) || message.text.startsWith(LEGACY_STATUS_PREFIX)) continue;
      out.push({ id: message.id, role: "user", text: message.text, at: message.at, ...images });
    } else if (message.role === "assistant" && (message.text.length > 0 || "images" in images)) {
      const trimmed = message.text.trim();
      if (trimmed === SILENCE_MARKER || (message.streaming === true && trimmed.length > 0 && SILENCE_MARKER.startsWith(trimmed))) continue;
      const { text, signin } = splitSignin(message.text, message.streaming === true);
      if (text.length === 0 && signin === undefined && !("images" in images)) continue;
      out.push({ id: message.id, role: "assistant", text, at: message.at, ...images, ...(signin === undefined ? {} : { signin }) });
    }
  }
  return out;
}

/** What a launched Astra must report before a turn goes in: just a session, or the prime underway. */
interface Starting {
  readonly primed: boolean;
  readonly resolve: (session: AgentSession) => void;
}

export class AssistantService implements AssistantRelaying {
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

  constructor(private readonly deps: AssistantServiceDeps) {}

  /** The live Astra session. Legacy Eva-titled assistant processes are ignored after the rename. */
  current(): AgentSession | undefined {
    return this.deps.agents.sessions.find((session) => session.kind === "assistant" && session.title === PUSH_TITLE);
  }

  async snapshot(): Promise<AssistantSnapshot> {
    const session = this.current();
    const rev = this.rev;
    const earlier = this.earlier(session === undefined ? null : this.deps.sessionFile(session.id));
    if (session === undefined) return { rev, messages: this.markSubmitted(earlier), busy: false, sessionId: "" };
    const messages = (await this.deps.agents.conversation(session.id)) ?? [];
    return { rev, messages: this.markSubmitted([...earlier, ...toAssistantMessages(messages, this.prime())]), busy: session.status === "working", sessionId: session.id };
  }

  async turn(text: string, images?: readonly AgentImage[]): Promise<void> {
    const session = await this.ensureSession();
    await this.deps.agents.reply(session.id, text, true, images);
  }

  say(text: string): Promise<void> {
    return this.turn(`${STATUS_PREFIX}${text}`);
  }

  /**
   * Types Isaac's credentials into the login page Eva pointed him at (message `messageId`, page
   * `url`) through the browser tool, then marks the message submitted and tells Eva to carry on in
   * her tab. Rejects with `AckFailure`: `invalid_command` for a url that is not http(s) or the
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
      this.deps.log(`assistant: sign-in to ${host} failed: ${error instanceof AckFailure ? error.error.message : "tool did not run"}`);
      throw error;
    }
    this.deps.log(`assistant: credentials submitted for ${host}`);
    this.submitted.add(messageId);
    this.changed();
    this.say(`Credentials submitted for ${host} in your browser tab; continue there.`).catch((error: unknown) => {
      this.deps.log(`assistant: sign-in follow-up not delivered: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  private markSubmitted(messages: AssistantMessage[]): AssistantMessage[] {
    if (this.submitted.size === 0) return messages;
    return messages.map((message) =>
      message.signin !== undefined && this.submitted.has(message.id) ? { ...message, signin: { ...message.signin, submitted: true } } : message,
    );
  }

  observe(change: AgentProviderChange): void {
    if (change.kind === "sessions") {
      const session = this.current();
      // Before the key check: the file can arrive in a later status report that changes nothing else.
      if (session !== undefined) this.remember(session.id);
      const key = session === undefined ? null : `${session.id} ${session.status}`;
      if (key === this.seen) return;
      this.seen = key;
      if (session !== undefined) {
        const waiter = this.waiter;
        if (waiter !== null && (!waiter.primed || session.status === "working")) {
          this.waiter = null;
          waiter.resolve(session);
        }
      }
      this.changed();
      return;
    }
    if (change.kind !== "conversation" && change.kind !== "message") return;
    if (change.sessionId !== this.current()?.id) return;
    this.changed();
    if (change.kind === "conversation") {
      for (const message of change.appended) {
        if (message.role === "assistant" && message.streaming !== true && message.text.length > 0) this.push(message.text);
      }
    } else if (!change.streaming && change.text.length > 0) {
      this.push(change.text);
    }
  }

  private changed(): void {
    this.rev += 1;
    if (this.cancelFlush !== null) return;
    this.cancelFlush = this.deps.clock.after(SNAPSHOT_DEBOUNCE_MS, () => {
      this.cancelFlush = null;
      void this.snapshot().then(
        (snapshot) => {
          this.deps.broadcast({ t: "assistant.snapshot", snapshot });
        },
        (error: unknown) => {
          this.deps.log(`assistant: snapshot failed: ${error instanceof Error ? error.message : String(error)}`);
        },
      );
    });
  }

  /** Writes the session file to assistant.json once it is known and whenever it changes; the history stays as the rollover left it. */
  private remember(sessionId: string): void {
    const file = this.deps.sessionFile(sessionId);
    if (file === null || file === this.persisted) return;
    this.persisted = file;
    this.deps.store.save({ history: this.deps.store.load()?.history ?? [], sessionFile: file });
    this.deps.log(`assistant: thread is ${file}`);
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
    if (cached !== undefined && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.messages;
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
   * Starts Eva: resumes the remembered transcript when its file is still there, else a new session
   * primed from `<agentHome>/.omp/assistant/prime.md`. Resolves once she has registered with the
   * bridge; a primed thread also waits for the prime to be underway (status `working`), so the
   * turn that follows steers in behind it rather than racing the typed prime for the editor.
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
      reject(new AckFailure({ code: "agent_launch_failed", message: "Astra did not come up within 30 s" }));
    });
    this.waiter = { primed: prime !== null, resolve };
    try {
      await this.deps.launch({
        env: { ASTRA_ASSISTANT: "1" },
        ...(resume === null ? {} : { resume }),
        ...(prime === null ? {} : { prompt: prime }),
      });
    } catch (error) {
      cancel();
      this.waiter = null;
      throw error;
    }
    this.deps.log(resume === null ? `assistant: starting a new Eva thread${prime === null ? "" : " with its prime"}` : `assistant: resuming Eva from ${resume}`);
    return promise.finally(cancel);
  }

  /** The persona prompt for a new thread; null when there is none. Read once. */
  private prime(): string | null {
    if (this.primeCache !== undefined) return this.primeCache;
    const home = this.deps.agentHome;
    let text: string | null = null;
    if (home !== null) {
      try {
        text = readFileSync(join(home, PRIME_FILE), "utf8").trim();
      } catch {
        text = null;
      }
    }
    this.primeCache = text === null || text.length === 0 ? null : text;
    return this.primeCache;
  }

  /** A settled reply goes to every phone that is not already looking at it. */
  private push(raw: string): void {
    if (isSilent(raw)) return;
    const { text: shown, signin } = splitSignin(raw, false);
    const text = signin === undefined ? raw : shown.trim().length > 0 ? shown.trim() : `Sign in to ${signin.host}`;
    const recipients: { deviceId: string; token: string }[] = [];
    for (const [deviceId, token] of this.deps.tokens.tokens()) {
      if (this.deps.isViewing(deviceId)) continue;
      recipients.push({ deviceId, token });
    }
    if (recipients.length === 0) return;
    const body = text.length > MAX_PUSH_BODY ? `${text.slice(0, MAX_PUSH_BODY - 1)}…` : text;
    void this.deps.sender.send(recipients.map((recipient) => ({ to: recipient.token, title: PUSH_TITLE, body, data: { assistant: true as const } }))).then(
      (outcomes) => {
        outcomes.forEach((outcome, index) => {
          if (outcome.ok) return;
          const recipient = recipients[index];
          if (recipient === undefined) return;
          this.deps.log(`assistant push to ${recipient.deviceId} failed: ${outcome.error}`);
          if (outcome.unregistered) this.deps.tokens.unregister(recipient.deviceId);
        });
      },
      (error: unknown) => {
        this.deps.log(`assistant push failed: ${error instanceof Error ? error.message : String(error)}`);
      },
    );
  }
}
