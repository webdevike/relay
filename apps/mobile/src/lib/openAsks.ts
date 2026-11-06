/**
 * Pure rules for an assistant thread's open-ask badges above the composer (`AssistantSnapshot.asks`:
 * questions the assistant asked that Isaac has not answered). Which show, in what order, how many
 * badges before a `+N`, and which ask a reply chip or ask card stands for. No React Native imports.
 */
import type { OpenAsk } from "@relay/protocol";

/** Badges drawn before the rest collapse into one `+N` chip. */
export const MAX_ASK_BADGES = 3;

/** The ask card showing above the composer: its open ask is not badged twice. */
export interface ShownAskCard {
  sessionId: string;
  askId: string;
}

/**
 * The open asks to badge, newest first: all of `asks` except the one whose ask card already shows,
 * the one whose row carries its replies as inline chips (`inlineMessageId`, the row `liveReplies`
 * puts chips under) and the ids Isaac closed on this phone (`hidden`) that the host has not dropped
 * yet. `undefined` (an older host) shows none.
 */
export function visibleAsks(asks: readonly OpenAsk[] | undefined, card: ShownAskCard | null, inlineMessageId: string | null, hidden: ReadonlySet<string>): OpenAsk[] {
  if (asks === undefined) return [];
  return asks
    .filter(
      (ask) =>
        !hidden.has(ask.id) &&
        !(inlineMessageId !== null && ask.messageId === inlineMessageId) &&
        !(card !== null && ask.askId === card.askId && (ask.sessionId === undefined || ask.sessionId === card.sessionId)),
    )
    .sort((a, b) => b.at - a.at);
}

/** The first `MAX_ASK_BADGES` asks as badges and how many more the `+N` chip stands for (0: none). */
export function askBadges(visible: readonly OpenAsk[]): { badges: readonly OpenAsk[]; more: number } {
  return { badges: visible.slice(0, MAX_ASK_BADGES), more: Math.max(0, visible.length - MAX_ASK_BADGES) };
}

/** The ids of `hidden` the host still lists: the rest are gone from its snapshot and need no hiding. Same set when nothing dropped. */
export function pruneHidden(hidden: ReadonlySet<string>, asks: readonly OpenAsk[] | undefined): ReadonlySet<string> {
  if (hidden.size === 0) return hidden;
  const open = new Set((asks ?? []).map((ask) => ask.id));
  const kept = [...hidden].filter((id) => open.has(id));
  return kept.length === hidden.size ? hidden : new Set(kept);
}

/**
 * What an ask's compact sheet offers: its question (plus the default a session ask goes with) and
 * its answers, the default first and marked. `reply` is the exact text an answer sends.
 */
export function askSheet(ask: OpenAsk): { message: string; choices: { label: string; reply: string }[] } {
  const fallback = ask.default !== undefined && ask.replies.includes(ask.default) ? ask.default : undefined;
  const ordered = fallback === undefined ? ask.replies : [fallback, ...ask.replies.filter((reply) => reply !== fallback)];
  return {
    message: ask.default === undefined ? ask.question : `${ask.question}\n\nGoing with ${ask.default} unless you say otherwise.`,
    choices: ordered.map((reply) => ({ label: reply === fallback ? `${reply} (default)` : reply, reply })),
  };
}
