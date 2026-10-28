// Reactions (iMessage-style tapbacks) Isaac puts on chat bubbles, from the phone or Relay desktop.
// The host owns them: one reaction per bubble, kept per thread (`assistant:<id>` or
// `session:<omp session id>`) and bubble (`<role>@<omp timestamp>`) in
// `$XDG_CONFIG_HOME/relay/reactions.json` (dir 0700, file 0600, written atomically), and every change
// goes out to every device as the thread's `reactions.snapshot`.
//
// Reactions never start a turn. A few seconds after the last change in a thread, the agent running
// it gets a quiet note through the omp bridge (`pi.sendMessage` with `deliverAs: "nextTurn"`: in its
// context from its next turn on, never shown, never a turn of its own), one line per bubble whose
// reaction changed since the last note it took. While no session runs the thread, or its omp
// predates notes, the changes wait and go out with the first session that takes them.
//
// A 👎 or ❓ on an assistant's reply in its own thread is also feedback: one JSON line in
// `<agentHome>/work/eva/agents/<id>/reactions.jsonl`, next to the Catch Up notes, for the agent to learn from.

import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { FEEDBACK_REACTIONS, Reaction, ReactionKey, reactionRole, type ServerMessage, type ThreadReactions } from "@relay/protocol";
import type { AgentProviderChange } from "../seams";
import type { SessionClock } from "../session";

/** How long a thread's reactions settle before the agent hears them, so a quick change of mind is one line. */
export const REACTION_NOTE_DELAY_MS = 3000;
/** Characters of a bubble's excerpt the agent's note quotes. */
export const NOTE_QUOTE_CHARS = 80;

const Told = z.object({ emoji: z.string(), excerpt: z.string() });
type Told = z.infer<typeof Told>;

const ReactionState = z.object({
  /** Every thread's reactions. */
  threads: z.record(z.string(), z.record(ReactionKey, Reaction)).default({}),
  /** What each thread's agent last heard, by bubble: the reactions its last note left it with. */
  told: z.record(z.string(), z.record(ReactionKey, Told)).default({}),
});
type ReactionState = z.infer<typeof ReactionState>;

/** One line of an agent's `reactions.jsonl`: a 👎 or ❓ Isaac put on one of its replies. */
export interface ReactionFeedback {
  at: string;
  agent: string;
  reaction: string;
  signal: "thumbs-down" | "question";
  /** The reply, by its omp timestamp (ISO 8601), and the start of its text. */
  message: { at: string; excerpt: string };
}

/** `$XDG_CONFIG_HOME/relay/reactions.json`. */
export function defaultReactionsPath(): string {
  const base = process.env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config");
  return join(base, "relay", "reactions.json");
}

/** Where agent `agent`'s feedback goes: `<agentHome>/work/eva/agents/<agent>/reactions.jsonl`; null without an agent home. */
export function reactionFeedbackPath(agentHome: string | null, agent: string): string | null {
  return agentHome === null ? null : join(agentHome, "work", "eva", "agents", agent, "reactions.jsonl");
}

/**
 * The note for an agent whose thread's reactions moved from `told` to `now`: one line per changed
 * bubble, oldest bubble first, then one line saying no reply is needed. Empty when nothing changed.
 */
export function reactionNote(told: Readonly<Record<string, Told>>, now: Readonly<ThreadReactions>): string {
  const keys = [...new Set([...Object.keys(told), ...Object.keys(now)])].sort((a, b) => stampOf(a) - stampOf(b));
  const lines: string[] = [];
  for (const key of keys) {
    const before = told[key];
    const after = now[key];
    const excerpt = after?.excerpt ?? before?.excerpt;
    if (before?.emoji === after?.emoji || excerpt === undefined) continue;
    const whose = reactionRole(key) === "assistant" ? "your message" : "his own message";
    const quoted = excerpt.length > NOTE_QUOTE_CHARS ? `${excerpt.slice(0, NOTE_QUOTE_CHARS)}…` : excerpt;
    lines.push(
      after === undefined
        ? `[Isaac removed his ${before?.emoji ?? ""} reaction from ${whose}: "${quoted}"]`
        : `[Isaac reacted ${after.emoji} to ${whose}: "${quoted}"]`,
    );
  }
  if (lines.length === 0) return "";
  lines.push("(Reactions are quiet feedback from Isaac: take them into account, no need to answer them.)");
  return lines.join("\n");
}

/** The omp timestamp (ms) a reaction key carries. */
function stampOf(key: string): number {
  return Number(key.slice(key.indexOf("@") + 1));
}

export interface ReactionServiceDeps {
  readonly path: string;
  /** Where assistant `agent`'s feedback is appended; null: not logged. */
  readonly feedbackPath: (agent: string) => string | null;
  /** Sends `message` to every authenticated device. */
  readonly broadcast: (message: ServerMessage) => void;
  /** The live omp session that runs `thread` now; null when none does. */
  readonly session: (thread: string) => string | null;
  /** Hands `text` to session `sessionId` as a quiet note; true when it took it (an omp from before notes answers false). */
  readonly note: (sessionId: string, text: string) => Promise<boolean>;
  readonly clock: SessionClock;
  readonly log: (line: string) => void;
}

/** What a phone session and the server need of the reactions. */
export interface ReactionRelaying {
  snapshot(thread: string): ThreadReactions;
  /** Reacts `emoji` to bubble `key` of `thread` (replacing its reaction); false when that is already its reaction. */
  set(thread: string, key: string, emoji: string, excerpt: string): boolean;
  /** Takes back bubble `key`'s reaction; false when it had none. */
  clear(thread: string, key: string): boolean;
  /** Takes a provider change: a session that may run a thread with changes it has not heard yet gets them. */
  observe(change: AgentProviderChange): void;
}

export class ReactionService implements ReactionRelaying {
  private state: ReactionState;
  /** Threads whose agent has changes to hear, waiting out REACTION_NOTE_DELAY_MS. */
  private readonly timers = new Map<string, () => void>();
  /** Threads with a note on its way to a session. */
  private readonly sending = new Set<string>();
  /** The session that last turned a thread's note down; it is not asked again. */
  private readonly refused = new Map<string, string>();

  constructor(private readonly deps: ReactionServiceDeps) {
    this.state = this.load();
  }

  snapshot(thread: string): ThreadReactions {
    return this.state.threads[thread] ?? {};
  }

  set(thread: string, key: string, emoji: string, excerpt: string): boolean {
    const reactions = this.snapshot(thread);
    const before = reactions[key];
    if (before?.emoji === emoji) return false;
    this.state.threads[thread] = { ...reactions, [key]: { emoji, excerpt, at: this.deps.clock.now() } };
    this.changed(thread);
    this.deps.log(`reactions: ${emoji} on ${thread} ${key}`);
    if (FEEDBACK_REACTIONS.includes(emoji) && reactionRole(key) === "assistant" && thread.startsWith("assistant:")) {
      this.feedback(thread.slice("assistant:".length), key, emoji, excerpt);
    }
    return true;
  }

  clear(thread: string, key: string): boolean {
    const reactions = this.snapshot(thread);
    if (reactions[key] === undefined) return false;
    const rest = Object.fromEntries(Object.entries(reactions).filter(([other]) => other !== key));
    this.state.threads =
      Object.keys(rest).length === 0
        ? Object.fromEntries(Object.entries(this.state.threads).filter(([other]) => other !== thread))
        : { ...this.state.threads, [thread]: rest };
    this.changed(thread);
    this.deps.log(`reactions: cleared ${thread} ${key}`);
    return true;
  }

  observe(change: AgentProviderChange): void {
    if (change.kind !== "sessions") return;
    for (const thread of this.unheard()) {
      if (this.timers.has(thread)) continue;
      const session = this.deps.session(thread);
      if (session !== null && this.refused.get(thread) !== session) this.deliver(thread);
    }
  }

  private changed(thread: string): void {
    this.save();
    this.deps.broadcast({ t: "reactions.snapshot", thread, reactions: this.snapshot(thread) });
    this.refused.delete(thread);
    this.timers.get(thread)?.();
    this.timers.set(
      thread,
      this.deps.clock.after(REACTION_NOTE_DELAY_MS, () => {
        this.timers.delete(thread);
        this.deliver(thread);
      }),
    );
  }

  /** Threads whose reactions changed since their agent's last note. */
  private unheard(): string[] {
    const threads = new Set([...Object.keys(this.state.threads), ...Object.keys(this.state.told)]);
    return [...threads].filter((thread) => reactionNote(this.state.told[thread] ?? {}, this.snapshot(thread)) !== "");
  }

  private deliver(thread: string): void {
    if (this.sending.has(thread)) return;
    const now = this.snapshot(thread);
    const text = reactionNote(this.state.told[thread] ?? {}, now);
    if (text === "") return;
    const session = this.deps.session(thread);
    if (session === null) {
      this.deps.log(`reactions: ${thread} has no session; its note waits`);
      return;
    }
    this.sending.add(thread);
    void this.deps
      .note(session, text)
      .catch((error: unknown) => {
        this.deps.log(`reactions: note to ${session} failed: ${error instanceof Error ? error.message : String(error)}`);
        return false;
      })
      .then((took) => {
        this.sending.delete(thread);
        if (!took) {
          this.refused.set(thread, session);
          this.deps.log(`reactions: ${session} did not take the note for ${thread}; it waits for a session that can`);
          return;
        }
        const told = Object.fromEntries(Object.entries(now).map(([key, reaction]) => [key, { emoji: reaction.emoji, excerpt: reaction.excerpt }]));
        this.state.told =
          Object.keys(told).length === 0
            ? Object.fromEntries(Object.entries(this.state.told).filter(([other]) => other !== thread))
            : { ...this.state.told, [thread]: told };
        this.save();
        this.deps.log(`reactions: ${thread} note delivered to ${session}`);
        // Changes made while the note was on its way go out now, unless their own timer still runs.
        if (!this.timers.has(thread)) this.deliver(thread);
      });
  }

  private feedback(agent: string, key: string, emoji: string, excerpt: string): void {
    const path = this.deps.feedbackPath(agent);
    if (path === null) return;
    const line: ReactionFeedback = {
      at: new Date(this.deps.clock.now()).toISOString(),
      agent,
      reaction: emoji,
      signal: emoji === "👎" ? "thumbs-down" : "question",
      message: { at: new Date(stampOf(key)).toISOString(), excerpt },
    };
    try {
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, `${JSON.stringify(line)}\n`);
    } catch (error) {
      this.deps.log(`reactions: cannot write feedback to ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private load(): ReactionState {
    const empty: ReactionState = { threads: {}, told: {} };
    if (!existsSync(this.deps.path)) return empty;
    try {
      const parsed = ReactionState.safeParse(JSON.parse(readFileSync(this.deps.path, "utf8")));
      if (parsed.success) return parsed.data;
      this.deps.log(`reactions: ${this.deps.path} is not a reactions file; starting empty`);
    } catch (error) {
      this.deps.log(`reactions: cannot read ${this.deps.path}: ${error instanceof Error ? error.message : String(error)}`);
    }
    return empty;
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.deps.path), { recursive: true, mode: 0o700 });
      const tmp = `${this.deps.path}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.state), { mode: 0o600 });
      chmodSync(tmp, 0o600);
      renameSync(tmp, this.deps.path);
    } catch (error) {
      this.deps.log(`reactions: cannot save ${this.deps.path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
