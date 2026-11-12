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
//   - hides the machinery: the prime, empty replies and the silence marker; job lines go as `status` rows;
//   - keeps the thread's open asks (`ask-store.ts`): replies rows and omp `ask` cards Isaac has not
//     answered, which every snapshot carries;
//   - pushes each settled reply to every registered phone not looking at the thread;
//   - takes messages from the host's own jobs (`relay-linux assistant say --agent <id>`) as
//     prefixed turns that the agent then relays to Isaac in its own words;
//   - shows another assistant popping into the thread (`relay-guest` rows, `consult.ts`) and a
//     question another assistant put to this one as a quiet row.
// `AssistantThreads` holds one service per registry agent and routes requests by agent id.

import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { foldGuestWork, MAX_ASK_QUESTION, OpenAsk, roomCardFallback, signinHost, splitPins, splitRoomCards, splitSignin, untagged, type AgentImage, type AgentMessage, type AgentSession, type AssistantAgent, type AssistantFileReq, type AssistantFileRes, type AssistantMessage, type AssistantSnapshot, type AssistantStatus, type GuestEntry, type ServerMessage } from "@relay/protocol";
import type { LaunchOptions } from "../agents/herdr";
import { liveSessionId } from "../agents/session-ref";
import { parseSessionRows } from "../agents/transcript";
import type { PushSender } from "../push/notifier";
import { pushPreview } from "../push/preview";
import type { PushTokenSource } from "../push/token-store";
import { AckFailure, type AgentProvider, type AgentProviderChange, type AskInput, type AskStatus, type AssistantRelaying, type AssistantThread, type ConsultRequest, type ConsultResult } from "../seams";
import type { SessionClock } from "../session";
import type { AskJudge } from "./ask-judge";
import { type AskStore, MAX_ASK_FROM, MAX_ASK_REPLIES, MAX_ASK_REPLY } from "./ask-store";
import { type AssistantAgentConfig, RegistryError } from "./registry";
import { CONSULT_TURN, type ConsultDeps, Consults } from "./consult";
import { splitReplies } from "./replies";
import { type FillSpawn, runFill } from "./signin";
import type { AssistantStore } from "./store";
import { splitVoiceTurn, withoutDetailsMarker } from "./voice";

/** A turn from the host's jobs rather than from Isaac, for agent `title`; the thread shows it as a `status` row (and hides the agent's silent answer to it). */
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
/** Most characters of a reply a push shows (its opening sentences, as plain text). */
export const MAX_PUSH_BODY = 180;
/** Characters of a reply kept for the agent list's preview line. */
export const MAX_LAST_REPLY = 140;
/** Streaming updates arrive every ~120 ms; snapshots go out at most this often. */
export const SNAPSHOT_DEBOUNCE_MS = 150;
/** How long a launched agent has to register (and, for a primed thread, to take the prime) before the turn fails. */
export const REGISTER_TIMEOUT_MS = 30_000;
/** Phone turn ids a thread remembers (`AssistantService.turns`), oldest forgotten first. */
const MAX_TURN_IDS = 256;

export interface AssistantServiceDeps {
  /** The registry entry this thread starts with; `configure` takes later versions of it. */
  readonly agent: AssistantAgentConfig;
  readonly agents: AgentProvider;
  /** Starts omp in the agent home with the given options (the bridge provider's `launchWith`). */
  readonly launch: (options: LaunchOptions) => Promise<void>;
  /** The transcript file of a live session, when omp reported one. */
  readonly sessionFile: (sessionId: string) => string | null;
  /** The live session whose transcript is `file`, whichever omp runs it (the bridge's `sessionForFile`); null when none is. */
  readonly holder: (file: string) => AgentSession | null;
  /** Closes the omp running session `sessionId`; resolves once it is gone (the bridge's `close`). */
  readonly close: (sessionId: string) => Promise<void>;
  /** Resolves once omps that outlived a host restart have had time to reconnect (the bridge's `reconnected`). */
  readonly reconnected: () => Promise<void>;
  /** Where the agent runs and where its prime lives; null when the host has no `--agent-home`. */
  readonly agentHome: string | null;
  readonly store: AssistantStore;
  /** The thread's open asks (`assistants/<id>.asks.json`). */
  readonly asks: AskStore;
  /** Reads whether Isaac's later turns already answered an open ask (`claudeAskJudge`); absent, only exact answers, answer tags and the turn count close one. */
  readonly judgeAsk?: AskJudge;
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
  /**
   * Whether omp has an AI account (`hasAiAccount`): false stops a start at once with a sign-in
   * message, since omp without one sits on "No model selected" and never takes the prime.
   */
  readonly aiAccount?: () => Promise<boolean | null>;
  /** The host log a failed start points at, for support. */
  readonly logPath?: string | null;
}

/** "No AI account" as the start fails with it: what failed, what to do, where the log is. */
export function noAccountMessage(title: string, logPath: string | null): string {
  return `${title} can't think yet: no AI account is signed in on this Mac. Open Settings > Setup in Relay and sign in with Claude or ChatGPT (or add an API key), then start ${title} again.${logPath === null ? "" : ` Host log: ${logPath}`}`;
}

/** What a phone without guest rows shows of guest `entry`'s card: what it said, or where its work stands. */
function guestCardText(entry: GuestEntry, content: string): string {
  const work = entry.work;
  if (entry.kind !== "work" || work === undefined) return entry.text ?? content;
  if (work.state === "working") return `Working on ${work.title} in ${entry.agent.title}'s chat`;
  if (work.state === "done") return entry.text ?? `Finished ${work.title}`;
  return `Stopped ${work.title}${entry.text === undefined ? "" : `: ${entry.text}`}`;
}

/**
 * The thread as the phone shows it: Isaac's turns and the agent's replies, and the host's job lines
 * (`prefix` and the legacy prefixes) and questions other assistants put to the agent as `status`
 * rows, which the phone draws as quiet background rows (an older phone hides them). Left out: tool
 * rows, omp's synthetic system rows, the persona prime (including the pre-registry Eva and Astra
 * primes), a reply with nothing to show (still empty
 * while streaming, or a prime turn that only ran tools) and the silence marker, whole or still
 * streaming in. Isaac's turns show without the surface tag the sending client put on them. A turn
 * said on a call shows its words without the voice note, marked `voice`; a reply's details marker
 * becomes a paragraph break, and its answers token becomes the row's `replies`. `asking`, when
 * given, collects the settled rows that end on answers, with their `[[ask-label]]` (the open asks'
 * sources); the label never reaches the row. Guest rows keep their entry: join and leave as
 * `status`, say and work as a `card` titled with the guest's name (work rows unfolded).
 */
export function toAssistantMessages(messages: readonly AgentMessage[], prime: string | null, prefix: string, asking?: Map<string, string | undefined>): AssistantMessage[] {
  const out: AssistantMessage[] = [];
  let firstUser = true;
  for (const message of messages) {
    const images = message.images === undefined || message.images.length === 0 ? {} : { images: message.images };
    if (message.canvas !== undefined) {
      // A live canvas row (Join card, canvas turn, wrap-up): a card, whatever role the transcript gave it.
      out.push({ id: message.id, role: "card", text: message.text, at: message.at, canvas: message.canvas });
      continue;
    }
    const guest = message.guest;
    if (guest !== undefined) {
      if (guest.kind === "join" || guest.kind === "leave") out.push({ id: message.id, role: "status", text: message.text, at: message.at, guest });
      else out.push({ id: message.id, role: "card", title: guest.agent.title, text: guestCardText(guest, message.text), at: message.at, guest });
      continue;
    }
    if (message.role === "user") {
      const said = untagged(message.text);
      // Earlier contexts may predate edits of prime.md or the move to per-agent primes.
      const isPrime =
        firstUser &&
        ((prime !== null && (said.trim() === prime || said.startsWith(prime.split("\n", 1)[0] ?? prime))) ||
          LEGACY_PRIME_STARTS.some((start) => said.startsWith(start)));
      firstUser = false;
      if (isPrime) continue;
      // A job line (heartbeat, job report, handoff) is not Isaac's: a `status` row, which a phone from
      // before background rows never shows and a newer one draws as a quiet row, not his bubble.
      if (said.startsWith(prefix) || LEGACY_STATUS_PREFIXES.some((legacy) => said.startsWith(legacy)) || CONSULT_TURN.test(said)) {
        out.push({ id: message.id, role: "status", text: said, at: message.at });
        continue;
      }
      const { text, voice } = splitVoiceTurn(said);
      out.push({ id: message.id, role: "user", text, at: message.at, ...images, ...(voice ? { voice } : {}) });
    } else if (message.role === "assistant" && (message.text.length > 0 || "images" in images)) {
      const trimmed = message.text.trim();
      if (trimmed === SILENCE_MARKER || (message.streaming === true && trimmed.length > 0 && SILENCE_MARKER.startsWith(trimmed))) continue;
      const streaming = message.streaming === true;
      const answered = splitReplies(splitPins(message.text, streaming).text, streaming);
      const { text, signin } = splitSignin(answered.text, streaming);
      if (text.length === 0 && signin === undefined && !("images" in images)) continue;
      if (asking !== undefined && !streaming && answered.replies !== undefined) asking.set(message.id, answered.label);
      out.push({
        id: message.id,
        role: "assistant",
        text: withoutDetailsMarker(text),
        at: message.at,
        ...images,
        ...(signin === undefined ? {} : { signin }),
        ...(answered.replies === undefined ? {} : { replies: answered.replies }),
      });
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
  /** The registry entry as last read; a registry change swaps it in (`configure`). */
  private agent: AssistantAgentConfig;
  /** This agent's job-line prefix (`statusPrefix(title)`). */
  private prefix: string;
  private rev = 0;
  /** Id and status of the assistant session as last seen, so unrelated session changes stay quiet. */
  private seen: string | null = null;
  private cancelFlush: (() => void) | null = null;
  private starting: Promise<AgentSession> | null = null;
  private waiter: Starting | null = null;
  private persisted: string | null = null;
  /** Set once a stray omp on the remembered transcript set off a resume; cleared when the thread is live again. */
  private strayHandled = false;
  private primeCache: string | null | undefined;
  /** Parsed, filtered earlier transcripts by file, with their asking rows (`toAssistantMessages`); stale once the file's mtime or size moves. */
  private readonly transcripts = new Map<string, { mtimeMs: number; size: number; messages: AssistantMessage[]; asking: Map<string, string | undefined> }>();
  /** Messages whose sign-in the host has filled. Kept in memory only; a host restart forgets it. */
  private readonly submitted = new Set<string>();
  /**
   * Phone turns by `clientId`, newest last (`MAX_TURN_IDS`): the delivery in flight or done. A turn
   * sent again under the same id (a phone that never heard the ack) shares it instead of landing
   * twice; a failed delivery forgets its id, so a retry does deliver.
   */
  private readonly turns = new Map<string, Promise<void>>();
  /** Open asks the judge is reading now, so a snapshot while it thinks does not ask again. */
  private readonly judging = new Set<string>();

  constructor(private readonly deps: AssistantServiceDeps) {
    this.id = deps.agent.id;
    this.agent = deps.agent;
    this.prefix = statusPrefix(deps.agent.title);
  }

  get title(): string {
    return this.agent.title;
  }

  /** The pocket-tts voice calls with this agent speak in; undefined for the host's default. */
  get voice(): string | undefined {
    return this.agent.voice;
  }

  /** The registry's GPT-Live voice for this agent; undefined for the host's default. */
  get liveVoice(): string | undefined {
    return this.agent.liveVoice;
  }

  /** The accent of the agent's portrait (`#rrggbb`), when it has one; its guest rows carry it. */
  get color(): string | undefined {
    const accent = this.agent.portrait?.colors?.accent;
    return accent !== undefined && /^#[0-9a-fA-F]{6}$/.test(accent) ? accent : undefined;
  }

  /**
   * Takes the agent's changed registry entry (same id). The live session keeps running; a new
   * title, profile or model applies from its next start, its listing and calls change at once.
   */
  configure(agent: AssistantAgentConfig): void {
    if (agent.id !== this.id) throw new Error(`assistant ${this.id} cannot take the entry of ${agent.id}`);
    if (JSON.stringify(agent) === JSON.stringify(this.agent)) return;
    this.agent = agent;
    const prefix = statusPrefix(agent.title);
    if (prefix !== this.prefix) {
      this.prefix = prefix;
      this.transcripts.clear();
    }
    this.changed();
  }

  /** Taken out of the registry: closes its live session, if any. Its transcript and store stay. */
  async retire(): Promise<void> {
    const session = this.current();
    if (session === undefined) return;
    this.deps.log(`assistant ${this.id}: retired; closing session ${session.id}`);
    await this.deps.close(session.id);
  }

  /** This agent's live session: the assistant session the bridge reports under this registry id, unless it has ended (a dead omp takes no turns). */
  current(): AgentSession | undefined {
    return this.deps.agents.sessions.find((session) => session.kind === "assistant" && session.assistant === this.id && session.status !== "ended");
  }

  async snapshot(): Promise<AssistantSnapshot> {
    const session = this.current();
    const rev = this.rev;
    const asking = new Map<string, string | undefined>();
    const earlier = this.earlier(session === undefined ? null : this.deps.sessionFile(session.id), asking);
    const live = session === undefined ? [] : toAssistantMessages((await this.deps.agents.conversation(session.id)) ?? [], this.prime(), this.prefix, asking);
    // One work card per piece of work: its latest state, where it started.
    const messages = this.markSubmitted(foldGuestWork([...earlier, ...live]));
    this.deps.asks.observe(messages, asking);
    const busy = session?.status === "working";
    // Judged once the turn settles, so the judge reads the assistant's reply to Isaac's latest turn too.
    if (!busy) this.judgeAsks(messages);
    return { rev, messages, busy, sessionId: session?.id ?? "", asks: this.deps.asks.open() };
  }

  /** The live session's settled rows as the phone shows them, guest rows unfolded; empty while no session is live. */
  async settled(): Promise<AssistantMessage[]> {
    const session = this.current();
    if (session === undefined) return [];
    const live = ((await this.deps.agents.conversation(session.id)) ?? []).filter((message) => message.streaming !== true);
    return toAssistantMessages(live, this.prime(), this.prefix);
  }

  /**
   * Has the judge read the open asks with turns of Isaac's after them it has not read yet; an ask
   * it calls answered closes (`resolveAsk`, which tells every device). A failed judge leaves the
   * ask open and is not retried for the same turns.
   */
  private judgeAsks(messages: readonly AssistantMessage[]): void {
    const judge = this.deps.judgeAsk;
    if (judge === undefined) return;
    for (const ask of this.deps.asks.unjudged(messages)) {
      if (this.judging.has(ask.id)) continue;
      this.judging.add(ask.id);
      judge(ask)
        .then(
          (answered) => {
            this.deps.asks.judged(ask.id, ask.upTo);
            if (!answered) return;
            this.deps.log(`assistant ${this.id}: ask ${ask.id} answered by a later turn (judge)`);
            this.resolveAsk(ask.id, "answered", ask.said.at(-1));
          },
          (error: unknown) => {
            this.deps.asks.judged(ask.id, ask.upTo);
            this.deps.log(`assistant ${this.id}: ask ${ask.id} not judged: ${error instanceof Error ? error.message : String(error)}`);
          },
        )
        .finally(() => this.judging.delete(ask.id));
    }
  }

  /**
   * Closes open ask `id` (Isaac answered or dismissed it, or the assistant resolved it), keeping
   * `answer` when one came; false when it is not open. A session's ask answered with words hands
   * them to the asking session as `[answer to ask <id>] <answer>`; a failed delivery is logged and
   * the answer stays on the ask.
   */
  resolveAsk(id: string, how: "answered" | "dismissed" | "resolved", answer?: string): boolean {
    if (!this.deps.asks.resolve(id, how, answer)) return false;
    this.deps.log(`assistant ${this.id}: ask ${id} ${how}`);
    this.changed();
    const ask = this.deps.asks.get(id);
    const sessionId = ask?.sessionId;
    if (ask?.source !== "session" || how !== "answered" || answer === undefined || sessionId === undefined) return true;
    this.deps.agents.reply(sessionId, `[answer to ask ${id}] ${answer}`, true).then(
      () => {
        this.deps.asks.markDelivered(id);
        this.deps.log(`assistant ${this.id}: answer to ask ${id} delivered to session ${sessionId}`);
      },
      (error: unknown) => {
        this.deps.log(`assistant ${this.id}: answer to ask ${id} not delivered to session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
      },
    );
    return true;
  }

  /**
   * Puts another omp session's question to Isaac through this thread (`relay-linux asks add`) and
   * returns its id. `session` names the asking session (an id or a subagent's, `liveSessionId`).
   * Throws `AckFailure`: `invalid_command` for bad fields, `agent_not_found` for no such live session.
   */
  addAsk(input: AskInput): string {
    const invalid = (message: string): AckFailure => new AckFailure({ code: "invalid_command", message });
    const from = input.from.trim().replace(/\s+/g, " ");
    if (from === "" || from.length > MAX_ASK_FROM) throw invalid(`from must be 1 to ${String(MAX_ASK_FROM)} characters`);
    const question = input.question.trim().replace(/\s+/g, " ");
    if (question === "" || question.length > MAX_ASK_QUESTION) throw invalid(`question must be 1 to ${String(MAX_ASK_QUESTION)} characters`);
    const options = input.options.map((option) => option.trim().replace(/\s+/g, " ")).filter((option) => option !== "");
    if (options.length === 0 || options.length > MAX_ASK_REPLIES) throw invalid(`give 1 to ${String(MAX_ASK_REPLIES)} options`);
    const long = options.find((option) => option.length > MAX_ASK_REPLY);
    if (long !== undefined) throw invalid(`option "${long}" is longer than ${String(MAX_ASK_REPLY)} characters`);
    const wanted = input.default?.trim();
    const fallback = wanted === undefined || wanted === "" ? undefined : options.find((option) => option.toLowerCase() === wanted.toLowerCase());
    if (wanted !== undefined && wanted !== "" && fallback === undefined) throw invalid(`default "${wanted}" is not one of the options`);
    const ref = input.session?.trim();
    const sessionId = ref === undefined || ref === "" ? undefined : (liveSessionId(this.deps.agents.sessions, ref) ?? undefined);
    if (ref !== undefined && ref !== "" && sessionId === undefined) throw new AckFailure({ code: "agent_not_found", message: `no live omp session ${ref} on this host` });
    const ask = this.deps.asks.addSession({ from, question, options, ...(sessionId === undefined ? {} : { sessionId }), ...(fallback === undefined ? {} : { default: fallback }) });
    this.deps.log(`assistant ${this.id}: ask ${ask.id} from ${from}${sessionId === undefined ? "" : ` (session ${sessionId})`}`);
    this.changed();
    return ask.id;
  }

  /** Ask `id` of this thread in whatever state, while it is kept; undefined when it has none. */
  findAsk(id: string): AskStatus | undefined {
    const ask = this.deps.asks.get(id);
    if (ask === undefined) return undefined;
    return {
      ...OpenAsk.parse(ask),
      state: ask.state,
      delivered: ask.delivered === true,
      ...(ask.answer === undefined ? {} : { answer: ask.answer }),
      ...(ask.closedAt === undefined ? {} : { closedAt: ask.closedAt }),
    };
  }

  /**
   * This agent's row in `assistant.agents`. The reply comes from the transcripts the snapshot is
   * built from (earlier contexts, which are cached by mtime, then the live session) minus any
   * reply still streaming in, so the row changes once per settled reply, not once per token.
   */
  async listing(): Promise<AssistantAgent> {
    const session = this.current();
    const earlier = this.earlier(session === undefined ? null : this.deps.sessionFile(session.id));
    const lastReply = lastReplyOf([...earlier, ...(await this.settled())]);
    return {
      id: this.id,
      title: this.title,
      ...(this.agent.scope === undefined ? {} : { scope: this.agent.scope }),
      ...(this.agent.avatar === undefined ? {} : { avatar: this.agent.avatar }),
      ...(this.agent.portrait === undefined ? {} : { portrait: this.agent.portrait }),
      status: assistantStatus(session),
      ...(lastReply === null ? {} : { lastReply }),
    };
  }

  async turn(text: string, images?: readonly AgentImage[], clientId?: string): Promise<void> {
    if (clientId === undefined) return this.deliver(text, images);
    const known = this.turns.get(clientId);
    if (known !== undefined) {
      this.deps.log(`assistant ${this.id}: turn ${clientId} sent again; delivered once`);
      return known;
    }
    const delivery = this.deliver(text, images);
    this.turns.set(clientId, delivery);
    for (const id of this.turns.keys()) {
      if (this.turns.size <= MAX_TURN_IDS) break;
      this.turns.delete(id);
    }
    try {
      await delivery;
    } catch (error) {
      if (this.turns.get(clientId) === delivery) this.turns.delete(clientId);
      throw error;
    }
  }

  private async deliver(text: string, images?: readonly AgentImage[]): Promise<void> {
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
      if (session === undefined) this.resumeOverStray();
      else this.strayHandled = false;
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
    if (change.kind === "ask" || change.kind === "ask.resolved") {
      if (change.sessionId !== this.current()?.id) return false;
      const moved = change.kind === "ask" ? this.deps.asks.addCard(change.sessionId, change.ask) : this.deps.asks.cardResolved(change.sessionId, change.id, change.answered);
      if (moved) this.changed();
      return false;
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
  private earlier(live: string | null, asking?: Map<string, string | undefined>): AssistantMessage[] {
    const record = this.deps.store.load();
    if (record === null) return [];
    const files = record.history.filter((file) => file !== live);
    if (live === null && record.sessionFile !== undefined && !files.includes(record.sessionFile)) files.push(record.sessionFile);
    for (const cached of [...this.transcripts.keys()]) if (!files.includes(cached)) this.transcripts.delete(cached);
    return files.flatMap((file) => {
      const transcript = this.transcript(file);
      if (transcript === null) return [];
      for (const [id, label] of transcript.asking) asking?.set(id, label);
      return transcript.messages;
    });
  }

  private transcript(file: string): { messages: AssistantMessage[]; asking: Map<string, string | undefined> } | null {
    let stat: { mtimeMs: number; size: number };
    try {
      stat = statSync(file);
    } catch {
      return null;
    }
    const cached = this.transcripts.get(file);
    if (cached?.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached;
    let raw: string;
    try {
      raw = readFileSync(file, "utf8");
    } catch {
      return null;
    }
    const stamp = basename(file, ".jsonl");
    let seq = 0;
    const asking = new Map<string, string | undefined>();
    const messages = toAssistantMessages(
      parseSessionRows(raw, null, () => `${stamp}-${++seq}`),
      this.prime(),
      this.prefix,
      asking,
    );
    const entry = { mtimeMs: stat.mtimeMs, size: stat.size, messages, asking };
    this.transcripts.set(file, entry);
    return entry;
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
   * An omp on the remembered transcript that is not this thread leaves the thread looking unstarted
   * while its transcript is in use: herdr restores the pane after its server restarts (a reboot),
   * resuming the transcript without the env the host started it with. The thread is resumed over
   * it (`start` closes it first), once until the thread is live again, so it comes back by itself
   * and the transcript keeps a single omp.
   */
  private resumeOverStray(): void {
    if (this.strayHandled || this.starting !== null || this.deps.agentHome === null) return;
    const file = this.deps.store.load()?.sessionFile;
    if (file === undefined) return;
    const stray = this.deps.holder(file);
    // The thread's own omp on its way out (ended) is not a stray: it was ended on purpose.
    if (stray === null || (stray.kind === "assistant" && stray.assistant === this.id)) return;
    this.strayHandled = true;
    this.ensureSession().catch((error: unknown) => {
      this.deps.log(`assistant ${this.id}: could not resume over the omp on its transcript: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  /**
   * Starts the agent: resumes the remembered transcript when its file is still there, else a new
   * session primed from `<agentHome>/.omp/assistant/agents/<id>/prime.md`. The pane gets
   * `RELAY_ASSISTANT=<id>` and `RELAY_ASSISTANT_TITLE=<title>` and a herdr workspace labelled with
   * the title. Resolves once the session has registered with the bridge; a primed thread also
   * waits for the prime to be underway (status `working`), so the turn that follows steers in
   * behind it rather than racing the typed prime for the editor.
   *
   * A transcript takes one omp at a time. Before a resume the host gives an omp that outlived its
   * own restart time to reconnect (that is the thread, nothing to start), and closes any other omp
   * still on the transcript.
   */
  private async start(): Promise<AgentSession> {
    const home = this.deps.agentHome;
    if (home === null) throw new AckFailure({ code: "agent_launch_failed", message: "host was started without --agent-home" });
    // A named omp profile holds its own sign-ins the check does not read; only the default is checked.
    if (this.agent.profile === undefined && (await this.deps.aiAccount?.()) === false) {
      this.deps.log(`assistant ${this.id}: not starting: omp has no AI account`);
      throw new AckFailure({ code: "agent_launch_failed", message: noAccountMessage(this.title, this.deps.logPath ?? null) });
    }
    const remembered = this.deps.store.load()?.sessionFile ?? null;
    const resume = remembered !== null && existsSync(remembered) ? remembered : null;
    if (resume !== null) {
      await this.deps.reconnected();
      const live = this.current();
      if (live !== undefined) return live;
      const stray = this.deps.holder(resume);
      if (stray !== null) {
        this.deps.log(`assistant ${this.id}: closing session ${stray.id} (${stray.title}), which runs the thread's transcript without being the thread`);
        await this.deps.close(stray.id);
      }
    }
    const prime = resume === null ? this.prime(true) : null;
    const { promise, resolve, reject } = Promise.withResolvers<AgentSession>();
    const cancel = this.deps.clock.after(REGISTER_TIMEOUT_MS, () => {
      const registered = this.current() !== undefined;
      this.waiter = null;
      const log = this.deps.logPath ?? null;
      const what = registered
        ? `omp started but did not take ${this.title}'s first prompt within 30 s (it may be waiting on a sign-in or a model choice)`
        : `omp did not connect to Relay Host within 30 s`;
      this.deps.log(`assistant ${this.id}: start failed: ${what}`);
      reject(new AckFailure({ code: "agent_launch_failed", message: `${what}. Check Settings > Setup in Relay, then start ${this.title} again.${log === null ? "" : ` Host log: ${log}`}` }));
    });
    this.waiter = { primed: prime !== null, resolve };
    try {
      await this.deps.launch({
        env: { RELAY_ASSISTANT: this.id, RELAY_ASSISTANT_TITLE: this.title },
        label: this.title,
        ...(this.agent.profile === undefined ? {} : { profile: this.agent.profile }),
        ...(this.agent.model === undefined ? {} : { model: this.agent.model }),
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

  /**
   * The persona prompt for a new thread; null when there is none. A start reads the file afresh
   * (`fresh`), since the host outlives edits of prime.md; the transcript filter reuses that read.
   */
  private prime(fresh = false): string | null {
    if (!fresh && this.primeCache !== undefined) return this.primeCache;
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
    // A `[[room:<id>]]` card line reads as `Room: <title>` when it is all the reply says.
    const roomed = splitRoomCards(splitReplies(splitPins(untagged(reply)).text, false).text);
    const raw = roomed.text.trim() === "" && roomed.rooms[0] !== undefined ? roomCardFallback(roomed.rooms[0]) : roomed.text;
    const { text: shown, signin } = splitSignin(raw, false);
    const text = signin === undefined ? withoutDetailsMarker(raw) : shown.trim().length > 0 ? withoutDetailsMarker(shown.trim()) : `Sign in to ${signin.host}`;
    const recipients: { deviceId: string; token: string }[] = [];
    for (const [deviceId, token] of this.deps.tokens.tokens(this.id)) {
      if (this.deps.isViewing(deviceId)) continue;
      recipients.push({ deviceId, token });
    }
    if (recipients.length === 0) return;
    const body = pushPreview(text, MAX_PUSH_BODY);
    // Titled with the assistant's name and stacked per assistant, like a conversation in Messages; the
    // phone's Notification Service Extension (mutableContent) puts the assistant's portrait on it.
    const message = { title: this.title, body, data: { assistant: true as const, agent: this.id }, threadId: `assistant:${this.id}`, mutableContent: true };
    void this.deps.sender.send(recipients.map((recipient) => ({ ...message, to: recipient.token }))).then(
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
  /** Builds the thread of an agent a registry change added; without it `reload` only reconfigures and drops. */
  readonly create?: (agent: AssistantAgentConfig) => AssistantService;
  /** Adds an agent to the registry (`AssistantRegistry.create`); without it `create` nacks. */
  readonly register?: (input: unknown) => { readonly id: string; readonly title: string };
  /** Reads or saves an agent's prime.md or thread memory (`handleAssistantFile`); without it `assistant.file.req` answers that the host has no agent home. */
  readonly file?: (req: Pick<AssistantFileReq, "agent" | "file" | "op" | "text" | "expectedHash" | "force">) => Omit<AssistantFileRes, "t" | "rid">;
  /** What `consult` needs: posting a guest row into a session's chat (the bridge's `guest`) and the human's name; without it `consult` nacks. */
  readonly guests?: Pick<ConsultDeps, "post" | "human">;
}

/**
 * Every registry agent's thread, in registry order; the first answers requests that name no agent.
 * With `deps`, it also keeps the phones' agent list live: when an agent's status moves or a reply
 * settles it sends a fresh `assistant.agents` frame, debounced like snapshots and skipped when the
 * list came out the same as the last one sent. `reload` follows registry changes without a restart.
 */
export class AssistantThreads implements AssistantRelaying {
  private cancelFlush: (() => void) | null = null;
  /** The last list broadcast, serialized; null before the first and after a request (which makes the next change always go out). */
  private lastSent: string | null = null;
  private flushes = 0;
  private current: readonly AssistantService[];
  /** One assistant bringing another into its chat (`consult.ts`); null without `deps.post`. */
  private readonly consults: Consults | null;

  constructor(
    threads: readonly AssistantService[],
    private readonly deps?: AssistantThreadsDeps,
  ) {
    this.current = threads;
    const guests = deps?.guests;
    this.consults = deps === undefined || guests === undefined ? null : new Consults({ threads: () => this.current, ...guests, clock: deps.clock, log: deps.log });
  }

  get threads(): readonly AssistantService[] {
    return this.current;
  }

  thread(id: string | undefined): AssistantService | undefined {
    return id === undefined ? this.current[0] : this.current.find((thread) => thread.id === id);
  }

  /** One listing per thread; a thread whose transcript cannot be read still appears, with its registry entry alone. */
  async agents(): Promise<AssistantAgent[]> {
    this.lastSent = null;
    return this.list();
  }

  file(req: Pick<AssistantFileReq, "agent" | "file" | "op" | "text" | "expectedHash" | "force">): Omit<AssistantFileRes, "t" | "rid"> {
    return this.deps?.file?.(req) ?? { ok: false, code: "invalid", error: "This host has no agent home." };
  }

  observe(change: AgentProviderChange): void {
    let listed = false;
    for (const thread of this.current) listed = thread.observe(change) || listed;
    if (listed) this.scheduleBroadcast();
    this.consults?.observe(change);
  }

  /** `relay-linux assistant consult`: assistant `request.from` brings `request.agent` into its chat (`Consults.consult`). Rejects with `AckFailure`. */
  consult(request: ConsultRequest): Promise<ConsultResult> {
    if (this.consults === null) return Promise.reject(new AckFailure({ code: "invalid_command", message: "this host cannot bring assistants into each other's chats" }));
    return this.consults.consult(request);
  }

  /**
   * Takes the registry as it now reads: kept agents get their new entry, new ones a thread, and
   * agents no longer listed are retired (their live session closed). Every phone gets the new list.
   */
  reload(agents: readonly AssistantAgentConfig[]): void {
    const known = new Map(this.current.map((thread) => [thread.id, thread]));
    const next: AssistantService[] = [];
    for (const agent of agents) {
      const thread = known.get(agent.id);
      if (thread !== undefined) {
        thread.configure(agent);
        next.push(thread);
      } else if (this.deps?.create !== undefined) {
        next.push(this.deps.create(agent));
      }
    }
    for (const thread of this.current) {
      if (next.includes(thread)) continue;
      thread.retire().catch((error: unknown) => {
        this.deps?.log(`assistant ${thread.id}: could not close the retired thread: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
    this.current = next;
    this.deps?.log(`assistant threads: ${next.map((thread) => `${thread.title} (${thread.id})`).join(", ")}`);
    this.lastSent = null;
    this.scheduleBroadcast();
  }

  /**
   * Adds an assistant (`assistant.create`): the registry write reloads the threads, so the new one
   * is listed when this resolves. With `start`, its thread starts with "Hi <title>", which kicks off
   * the setup interview its prime holds. Rejects with `AckFailure` (`invalid_command`) for a taken
   * or invalid name.
   */
  create(input: unknown, start: boolean): Promise<{ readonly id: string; readonly title: string }> {
    const register = this.deps?.register;
    if (register === undefined) return Promise.reject(new AckFailure({ code: "invalid_command", message: "this host cannot add assistants" }));
    let added: { readonly id: string; readonly title: string };
    try {
      added = register(input);
    } catch (error) {
      if (error instanceof RegistryError) return Promise.reject(new AckFailure({ code: "invalid_command", message: error.message }));
      return Promise.reject(new AckFailure({ code: "internal", message: error instanceof Error ? error.message : String(error) }));
    }
    if (start) {
      this.thread(added.id)
        ?.turn(`Hi ${added.title}`)
        .catch((error: unknown) => {
          this.deps?.log(`assistant ${added.id}: first turn failed: ${error instanceof Error ? error.message : String(error)}`);
        });
    }
    return Promise.resolve(added);
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
