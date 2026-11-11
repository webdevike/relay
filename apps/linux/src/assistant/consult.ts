// Consult: one assistant (A) pulls another (B) into Isaac's chat with A
// (`relay-linux assistant consult --agent <B> [--work] <question>`, run from A's session, which
// `$RELAY_ASSISTANT` names). The host writes `relay-guest` rows into A's chat through its
// relay-bridge and puts the question to B as a turn in B's own thread:
//   1. B joins A's chat (a quiet line);
//   2. B gets `[Asked by <A> in Isaac's chat] <question>` (its thread shows a quiet background row);
//   3. quick: B's turn settles within QUICK_MS. Its reply goes into A's chat as B's bubble, B
//      leaves, and the CLI prints the reply so A can wrap up;
//   4. work: B is still at it after QUICK_MS (or was busy before the question came, or A said
//      `--work`). B's first words, if any, go in as its bubble, B leaves, and a work card goes in
//      (`working`). The CLI returns at once. The host keeps watching B and, once B's turn
//      settles, posts the card again as `done` with the first line of B's reply (`failed` when
//      B's session ends first). Those rows wait until A's session is idle, so they append at once
//      instead of waiting for A's next turn.
// A work card still `working` in A's live session after a host restart is picked up again (the
// session file is the only store): B's reply after the card's start finishes it.
// B's reply is "its newest settled reply after the question went in": a turn has no id, so words
// Isaac exchanged with B meanwhile can be taken for the answer; a busy B goes straight to a card.

import { randomBytes } from "node:crypto";
import { foldGuestWork, untagged, type AgentSession, type AssistantMessage, type GuestAgent, type GuestEntry } from "@relay/protocol";
import { firstLine } from "../agents/transcript";
import { AckFailure, type AgentProviderChange, type ConsultRequest, type ConsultResult } from "../seams";
import type { SessionClock } from "../session";

/** How long B has to settle its answer before the question becomes a work card. */
export const QUICK_MS = 30_000;
/** Longest question A can put to B. */
export const MAX_QUESTION = 8_000;
/** Longest work card title. */
export const MAX_WORK_TITLE = 80;

/** The turn B gets for a question A put to it in `human`'s chat with A (`title` is A's). */
export function consultPrefix(title: string, human: string): string {
  return `[Asked by ${title} in ${human}'s chat] `;
}
/** Matches a turn that `consultPrefix` started; B's thread shows it as a quiet background row. */
export const CONSULT_TURN = /^\[Asked by .+? in .+?'s chat\] /;

/** What the consult needs of an assistant thread (`AssistantService`). */
export interface ConsultThread {
  readonly id: string;
  readonly title: string;
  /** The agent's accent (`#rrggbb`), when its portrait has one. */
  readonly color: string | undefined;
  current(): AgentSession | undefined;
  /** Delivers `text` as the thread's next turn, starting or resuming the agent first. */
  turn(text: string): Promise<void>;
  /** The live session's settled rows as the phone shows them (guest rows included); empty while it is not running. */
  settled(): Promise<AssistantMessage[]>;
}

export interface ConsultDeps {
  /** The assistant threads as the registry now reads. */
  readonly threads: () => readonly ConsultThread[];
  /** Posts a guest row into session `sessionId`'s chat (the bridge's `guest`); false from a bridge that predates guests. */
  readonly post: (sessionId: string, content: string, details: GuestEntry) => Promise<boolean>;
  readonly clock: SessionClock;
  readonly log: (line: string) => void;
  /** The human's display name (`human()`), for the question's prefix. */
  readonly human: () => string;
  /** A new work id; random by default. */
  readonly newId?: () => string;
}

interface Job {
  readonly id: string;
  readonly from: string;
  readonly agent: GuestAgent;
  readonly title: string;
  readonly startedAt: number;
  phase: "quick" | "work";
  /** Settles the waiting `consult` call while the job is quick. */
  answer: ((result: ConsultResult) => void) | null;
  /** Cancels the quick timer. */
  cancel: (() => void) | null;
  /** The rows that put the card in A's chat; a finished card waits for them. */
  posted: Promise<void>;
  /** B's session was live while the job ran: its going away now means it ended. */
  seen: boolean;
  checking: boolean;
  again: boolean;
}

/** A finished card waiting for A's session to be idle. */
interface Outgoing {
  readonly from: string;
  readonly content: string;
  readonly details: GuestEntry;
}

const invalid = (message: string): AckFailure => new AckFailure({ code: "invalid_command", message });
const errorText = (error: unknown): string => (error instanceof AckFailure ? error.error.message : error instanceof Error ? error.message : String(error));

export class Consults {
  private readonly jobs = new Map<string, Job>();
  private readonly outbox: Outgoing[] = [];
  private flushing = false;
  /** A's sessions already searched for work cards a restart left `working`. */
  private readonly recovered = new Set<string>();

  constructor(private readonly deps: ConsultDeps) {}

  /**
   * Puts `request.question` to B for A (see the file comment). Resolves with B's reply when B
   * settles within QUICK_MS, else once the work card is in A's chat. Rejects with `AckFailure`:
   * `invalid_command` for bad fields or an unknown assistant, `agent_not_found` when A has no live
   * session, `agent_cannot_respond` when A's bridge predates guest rows, or B's start failure.
   */
  async consult(request: ConsultRequest): Promise<ConsultResult> {
    const threads = this.deps.threads();
    const a = threads.find((thread) => thread.id === request.from);
    const b = threads.find((thread) => thread.id === request.agent);
    if (a === undefined) throw invalid(`unknown assistant ${request.from}`);
    if (b === undefined) throw invalid(`unknown assistant ${request.agent}; try one of ${threads.map((thread) => thread.id).join(", ")}`);
    if (a.id === b.id) throw invalid(`${a.title} cannot consult itself`);
    const question = request.question.trim();
    if (question === "" || question.length > MAX_QUESTION) throw invalid(`question must be 1 to ${String(MAX_QUESTION)} characters`);
    const session = a.current();
    if (session === undefined) throw new AckFailure({ code: "agent_not_found", message: `${a.title} has no live session to bring ${b.title} into` });
    const agent: GuestAgent = { id: b.id, title: b.title, ...(b.color === undefined ? {} : { color: b.color }) };
    const joined = await this.deps.post(session.id, `${b.title} joined the chat`, { kind: "join", agent });
    if (!joined) throw new AckFailure({ code: "agent_cannot_respond", message: `${a.title}'s relay-bridge extension predates guests; restart ${a.title}'s omp session to update it` });
    const busy = b.current()?.status === "working";
    const startedAt = this.deps.clock.now();
    try {
      await b.turn(`${consultPrefix(a.title, this.deps.human())}${question}`);
    } catch (error) {
      await this.post(a.id, `${b.title} left the chat`, { kind: "leave", agent });
      throw error;
    }
    const titled = (request.title ?? "").trim() || firstLine(question);
    const title = titled.length > MAX_WORK_TITLE ? `${titled.slice(0, MAX_WORK_TITLE - 1).trimEnd()}…` : titled;
    const job: Job = { id: this.deps.newId?.() ?? randomBytes(6).toString("hex"), from: a.id, agent, title, startedAt, phase: "quick", answer: null, cancel: null, posted: Promise.resolve(), seen: false, checking: false, again: false };
    this.jobs.set(job.id, job);
    this.deps.log(`assistant ${a.id}: consulting ${b.id}${busy ? " (busy)" : ""}${request.work === true ? " (work)" : ""}: ${title}`);
    if (request.work === true || busy) return this.toWork(job, null);
    const { promise, resolve } = Promise.withResolvers<ConsultResult>();
    job.answer = resolve;
    job.cancel = this.deps.clock.after(QUICK_MS, () => {
      void this.timeout(job);
    });
    void this.check(job);
    return promise;
  }

  /** Every provider change: B settling finishes its question, A going idle lets finished cards in, a new A session is searched once. */
  observe(change: AgentProviderChange): void {
    if (change.kind !== "sessions" && change.kind !== "conversation") return;
    for (const job of this.jobs.values()) void this.check(job);
    if (change.kind !== "sessions") return;
    this.flush();
    this.recover();
  }

  /** Whether a question to B is still open (quick or work); for tests and logs. */
  get open(): number {
    return this.jobs.size;
  }

  /** Posts into A's live chat; false when A has no live session or its bridge refused. */
  private async post(from: string, content: string, details: GuestEntry): Promise<boolean> {
    const session = this.deps.threads().find((thread) => thread.id === from)?.current();
    if (session === undefined) return false;
    return this.deps.post(session.id, content, details);
  }

  /** The quick wait ran out with B still at it: its first words, if any, then the card. */
  private async timeout(job: Job): Promise<void> {
    if (job.phase !== "quick" || !this.jobs.has(job.id)) return;
    job.phase = "work";
    const b = this.deps.threads().find((thread) => thread.id === job.agent.id);
    const said = b === undefined ? [] : await this.repliesSince(b, job.startedAt);
    const ack = said.at(-1) ?? null;
    job.answer?.(await this.toWork(job, ack));
    job.answer = null;
  }

  /** Turns `job` into a work card: B's `ack` as its bubble, B leaves, the card goes in `working`. */
  private async toWork(job: Job, ack: string | null): Promise<ConsultResult> {
    job.phase = "work";
    job.cancel?.();
    job.cancel = null;
    const { agent } = job;
    job.posted = (async () => {
      if (ack !== null) await this.post(job.from, `${agent.title}: ${firstLine(ack)}`, { kind: "say", agent, text: ack });
      await this.post(job.from, `${agent.title} left the chat`, { kind: "leave", agent });
      await this.post(job.from, `${agent.title} is working on ${job.title} in their own chat`, { kind: "work", agent, work: this.work(job, "working") });
    })().catch((error: unknown) => {
      this.deps.log(`assistant ${job.from}: work card ${job.id} not posted: ${errorText(error)}`);
    });
    await job.posted;
    void this.check(job);
    return { kind: "work", id: job.id, title: job.title };
  }

  private work(job: Job, state: "working" | "done" | "failed"): NonNullable<GuestEntry["work"]> {
    return { id: job.id, title: job.title, state, startedAt: job.startedAt, ...(state === "working" ? {} : { endedAt: this.deps.clock.now() }), link: `agent:${job.agent.id}` };
  }

  /** B's settled replies since `since`, as text without surface tags. */
  private async repliesSince(b: ConsultThread, since: number): Promise<string[]> {
    const rows = await b.settled();
    return rows.filter((row) => row.role === "assistant" && row.at >= since).map((row) => untagged(row.text).trim()).filter((text) => text !== "");
  }

  /** Runs `step` for `job`, once at a time; a change while it runs runs it again after. */
  private async check(job: Job): Promise<void> {
    if (job.checking) {
      job.again = true;
      return;
    }
    job.checking = true;
    try {
      do {
        job.again = false;
        await this.step(job);
      } while (job.again && this.jobs.has(job.id));
    } catch (error) {
      this.deps.log(`assistant ${job.from}: consult ${job.id} check failed: ${errorText(error)}`);
    } finally {
      job.checking = false;
    }
  }

  /** Where B stands: settled with a reply after the question finishes the job (as the answer, or the card's result). */
  private async step(job: Job): Promise<void> {
    if (!this.jobs.has(job.id)) return;
    const b = this.deps.threads().find((thread) => thread.id === job.agent.id);
    const session = b?.current();
    if (b === undefined || session === undefined) {
      if (job.phase === "work" && job.seen) await this.finish(job, "failed", `${job.agent.title}'s session ended`);
      return;
    }
    job.seen = true;
    if (session.status !== "idle") return;
    const reply = (await this.repliesSince(b, job.startedAt)).at(-1);
    if (reply === undefined || !this.jobs.has(job.id) || b.current()?.status !== "idle") return;
    if (job.phase === "work") {
      await this.finish(job, "done", firstLine(reply));
      return;
    }
    this.jobs.delete(job.id);
    job.cancel?.();
    const { agent } = job;
    await this.post(job.from, `${agent.title}: ${firstLine(reply)}`, { kind: "say", agent, text: reply });
    await this.post(job.from, `${agent.title} left the chat`, { kind: "leave", agent });
    this.deps.log(`assistant ${job.from}: ${agent.id} answered ${job.id}`);
    job.answer?.({ kind: "answer", text: reply });
    job.answer = null;
  }

  /** The card's last state goes out once A is idle (`flush`). */
  private async finish(job: Job, state: "done" | "failed", text: string): Promise<void> {
    this.jobs.delete(job.id);
    await job.posted;
    const { agent } = job;
    const content = state === "done" ? `${agent.title} finished ${job.title}: ${text}` : `${agent.title} stopped working on ${job.title}: ${text}`;
    this.outbox.push({ from: job.from, content, details: { kind: "work", agent, text, work: this.work(job, state) } });
    this.deps.log(`assistant ${job.from}: work ${job.id} by ${agent.id} ${state}`);
    this.flush();
  }

  /** Posts the finished cards whose A is idle now; the rest wait for A's next status change. */
  private flush(): void {
    if (this.flushing || this.outbox.length === 0) return;
    this.flushing = true;
    void (async () => {
      try {
        for (const item of [...this.outbox]) {
          const session = this.deps.threads().find((thread) => thread.id === item.from)?.current();
          if (session === undefined || session.status === "working") continue;
          try {
            if (!(await this.deps.post(session.id, item.content, item.details))) this.deps.log(`assistant ${item.from}: work card ${item.details.work?.id ?? ""} refused by an old bridge`);
          } catch (error) {
            this.deps.log(`assistant ${item.from}: work card ${item.details.work?.id ?? ""} not posted yet: ${errorText(error)}`);
            continue;
          }
          this.outbox.splice(this.outbox.indexOf(item), 1);
        }
      } finally {
        this.flushing = false;
      }
    })();
  }

  /**
   * Picks up the work cards a host restart left `working`: each assistant's live session is read
   * once; a card no job watches gets one again, so B's reply after the card's start finishes it.
   */
  private recover(): void {
    for (const thread of this.deps.threads()) {
      const session = thread.current();
      if (session === undefined || this.recovered.has(session.id)) continue;
      this.recovered.add(session.id);
      void thread.settled().then(
        (rows) => {
          for (const row of foldGuestWork(rows)) {
            const guest = row.guest;
            const work = guest?.work;
            if (guest?.kind !== "work" || work?.state !== "working" || this.jobs.has(work.id) || this.outbox.some((item) => item.details.work?.id === work.id)) continue;
            const job: Job = { id: work.id, from: thread.id, agent: guest.agent, title: work.title, startedAt: work.startedAt, phase: "work", answer: null, cancel: null, posted: Promise.resolve(), seen: false, checking: false, again: false };
            this.jobs.set(job.id, job);
            this.deps.log(`assistant ${thread.id}: watching ${guest.agent.id} again for work ${work.id}`);
            void this.check(job);
          }
        },
        (error: unknown) => {
          this.recovered.delete(session.id);
          this.deps.log(`assistant ${thread.id}: could not read its work cards: ${errorText(error)}`);
        },
      );
    }
  }
}
