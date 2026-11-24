// "Call me when it's done": Isaac asks an assistant to ring him when some work settles, and the
// assistant registers that with `relay-host call-me add` (only on his request; nothing here calls on
// its own). Each request runs `callRequest.machine.ts`; this runtime provides its effects:
//   - the pending state is one work card in the assistant's thread (a `relay-guest` row with
//     `work.id` `call:<id>`, updated in place as it waits, rings, connects, is missed or cancelled);
//   - ringing is a Time Sensitive push "<assistant> is calling" whose tap opens the phone straight
//     into a call that sends `call.start` with `request: <id>`, which `answer` turns into the call's
//     greeting and brief;
//   - no answer within `ringMs` is one missed-call push plus the result on the thread card.
// Requests are kept in `call-requests.json` beside the host's other state, so a restart keeps waiting.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentSession, GuestEntry } from "@relay/protocol";
import { createActor, fromCallback, fromPromise, waitFor, type Actor } from "xstate";
import { z } from "zod";
import type { PushMessage, PushSender } from "../push/notifier";
import type { PushTokenSource } from "../push/token-store";
import type { SessionClock } from "../session";
import { callRequestMachine, type CallRequestTiming, type WorkOutcome } from "./callRequest.machine";
import { clip, readRun, runOutcome, runningRuns, sessionOutcome, WorkTarget } from "./work";

export interface CallMeTiming extends CallRequestTiming {
  /** How often a run's record is read while its request waits. */
  readonly pollMs: number;
}

export const DEFAULT_CALL_ME_TIMING: CallMeTiming = {
  ringMs: 90_000,
  maxWaitMs: 24 * 60 * 60_000,
  pollMs: 5_000,
};

/** Longest `about` an assistant may give: it is read aloud in the greeting. */
export const MAX_ABOUT = 160;
/** Ended requests kept in the file for `call-me list`. */
const KEEP_ENDED = 30;

/** What a request is, as the file keeps it and `call-me list` shows it. */
export const CallRequestRecord = z.object({
  id: z.string(),
  agent: z.string(),
  about: z.string(),
  target: WorkTarget,
  createdAt: z.number(),
  state: z.string(),
  outcome: z.object({ status: z.enum(["done", "failed"]), result: z.string() }).optional(),
  reason: z.string().optional(),
  endedAt: z.number().optional(),
});
export type CallRequestRecord = z.infer<typeof CallRequestRecord>;

/** What a call to Isaac about a request opens with: the spoken greeting and a brief for the voice. */
export interface CallOpener {
  readonly greeting: string;
  readonly brief: string;
}

/** The assistant thread a request belongs to. */
export interface CallMeThread {
  readonly id: string;
  readonly title: string;
  readonly color?: string;
  /** The assistant's live omp session id, while it runs. */
  sessionId(): string | undefined;
  /** Hands `text` to the assistant as a background line (when no card can go in). */
  say(text: string): Promise<void>;
}

export interface CallMeDeps {
  readonly thread: (agent: string) => CallMeThread | undefined;
  /** Every omp session the host lists now. */
  readonly sessions: () => readonly AgentSession[];
  /** Posts a `relay-guest` row into session `sessionId`'s chat; false when its bridge cannot. */
  readonly card: (sessionId: string, content: string, entry: GuestEntry) => Promise<boolean>;
  /** Pushes `message` to every paired phone (Isaac asked for this call: an assistant's mute does not apply). */
  readonly push: (message: Omit<PushMessage, "to">) => void;
  /** Where agent-session runs keep their records; null when the host has no agent home. */
  readonly runs: string | null;
  /** The person the assistants work for ("Isaac"). */
  readonly human: string;
  /** The requests file; null keeps them in memory only. */
  readonly path: string | null;
  readonly timing: CallMeTiming;
  readonly clock: SessionClock;
  readonly log: (line: string) => void;
}

/** What `add` takes: from the CLI through `POST /assistant/call-me`. */
export const CallMeAdd = z.object({
  agent: z.string().min(1),
  about: z.string(),
  /** `run:<id or title words>`, `session:<id or title words>`, `turn` or `manual`; absent picks (see `resolve`). */
  on: z.string().optional(),
  /** The omp session that ran the command (an assistant's own session, or a helper of it). */
  session: z.string().optional(),
});
export type CallMeAdd = z.infer<typeof CallMeAdd>;

/** A request the caller got wrong; the HTTP route answers it 400 with the message. */
export class CallMeError extends Error {}

type RequestActor = Actor<typeof callRequestMachine>;

/** "the waterfall options" -> "The waterfall options". */
function capital(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The greeting and the voice's brief for a call about `record`'s work. */
export function openerOf(record: Pick<CallRequestRecord, "about" | "outcome">, human: string): CallOpener {
  const done = record.outcome?.status !== "failed";
  const greeting = done
    ? `Hey ${human}, the thing you asked for is done: ${record.about}. Want any follow-ups?`
    : `Hey ${human}, the thing you asked for didn't finish: ${record.about}. Want me to look into it?`;
  const written = record.outcome?.result.trim() ?? "";
  const result = written === "" ? "nothing was written back" : written;
  const brief = [
    `Why this call: you called ${human}; he had asked you to call him once this was done: ${record.about}.`,
    `It ${done ? "finished" : "did not finish"}. What came back: ${result}`,
    "Your greeting already told him that. Answer his follow-ups from this, and delegate anything you do not know.",
  ].join(" ");
  return { greeting, brief };
}

function targetLabel(target: WorkTarget): string {
  if (target.kind === "manual") return "settled by hand";
  return `${target.kind === "run" ? "run" : "session"} "${target.title}"`;
}

export class CallMeService {
  private readonly records = new Map<string, CallRequestRecord>();
  private readonly actors = new Map<string, RequestActor>();
  /** Re-checks of session targets, run on every session list change. */
  private readonly sessionWatchers = new Set<() => void>();
  /** Requests whose card is in the thread (so an early cancel has nothing to update). */
  private readonly announced = new Set<string>();

  constructor(private readonly deps: CallMeDeps) {
    for (const record of this.load()) this.records.set(record.id, record);
  }

  /** Restarts the requests that were still open when the host stopped; call once the sessions have reconnected. Resolves once each watches its work again. */
  async resume(): Promise<void> {
    const restarted: RequestActor[] = [];
    for (const record of this.records.values()) {
      if (record.endedAt !== undefined || this.actors.has(record.id)) continue;
      this.deps.log(`call-me ${record.id}: resuming (${record.state})`);
      restarted.push(this.run(record));
    }
    await Promise.all(restarted.map((actor) => waitFor(actor, (snapshot) => !snapshot.matches("requested"), { timeout: Infinity })));
  }

  /** Registers a request; resolves once its work was found. Throws `CallMeError` for a request that names nothing. */
  async add(input: CallMeAdd): Promise<CallRequestRecord> {
    const thread = this.deps.thread(input.agent);
    if (thread === undefined) throw new CallMeError(`no assistant named ${input.agent} on this host`);
    const about = input.about.trim().replace(/\s+/g, " ");
    if (about === "" || about.length > MAX_ABOUT) throw new CallMeError(`--about must be 1 to ${String(MAX_ABOUT)} characters`);
    const target = this.resolve(thread, input.on?.trim(), input.session?.trim());
    const record: CallRequestRecord = {
      id: `call-${randomUUID().slice(0, 8)}`,
      agent: thread.id,
      about,
      target,
      createdAt: this.deps.clock.now(),
      state: "requested",
    };
    this.records.set(record.id, record);
    const actor = this.run(record);
    const settled = await waitFor(actor, (snapshot) => !snapshot.matches("requested"), { timeout: Infinity });
    if (settled.matches("rejected")) {
      this.records.delete(record.id);
      this.save();
      throw new CallMeError(settled.context.reason ?? "the work was not found");
    }
    this.deps.log(`call-me ${record.id}: ${thread.title} will call about "${about}" (${targetLabel(target)})`);
    return this.view(record.id);
  }

  /** Cancels request `id`, or every open request of `agent`; the ids it cancelled. */
  cancel(agent: string | undefined, id: string | undefined, reason = "cancelled"): string[] {
    const ids = id !== undefined ? [id] : [...this.actors.keys()].filter((key) => agent === undefined || this.records.get(key)?.agent === agent);
    const cancelled: string[] = [];
    for (const key of ids) {
      const actor = this.actors.get(key);
      if (!actor?.getSnapshot().can({ type: "request.cancel" })) continue;
      actor.send({ type: "request.cancel", reason });
      cancelled.push(key);
    }
    return cancelled;
  }

  /** Settles request `id` by hand (`call-me settle`): its work finished or failed with `result`. */
  settle(id: string, outcome: WorkOutcome): boolean {
    const actor = this.actors.get(id);
    if (!actor?.getSnapshot().matches("waiting")) return false;
    actor.send({ type: "work.settled", outcome: { status: outcome.status, result: clip(outcome.result) } });
    return true;
  }

  /**
   * The phone answered the ring of request `id` with a call to `agent` (`call.start` + `request`):
   * the opener of that call, or null when the request is not ringing (then it is an ordinary call).
   */
  answer(id: string, agent: string): CallOpener | null {
    const actor = this.actors.get(id);
    const record = this.records.get(id);
    if (record?.agent !== agent || !actor?.getSnapshot().matches("ringing")) return null;
    actor.send({ type: "call.answered" });
    this.deps.log(`call-me ${id}: answered`);
    return openerOf(this.view(id), this.deps.human);
  }

  /** Requests, newest first: open ones of `agent` (every agent when undefined), with `all` the ended ones too. */
  list(agent: string | undefined, all: boolean): CallRequestRecord[] {
    return [...this.records.keys()]
      .map((id) => this.view(id))
      .filter((record) => (agent === undefined || record.agent === agent) && (all || record.endedAt === undefined))
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  /** The host's session list changed: session targets look again. */
  observeSessions(): void {
    for (const check of [...this.sessionWatchers]) check();
  }

  stop(): void {
    for (const actor of this.actors.values()) actor.stop();
    this.actors.clear();
  }

  private view(id: string): CallRequestRecord {
    const record = this.records.get(id);
    if (record === undefined) throw new Error(`no call request ${id}`);
    const snapshot = this.actors.get(id)?.getSnapshot();
    if (snapshot === undefined) return record;
    const { outcome, reason } = snapshot.context;
    return {
      ...record,
      state: snapshot.value,
      ...(outcome === null ? {} : { outcome }),
      ...(reason === null ? {} : { reason }),
    };
  }

  /**
   * The work `on` names. Absent: the caller's one running agent-session run; with none, the caller's
   * own turn (its session, else the assistant's), so "call me when this is done" needs no question.
   */
  private resolve(thread: CallMeThread, on: string | undefined, session: string | undefined): WorkTarget {
    const own = (): WorkTarget => {
      // A caller the host does not list (an id it cannot match) would read as finished at once: use the assistant's own session.
      const id = (session === undefined || session === "" ? undefined : this.sessionRef(session)?.id) ?? thread.sessionId();
      if (id === undefined) throw new CallMeError(`${thread.title} has no live session to watch`);
      const title = this.deps.sessions().find((candidate) => candidate.id === id)?.title ?? `${thread.title}'s turn`;
      return { kind: "session", id, title };
    };
    if (on === undefined || on === "") {
      const running = this.deps.runs === null ? [] : runningRuns(this.deps.runs, thread.id);
      const only = running[0];
      if (running.length === 1 && only !== undefined) return { kind: "run", id: only.id, title: only.title };
      if (running.length > 1)
        throw new CallMeError(
          `${String(running.length)} runs of ${thread.title} are going; name one with --on run:<id>: ${running.map((run) => `${run.id} "${run.title}"`).join(", ")}`,
        );
      return own();
    }
    if (on === "turn") return own();
    if (on === "manual") return { kind: "manual" };
    if (on.startsWith("run:")) {
      const ref = on.slice("run:".length).trim();
      const run = this.runRef(thread.id, ref);
      if (run === null) throw new CallMeError(`no agent-session run ${ref}`);
      return { kind: "run", id: run.id, title: run.title };
    }
    if (on.startsWith("session:")) {
      const ref = on.slice("session:".length).trim();
      const found = this.sessionRef(ref);
      if (found === undefined) throw new CallMeError(`no session ${ref} on this host`);
      return { kind: "session", id: found.id, title: found.title };
    }
    throw new CallMeError(`--on takes run:<id>, session:<id>, turn or manual, not "${on}"`);
  }

  /** A run by id, else the one running run of `owner` whose id or title holds `ref`. */
  private runRef(owner: string, ref: string): { id: string; title: string } | null {
    const dir = this.deps.runs;
    if (dir === null || ref === "") return null;
    const exact = readRun(dir, ref);
    if (exact !== null) return exact;
    const words = ref.toLowerCase();
    const matches = runningRuns(dir, owner).filter((run) => run.id.toLowerCase().includes(words) || run.title.toLowerCase().includes(words));
    if (matches.length > 1) throw new CallMeError(`"${ref}" matches ${String(matches.length)} runs: ${matches.map((run) => run.id).join(", ")}`);
    return matches[0] ?? null;
  }

  /** A live session by id, id prefix or title words. */
  private sessionRef(ref: string): AgentSession | undefined {
    const sessions = this.deps.sessions().filter((session) => session.status !== "ended");
    const words = ref.toLowerCase();
    return (
      sessions.find((session) => session.id === ref) ??
      sessions.find((session) => session.id.startsWith(ref)) ??
      sessions.find((session) => session.title.toLowerCase().includes(words))
    );
  }

  private run(record: CallRequestRecord): RequestActor {
    const { deps } = this;
    const machine = callRequestMachine.provide({
      actors: {
        attach: fromPromise(() => {
          const { target } = record;
          return target.kind === "run" && (deps.runs === null || readRun(deps.runs, target.id) === null)
            ? Promise.reject(new Error(`no agent-session run ${target.id}`))
            : Promise.resolve(null);
        }),
        watch: fromCallback(({ sendBack }) => this.watch(record.target, (outcome) => {
          sendBack({ type: "work.settled", outcome });
        })),
      },
      actions: {
        announce: () => {
          this.announced.add(record.id);
          this.card(record.id, "working", `Call you when done: ${record.about}`, undefined, `Waiting to call ${deps.human} once this is done: ${record.about} (${targetLabel(record.target)}). Cancel with: relay-host call-me cancel ${record.id}`);
        },
        ring: ({ context }) => {
          const title = deps.thread(record.agent)?.title ?? record.agent;
          deps.log(`call-me ${record.id}: ${context.outcome?.status ?? "done"}; ringing`);
          deps.push({
            title: `${title} is calling`,
            body: `${capital(record.about)}: ${context.outcome?.status === "failed" ? "didn't finish" : "done"}. Tap to answer.`,
            data: { id: `call:${record.id}`, callRequest: record.id, agent: record.agent, assistant: true },
            interruptionLevel: "time-sensitive",
            // The phone's notification service draws the assistant's portrait (a Communication Notification).
            mutableContent: true,
            threadId: `call:${record.id}`,
          });
          this.card(record.id, "working", `Calling you: ${record.about}`, undefined, `Calling ${deps.human} now about ${record.about}.`);
        },
        markConnected: () => {
          this.card(record.id, "done", `Call: ${record.about}`, `Called you about ${record.about}.`, `${deps.human} picked up the call about ${record.about}.`);
        },
        notifyMissed: ({ context }) => {
          const title = deps.thread(record.agent)?.title ?? record.agent;
          const failed = context.outcome?.status === "failed";
          const result = context.outcome?.result.trim() ?? "";
          // "The CI build: didn't finish. 2 tests failed", as the ring said it.
          const what = `${capital(record.about)}: ${failed ? "didn't finish" : "done"}.${result === "" ? "" : ` ${result}`}`;
          deps.log(`call-me ${record.id}: missed`);
          this.withdraw(record.id);
          deps.push({
            title: `Missed call from ${title}`,
            body: clip(what, 240),
            data: { assistant: true, agent: record.agent },
            mutableContent: true,
            threadId: `call:${record.id}`,
          });
          this.card(record.id, "done", `Call: ${record.about}`, `Missed call. ${what}`, `${deps.human} missed the call about ${record.about}; the thread card shows him the result. Nothing to reply unless he asks.`, true);
        },
        markCancelled: ({ context }) => {
          deps.log(`call-me ${record.id}: cancelled (${context.reason ?? "cancelled"})`);
          if (context.outcome !== null) this.withdraw(record.id);
          if (this.announced.has(record.id))
            this.card(record.id, "failed", `Call: ${record.about}`, `Call cancelled: ${record.about}`, `The call about ${record.about} is cancelled.`);
        },
        markExpired: () => {
          deps.log(`call-me ${record.id}: expired`);
          const hours = Math.round(deps.timing.maxWaitMs / 3_600_000);
          this.card(record.id, "failed", `Call: ${record.about}`, `Stopped waiting to call you: ${record.about} did not finish within ${String(hours)} h.`, `Gave up waiting for ${record.about} after ${String(hours)} h; no call.`, true);
        },
      },
    });
    const actor = createActor(machine, {
      input: { id: record.id, agent: record.agent, about: record.about, timing: deps.timing },
      // xstate's timers on the host's clock; the timer id is the cancel function.
      clock: { setTimeout: (fn: () => void, ms: number) => deps.clock.after(ms, fn), clearTimeout: (cancel: () => void) => { cancel(); } },
    });
    this.actors.set(record.id, actor);
    actor.subscribe((snapshot) => {
      const state = snapshot.value;
      const current = this.records.get(record.id);
      if (current === undefined) return;
      const { outcome, reason } = snapshot.context;
      const next: CallRequestRecord = {
        ...current,
        state,
        ...(outcome === null ? {} : { outcome }),
        ...(reason === null ? {} : { reason }),
        ...(snapshot.status === "done" ? { endedAt: deps.clock.now() } : {}),
      };
      this.records.set(record.id, next);
      if (snapshot.status === "done") {
        this.actors.delete(record.id);
        this.announced.delete(record.id);
      }
      if (state !== "requested") this.save();
    });
    actor.start();
    return actor;
  }

  /** Watches `target` until it settles, then calls `settled` once; returns the cleanup. */
  private watch(target: WorkTarget, settled: (outcome: WorkOutcome) => void): () => void {
    const { deps } = this;
    let done = false;
    let cancel: (() => void) | null = null;
    const finish = (outcome: WorkOutcome | null): void => {
      if (done || outcome === null) return;
      done = true;
      settled(outcome);
    };
    if (target.kind === "manual") return () => undefined;
    if (target.kind === "run") {
      const dir = deps.runs;
      const tick = (): void => {
        cancel = null;
        const run = dir === null ? null : readRun(dir, target.id);
        // A record that went away cannot finish: leave it to maxWait.
        if (run !== null) finish(runOutcome(run));
        if (!done) cancel = deps.clock.after(deps.timing.pollMs, tick);
      };
      cancel = deps.clock.after(0, tick);
      return () => {
        done = true;
        cancel?.();
      };
    }
    let last: AgentSession | undefined;
    const check = (): void => {
      const all = deps.sessions();
      const outcome = sessionOutcome(target.id, all, last);
      last = all.find((session) => session.id === target.id) ?? last;
      finish(outcome);
      if (done) this.sessionWatchers.delete(check);
    };
    this.sessionWatchers.add(check);
    cancel = deps.clock.after(0, check);
    return () => {
      done = true;
      cancel?.();
      this.sessionWatchers.delete(check);
    };
  }

  /**
   * The request's work card in its assistant's thread, in `state` with `title` (and `text` once it
   * ended); `content` is what the assistant reads. With no live session to post into, an `urgent` line
   * (a miss, a give-up) goes to the assistant as a background line instead.
   */
  private card(id: string, state: "working" | "done" | "failed", title: string, text: string | undefined, content: string, urgent = false): void {
    const record = this.records.get(id);
    const thread = record === undefined ? undefined : this.deps.thread(record.agent);
    if (record === undefined || thread === undefined) return;
    const entry: GuestEntry = {
      kind: "work",
      agent: { id: thread.id, title: thread.title, ...(thread.color === undefined ? {} : { color: thread.color }) },
      ...(text === undefined ? {} : { text }),
      work: {
        id: `call:${id}`,
        title,
        state,
        startedAt: record.createdAt,
        ...(state === "working" ? {} : { endedAt: this.deps.clock.now() }),
        link: `agent:${thread.id}`,
      },
    };
    const line = `[call-me ${id}] ${content}`;
    const fallback = (): void => {
      if (!urgent) return;
      thread.say(`${line}${text === undefined ? "" : ` Tell ${this.deps.human}: ${text}`}`).catch((error: unknown) => {
        this.deps.log(`call-me ${id}: thread line not delivered: ${error instanceof Error ? error.message : String(error)}`);
      });
    };
    const sessionId = thread.sessionId();
    if (sessionId === undefined) {
      fallback();
      return;
    }
    this.deps.card(sessionId, line, entry).then(
      (posted) => {
        if (!posted) fallback();
      },
      (error: unknown) => {
        this.deps.log(`call-me ${id}: card not posted: ${error instanceof Error ? error.message : String(error)}`);
        fallback();
      },
    );
  }

  /** Takes the "is calling" notification off the phones (a silent push the phone handles). */
  private withdraw(id: string): void {
    this.deps.push({ data: { withdraw: `call:${id}` }, contentAvailable: true, sound: null });
  }

  private load(): CallRequestRecord[] {
    const path = this.deps.path;
    if (path === null || !existsSync(path)) return [];
    try {
      const parsed = z.object({ requests: z.array(CallRequestRecord) }).safeParse(JSON.parse(readFileSync(path, "utf8")));
      return parsed.success ? parsed.data.requests : [];
    } catch {
      return [];
    }
  }

  private save(): void {
    const path = this.deps.path;
    if (path === null) return;
    const all = [...this.records.keys()].map((id) => this.view(id));
    const open = all.filter((record) => record.endedAt === undefined);
    const ended = all.filter((record) => record.endedAt !== undefined).sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0)).slice(0, KEEP_ENDED);
    for (const record of all) if (!open.includes(record) && !ended.includes(record)) this.records.delete(record.id);
    try {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, `${JSON.stringify({ requests: [...open, ...ended] }, null, 2)}\n`, { mode: 0o600 });
      renameSync(tmp, path);
    } catch (error) {
      this.deps.log(`call-me: could not save ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/** Pushes `message` to every registered phone, dropping tokens the push service says are gone. */
export function pushToEveryPhone(
  tokens: PushTokenSource & { unregister(deviceId: string): void },
  sender: PushSender,
  log: (line: string) => void,
): (message: Omit<PushMessage, "to">) => void {
  return (message) => {
    const recipients = [...tokens.tokens()].map(([deviceId, token]) => ({ deviceId, token }));
    if (recipients.length === 0) {
      log("call-me: no phone registered for pushes");
      return;
    }
    void sender.send(recipients.map((recipient) => ({ ...message, to: recipient.token }))).then(
      (outcomes) => {
        outcomes.forEach((outcome, index) => {
          const recipient = recipients[index];
          if (outcome.ok || recipient === undefined) return;
          log(`call-me push to ${recipient.deviceId} failed: ${outcome.error}`);
          if (outcome.unregistered) tokens.unregister(recipient.deviceId);
        });
      },
      (error: unknown) => {
        log(`call-me push failed: ${error instanceof Error ? error.message : String(error)}`);
      },
    );
  };
}
