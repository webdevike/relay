// Eva, the personal assistant: one long-lived omp session on the host that Isaac talks to from the
// phone and EvaOS, apart from the Agent Inbox. Its omp transcript is the only store. This service
//   - finds that session among the provider's (the bridge reports it with `kind: "assistant"`,
//     started with `EVA_ASSISTANT=1`), and starts or resumes it on the first turn that needs it;
//   - remembers the session file (assistant.json) so a host or omp restart resumes the same
//     transcript (`omp --resume <file>`) rather than opening a new one;
//   - shapes the transcript into `AssistantSnapshot` frames for the phones following the thread,
//     debounced, on every change of that one session;
//   - pushes each settled reply of Eva's to every registered phone not looking at the thread;
//   - takes messages from the host's own jobs (`relay-linux assistant say`) as prefixed turns
//     that Eva then relays to Isaac in her own words.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentImage, AgentMessage, AgentSession, AssistantMessage, AssistantSnapshot, ServerMessage } from "@relay/protocol";
import type { LaunchOptions } from "../agents/herdr";
import type { PushSender } from "../push/notifier";
import type { PushTokenSource } from "../push/token-store";
import { AckFailure, type AgentProvider, type AgentProviderChange, type AssistantRelaying } from "../seams";
import type { SessionClock } from "../session";
import type { AssistantStore } from "./store";

/** A turn from the host's jobs rather than from Isaac; the phone shows the rest as a status row. */
export const STATUS_PREFIX = "[From Eva's background jobs] ";
/** Where the persona for a brand-new thread is read from, under the agent home. */
export const PRIME_FILE = join(".omp", "assistant", "prime.md");
export const PUSH_TITLE = "Eva";
export const MAX_PUSH_BODY = 180;
/** Streaming updates arrive every ~120 ms; snapshots go out at most this often. */
export const SNAPSHOT_DEBOUNCE_MS = 150;
/** How long a launched Eva has to register (and, for a primed thread, to take the prime) before the turn fails. */
export const REGISTER_TIMEOUT_MS = 30_000;

export interface AssistantServiceDeps {
  readonly agents: AgentProvider;
  /** Starts omp in the agent home with the given options (the bridge provider's `launchWith`). */
  readonly launch: (options: LaunchOptions) => Promise<void>;
  /** The transcript file of a live session, when omp reported one. */
  readonly sessionFile: (sessionId: string) => string | null;
  /** Where Eva runs and where her prime lives; null when the host has no `--agent-home`. */
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
}

/**
 * The thread as the phone shows it: Isaac's turns, Eva's replies, and the host's job messages as
 * status rows (prefix stripped). Tool rows and omp's synthetic system rows are left out, as is a
 * reply still empty while streaming and the persona prime (the first user turn, when it is one).
 */
export function toAssistantMessages(messages: readonly AgentMessage[], prime: string | null): AssistantMessage[] {
  const out: AssistantMessage[] = [];
  let firstUser = true;
  for (const message of messages) {
    const images = message.images === undefined || message.images.length === 0 ? {} : { images: message.images };
    if (message.role === "user") {
      const isPrime = firstUser && prime !== null && message.text.trim() === prime;
      firstUser = false;
      if (isPrime) continue;
      if (message.text.startsWith(STATUS_PREFIX)) {
        out.push({ id: message.id, role: "status", text: message.text.slice(STATUS_PREFIX.length), at: message.at });
      } else {
        out.push({ id: message.id, role: "user", text: message.text, at: message.at, ...images });
      }
    } else if (message.role === "assistant" && (message.text.length > 0 || "images" in images)) {
      out.push({ id: message.id, role: "assistant", text: message.text, at: message.at, ...images });
    }
  }
  return out;
}

/** What a launched Eva must report before a turn goes in: just a session, or the prime underway. */
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

  constructor(private readonly deps: AssistantServiceDeps) {}

  /** The live assistant session, if omp has one registered. */
  current(): AgentSession | undefined {
    return this.deps.agents.sessions.find((session) => session.kind === "assistant");
  }

  async snapshot(): Promise<AssistantSnapshot> {
    const session = this.current();
    const rev = this.rev;
    if (session === undefined) return { rev, messages: [], busy: false, sessionId: "" };
    const messages = (await this.deps.agents.conversation(session.id)) ?? [];
    return { rev, messages: toAssistantMessages(messages, this.prime()), busy: session.status === "working", sessionId: session.id };
  }

  async turn(text: string, images?: readonly AgentImage[]): Promise<void> {
    const session = await this.ensureSession();
    await this.deps.agents.reply(session.id, text, true, images);
  }

  say(text: string): Promise<void> {
    return this.turn(`${STATUS_PREFIX}${text}`);
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

  /** Writes the session file to assistant.json once it is known and whenever it changes. */
  private remember(sessionId: string): void {
    const file = this.deps.sessionFile(sessionId);
    if (file === null || file === this.persisted) return;
    this.persisted = file;
    this.deps.store.save({ sessionFile: file });
    this.deps.log(`assistant: thread is ${file}`);
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
      reject(new AckFailure({ code: "agent_launch_failed", message: "Eva did not come up within 30 s" }));
    });
    this.waiter = { primed: prime !== null, resolve };
    try {
      await this.deps.launch({
        env: { EVA_ASSISTANT: "1" },
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
  private push(text: string): void {
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
