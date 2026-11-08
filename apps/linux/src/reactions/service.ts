// Reactions (iMessage-style tapbacks) on chat bubbles: Isaac's, from the phone or Relay desktop, and
// assistants' on Isaac's bubbles (the `react` CLI from their session, `POST /reactions/agent`).
// The host owns them: one reaction per bubble and reactor (`isaac` or an agent id), kept per thread
// (`assistant:<id>` or `session:<omp session id>`) and bubble (`<role>@<omp timestamp>`) in
// `$XDG_CONFIG_HOME/relay/reactions.json` (dir 0700, file 0600, written atomically), and every change
// goes out to every device as the thread's `reactions.snapshot`. An assistant's reaction is only
// shown: no note, no feedback, no push.
//
// Most reactions never start a turn. A few seconds after the last change in a thread, the agent running
// it gets a quiet note through the omp bridge (`pi.sendMessage` with `deliverAs: "nextTurn"`: in its
// context from its next turn on, never shown, never a turn of its own), one line per bubble whose
// reaction changed since the last note it took. While no session runs the thread, or its omp
// predates notes, the changes wait and go out with the first session that takes them.
//
// Exception: a reply-worthy reaction (`REPLY_INSTRUCTIONS`, chosen by `RELAY_REPLY_REACTIONS`, default
// ❓ only) on an assistant's reply in its own thread starts a turn right away, once the reaction has
// stayed REPLY_DEBOUNCE_MS (a toggle off and on, or a change of emoji, never double-fires). If the
// thread's session is mid-turn the turn waits for it to go idle. That reaction is then not also sent as a
// quiet note.
//
// A 👎 or ❓ on an assistant's reply in its own thread is also feedback: one JSON line in
// `<agentHome>/work/eva/agents/<id>/reactions.jsonl`, next to the Catch Up notes, for the agent to learn from.

import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { FEEDBACK_REACTIONS, ISAAC_REACTOR, Reaction, ReactionKey, Reactor, reactionRole, type ServerMessage, type ThreadReactions } from "@relay/protocol";
import type { AgentProviderChange } from "../seams";
import type { SessionClock } from "../session";

/** How long a thread's reactions settle before the agent hears them, so a quick change of mind is one line. */
export const REACTION_NOTE_DELAY_MS = 3000;
/** Characters of a bubble's excerpt the agent's note quotes. */
export const NOTE_QUOTE_CHARS = 80;

function replyId(thread: string, key: string): string {
  return `${thread}\n${key}`;
}

/** How long a reply-worthy reaction must stand before it starts a turn, so toggling it does not fire twice. */
export const REPLY_DEBOUNCE_MS = 1500;
/** How long after a reply-worthy reaction started a turn the same emoji on the same bubble stays quiet. */
export const REPLY_COOLDOWN_MS = 60_000;

/**
 * What a turn started by a reaction tells the agent to do, by emoji. Only the emojis `RELAY_REPLY_REACTIONS`
 * names are live (default `❓`); 👎 is here but off until it is listed.
 */
export const REPLY_INSTRUCTIONS: Readonly<Record<string, string>> = {
  "❓": "He is confused by it: re-explain it shorter and simpler.",
  "👎": "He did not like it: say what you would change, briefly.",
};

/** The reply-worthy reactions from `RELAY_REPLY_REACTIONS` (comma-separated emojis; unset = `❓`; empty = none). */
export function replyReactionsFromEnv(value: string | undefined = process.env["RELAY_REPLY_REACTIONS"]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const emoji of (value ?? "❓").split(",").map((item) => item.trim())) {
    const instruction = REPLY_INSTRUCTIONS[emoji];
    if (instruction !== undefined) out[emoji] = instruction;
  }
  return out;
}

/** The turn text for a reply-worthy reaction. */
export function reactionTurn(emoji: string, excerpt: string, instruction: string): string {
  return `[Isaac reacted ${emoji} to your message: "${quoteOf(excerpt)}"] ${instruction}`;
}

function quoteOf(excerpt: string): string {
  return excerpt.length > NOTE_QUOTE_CHARS ? `${excerpt.slice(0, NOTE_QUOTE_CHARS)}…` : excerpt;
}

const Told = z.object({ emoji: z.string(), excerpt: z.string() });
type Told = z.infer<typeof Told>;

const ReactionState = z.object({
  /** Every thread's reactions by bubble, then reactor; files from before reactors held Isaac's reaction directly. */
  threads: z.record(z.string(), z.record(ReactionKey, z.union([Reaction.transform((reaction) => ({ [ISAAC_REACTOR]: reaction })), z.record(Reactor, Reaction)]))).default({}),
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
export function reactionNote(told: Readonly<Record<string, Told>>, now: Readonly<Record<string, Reaction>>): string {
  const keys = [...new Set([...Object.keys(told), ...Object.keys(now)])].sort((a, b) => stampOf(a) - stampOf(b));
  const lines: string[] = [];
  for (const key of keys) {
    const before = told[key];
    const after = now[key];
    const excerpt = after?.excerpt ?? before?.excerpt;
    if (before?.emoji === after?.emoji || excerpt === undefined) continue;
    const whose = reactionRole(key) === "assistant" ? "your message" : "his own message";
    const quoted = quoteOf(excerpt);
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
  /** Reply-worthy reactions start a turn; absent: every reaction stays a quiet note. */
  readonly reply?: {
    /** Reactions that start a turn, with what each tells the agent to do. */
    readonly emojis: Readonly<Record<string, string>>;
    /** Whether the thread's session is mid-turn right now. */
    readonly busy: (thread: string) => boolean;
    /** Delivers `text` as Isaac's next turn in `thread`, starting its agent when it is not running. */
    readonly turn: (thread: string, text: string) => Promise<void>;
  };
}

/** What a phone session, the server and the agent endpoint need of the reactions. */
export interface ReactionRelaying {
  snapshot(thread: string): ThreadReactions;
  /** `by` (default Isaac) reacts `emoji` to bubble `key` of `thread`, replacing its own reaction there; false when that is already it. */
  set(thread: string, key: string, emoji: string, excerpt: string, by?: string): boolean;
  /** Takes back `by`'s (default Isaac's) reaction on bubble `key`; false when it had none. */
  clear(thread: string, key: string, by?: string): boolean;
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
  /** Reply-worthy reactions not yet turned into a turn, by thread and bubble: debouncing, or waiting for an idle session. */
  private readonly replies = new Map<string, { thread: string; key: string; emoji: string; excerpt: string; cancel: (() => void) | null }>();
  /** When each thread and bubble last started a turn, and for which emoji. */
  private readonly replied = new Map<string, { emoji: string; at: number }>();

  constructor(private readonly deps: ReactionServiceDeps) {
    this.state = this.load();
  }

  snapshot(thread: string): ThreadReactions {
    return this.state.threads[thread] ?? {};
  }

  set(thread: string, key: string, emoji: string, excerpt: string, by: string = ISAAC_REACTOR): boolean {
    const reactions = this.snapshot(thread);
    if (reactions[key]?.[by]?.emoji === emoji) return false;
    if (by === ISAAC_REACTOR) this.cancelReply(thread, key);
    this.state.threads = { ...this.state.threads, [thread]: { ...reactions, [key]: { ...reactions[key], [by]: { emoji, excerpt, at: this.deps.clock.now() } } } };
    this.changed(thread, by === ISAAC_REACTOR);
    this.deps.log(`reactions: ${by} ${emoji} on ${thread} ${key}`);
    if (by === ISAAC_REACTOR && FEEDBACK_REACTIONS.includes(emoji) && reactionRole(key) === "assistant" && thread.startsWith("assistant:")) {
      this.feedback(thread.slice("assistant:".length), key, emoji, excerpt);
    }
    if (by === ISAAC_REACTOR && reactionRole(key) === "assistant" && thread.startsWith("assistant:")) this.scheduleReply(thread, key, emoji, excerpt);
    return true;
  }

  clear(thread: string, key: string, by: string = ISAAC_REACTOR): boolean {
    const reactions = this.snapshot(thread);
    const bubble = reactions[key];
    if (bubble?.[by] === undefined) return false;
    const left = Object.fromEntries(Object.entries(bubble).filter(([reactor]) => reactor !== by));
    const rest = Object.keys(left).length === 0 ? Object.fromEntries(Object.entries(reactions).filter(([other]) => other !== key)) : { ...reactions, [key]: left };
    this.state.threads =
      Object.keys(rest).length === 0
        ? Object.fromEntries(Object.entries(this.state.threads).filter(([other]) => other !== thread))
        : { ...this.state.threads, [thread]: rest };
    if (by === ISAAC_REACTOR) this.cancelReply(thread, key);
    this.changed(thread, by === ISAAC_REACTOR);
    this.deps.log(`reactions: ${by} cleared ${thread} ${key}`);
    return true;
  }

  observe(change: AgentProviderChange): void {
    if (change.kind !== "sessions") return;
    for (const entry of [...this.replies.values()]) if (entry.cancel === null) this.fireReply(entry);
    for (const thread of this.unheard()) {
      if (this.timers.has(thread)) continue;
      const session = this.deps.session(thread);
      if (session !== null && this.refused.get(thread) !== session) this.deliver(thread);
    }
  }

  /** Isaac's reactions in `thread` by bubble: what the agent's notes are about. */
  private isaacs(thread: string): Record<string, Reaction> {
    const out: Record<string, Reaction> = {};
    for (const [key, bubble] of Object.entries(this.snapshot(thread))) {
      const reaction = bubble[ISAAC_REACTOR];
      if (reaction !== undefined && !this.replies.has(replyId(thread, key))) out[key] = reaction;
    }
    return out;
  }

  /** Saves and broadcasts `thread`; Isaac's changes (`noted`) also go to its agent once they settle. */
  private changed(thread: string, noted: boolean): void {
    this.save();
    this.deps.broadcast({ t: "reactions.snapshot", thread, reactions: this.snapshot(thread) });
    if (!noted) return;
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
    return [...threads].filter((thread) => reactionNote(this.toldOf(thread), this.isaacs(thread)) !== "");
  }

  /** What `thread`'s agent last heard, less the bubbles whose reaction is about to be a turn instead. */
  private toldOf(thread: string): Record<string, Told> {
    return Object.fromEntries(Object.entries(this.state.told[thread] ?? {}).filter(([key]) => !this.replies.has(replyId(thread, key))));
  }

  private cancelReply(thread: string, key: string): void {
    const id = replyId(thread, key);
    this.replies.get(id)?.cancel?.();
    this.replies.delete(id);
  }

  private scheduleReply(thread: string, key: string, emoji: string, excerpt: string): void {
    const reply = this.deps.reply;
    if (reply?.emojis[emoji] === undefined) return;
    const before = this.replied.get(replyId(thread, key));
    if (before?.emoji === emoji && this.deps.clock.now() - before.at < REPLY_COOLDOWN_MS) return;
    const id = replyId(thread, key);
    const entry = { thread, key, emoji, excerpt, cancel: null as (() => void) | null };
    entry.cancel = this.deps.clock.after(REPLY_DEBOUNCE_MS, () => {
      entry.cancel = null;
      this.fireReply(entry);
    });
    this.replies.set(id, entry);
  }

  private fireReply(entry: { thread: string; key: string; emoji: string; excerpt: string }): void {
    const reply = this.deps.reply;
    const id = replyId(entry.thread, entry.key);
    const instruction = reply?.emojis[entry.emoji];
    if (reply === undefined || instruction === undefined || this.replies.get(id) !== entry) return;
    // Mid-turn: stay queued; `observe` fires it once the session is idle.
    if (reply.busy(entry.thread)) return;
    this.replied.set(id, { emoji: entry.emoji, at: this.deps.clock.now() });
    void reply
      .turn(entry.thread, reactionTurn(entry.emoji, entry.excerpt, instruction))
      .then(
        () => {
          this.replies.delete(id);
          this.state.told = { ...this.state.told, [entry.thread]: { ...this.state.told[entry.thread], [entry.key]: { emoji: entry.emoji, excerpt: entry.excerpt } } };
          this.save();
          this.deps.log(`reactions: ${entry.emoji} on ${entry.thread} ${entry.key} started a turn`);
        },
        (error: unknown) => {
          this.replies.delete(id);
          this.replied.delete(id);
          this.deps.log(`reactions: turn for ${entry.emoji} on ${entry.thread} failed: ${error instanceof Error ? error.message : String(error)}; it goes as a quiet note`);
          if (!this.timers.has(entry.thread)) this.deliver(entry.thread);
        },
      );
  }

  private deliver(thread: string): void {
    if (this.sending.has(thread)) return;
    const now = this.isaacs(thread);
    const text = reactionNote(this.toldOf(thread), now);
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
