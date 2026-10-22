/**
 * A slash command the phone just sent, shown as running until the session answers it: EvaOS's
 * unconfirmed "sent" row (apps/evaos/src/chat.rs, `Live::sent`) for the phone. omp writes nothing
 * back for a command until it takes effect (a skill's turn starts, a goal changes, a handoff
 * compacts), so without this a sent command shows nothing at all for a while.
 *
 * Any command clears on the first sign the session took it: a transcript row after the send, a
 * status or goal change, a handoff starting. A `/handoff` is the exception (EvaOS sets
 * `handing_off` on send): it stays until the handoff is over, which is when the session's
 * `handingOff` goes off again, or a system row lands (the compaction notice, or the host saying
 * it refused). Sessions whose omp predates that reporting only clear at the timeouts.
 * Pure, no React Native imports.
 */
import type { AgentMessage, AgentSession, AgentStatus } from "@relay/protocol";
import { commandWord } from "./slash";

export interface SentCommand {
  /** As sent: "/handoff", "/skill:review the diff". */
  text: string;
  /** The command word: "/handoff", "/skill:review". */
  name: string;
  /** Phone clock at the send, ms. */
  at: number;
  /** A `/handoff`, shown as the handoff banner until it is over. */
  handoff: boolean;
  /** The session has reported `handingOff` since the send. */
  sawHandoff: boolean;
  /** The session's status and goal at the send; a change means the command took effect. */
  status: AgentStatus | undefined;
  goal: string;
}

/** A command the session never answers (`/rename`, a refused one) stops showing after this. */
export const SENT_COMMAND_TIMEOUT_MS = 8_000;
/** A handoff that never reports back stops showing after this, the bound EvaOS uses. */
export const SENT_HANDOFF_TIMEOUT_MS = 5 * 60_000;

const HANDOFF = /^\/handoff(\s|$)/;

/** The pending command for a reply's text, or null when it is not a slash command. */
export function sentCommand(text: string, session: AgentSession | undefined, now: number): SentCommand | null {
  const trimmed = text.trim();
  const name = commandWord(trimmed);
  if (name === undefined) return null;
  return {
    text: trimmed,
    name,
    at: now,
    handoff: HANDOFF.test(trimmed),
    sawHandoff: false,
    status: session?.status,
    goal: JSON.stringify(session?.goal ?? null),
  };
}

/** The command after a session update: kept (possibly noting the handoff), or null once answered. */
export function settleOnSession(sent: SentCommand, session: AgentSession): SentCommand | null {
  if (sent.handoff) {
    if (session.handingOff === true) return sent.sawHandoff ? sent : { ...sent, sawHandoff: true };
    return sent.sawHandoff ? null : sent;
  }
  if (session.handingOff === true || session.status !== sent.status || JSON.stringify(session.goal ?? null) !== sent.goal) return null;
  return sent;
}

/** The command after rows were appended to the session's transcript; null once answered. */
export function settleOnMessages(sent: SentCommand, appended: readonly AgentMessage[]): SentCommand | null {
  if (appended.length === 0) return sent;
  if (!sent.handoff) return null;
  return appended.some((message) => message.role === "system") ? null : sent;
}

/** How long the command still shows, ms; 0 or less once it has timed out. */
export function sentRemaining(sent: SentCommand, now: number): number {
  return sent.at + (sent.handoff ? SENT_HANDOFF_TIMEOUT_MS : SENT_COMMAND_TIMEOUT_MS) - now;
}
