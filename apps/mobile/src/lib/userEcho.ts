/**
 * Words the phone just sent into an agent session, shown as the user's bubble until the session's
 * transcript carries them: the plain-text twin of the sent slash command (./sentCommand.ts), and the
 * agent-session form of the assistant thread's `pending` echo (state/assistant.ts). Without it a
 * send shows nothing until omp writes the turn, which for a fresh session means omp starting, the
 * bridge typing the prompt in and the turn beginning: seconds with an empty card.
 *
 * A turn is taken once the transcript holds more user rows than it did at the send plus the
 * earlier echoes still waiting (the host may rewrite the words, e.g. a spoken command routed to
 * its `/command`), or a user row after the send with the same words. Each settled echo claims one
 * row, so the same words sent twice keep the second bubble until its own row lands. A refused send
 * keeps its bubble with the reason; the next send to that session clears it.
 * Pure, no React Native imports.
 */
import type { AgentMessage } from "@relay/protocol";
import { untagged } from "@/dictation/surface";

export interface UserEcho {
  /** Row id of the stand-in message. */
  id: string;
  /** As shown: the delivered words without the surface tag. */
  text: string;
  /** Phone clock at the send, ms. */
  at: number;
  /** User rows the transcript held at the send. */
  seen: number;
  /** User rows the transcript holds before this turn: `seen` plus the earlier echoes still waiting. */
  base: number;
  /** Why the host refused the send; the bubble stays, marked. */
  error?: string;
}

/** The user rows' words, as compared against an echo. */
function userTexts(messages: readonly AgentMessage[] | undefined): string[] {
  const texts: string[] = [];
  for (const message of messages ?? []) {
    if (message.role === "user") texts.push(untagged(message.text).trim());
  }
  return texts;
}

/**
 * The echo for a send of `text` into a transcript holding `messages`, behind the session's
 * `earlier` echoes; null when there are no words to show.
 */
export function userEcho(
  text: string,
  messages: readonly AgentMessage[] | undefined,
  earlier: readonly UserEcho[],
  now: number,
): UserEcho | null {
  const shown = untagged(text).trim();
  if (shown === "") return null;
  const seen = userTexts(messages).length;
  const waiting = earlier.filter((echo) => echo.error === undefined).length;
  return { id: `echo-${String(now)}-${String(earlier.length)}`, text: shown, at: now, seen, base: seen + waiting };
}

/** The echoes the transcript `messages` has not taken yet; the same array when none settled. */
export function settleEchoes(echoes: readonly UserEcho[], messages: readonly AgentMessage[]): readonly UserEcho[] {
  if (echoes.length === 0) return echoes;
  const users = userTexts(messages);
  const claimed = new Set<number>();
  const kept = echoes.filter((echo) => {
    if (echo.error !== undefined) return true;
    let row = -1;
    for (let i = echo.seen; i < users.length && row === -1; i += 1) {
      if (!claimed.has(i) && users[i] === echo.text) row = i;
    }
    if (row === -1 && users.length > echo.base && !claimed.has(echo.base)) row = echo.base;
    if (row === -1) return true;
    claimed.add(row);
    return false;
  });
  return kept.length === echoes.length ? echoes : kept;
}

/** The echoes as the transcript rows the card draws after the session's own. */
export function echoRows(echoes: readonly UserEcho[]): AgentMessage[] {
  return echoes.map((echo) => ({ id: echo.id, role: "user", text: echo.text, at: echo.at }));
}
