/**
 * Pure rules for an assistant thread's open asks (`AssistantSnapshot.asks`: questions the
 * assistant asked that Isaac has not answered), listed by the header's open-questions button and
 * sheet. Which show and in what order, which ask a reply chip or ask card stands for, and which
 * thread row Show in chat scrolls to (a bubble, or an inline card for an ask without one). No React
 * Native imports.
 */
import type { AssistantMessage, OpenAsk } from "@relay/protocol";

/** The ask card showing above the composer: its open ask is not listed twice. */
export interface ShownAskCard {
  sessionId: string;
  askId: string;
}

/**
 * The open asks to list, newest first: all of `asks` except the one whose ask card already shows
 * above the composer and the ids Isaac closed on this phone (`hidden`) that the host has not
 * dropped yet. `undefined` (an older host) shows none.
 */
export function visibleAsks(asks: readonly OpenAsk[] | undefined, card: ShownAskCard | null, hidden: ReadonlySet<string>): OpenAsk[] {
  if (asks === undefined) return [];
  return asks
    .filter(
      (ask) => !hidden.has(ask.id) && !(card !== null && ask.askId === card.askId && (ask.sessionId === undefined || ask.sessionId === card.sessionId)),
    )
    .sort((a, b) => b.at - a.at);
}

/** The ids of `hidden` the host still lists: the rest are gone from its snapshot and need no hiding. Same set when nothing dropped. */
export function pruneHidden(hidden: ReadonlySet<string>, asks: readonly OpenAsk[] | undefined): ReadonlySet<string> {
  if (hidden.size === 0) return hidden;
  const open = new Set((asks ?? []).map((ask) => ask.id));
  const kept = [...hidden].filter((id) => open.has(id));
  return kept.length === hidden.size ? hidden : new Set(kept);
}

/** Row ids of an ask drawn inline in the thread (no bubble of its own) start with this. */
export const ASK_ROW_PREFIX = "ask-card:";

/** The id of the inline thread row an ask without a bubble is drawn as. */
export function askRowId(ask: OpenAsk): string {
  return `${ASK_ROW_PREFIX}${ask.id}`;
}

/** Whether `id` is an inline ask row rather than one of the thread's messages. */
export function isAskRow(id: string): boolean {
  return id.startsWith(ASK_ROW_PREFIX);
}

/** The row Show in chat scrolls to: the ask's own bubble while it is in `messageIds`, else its inline card. */
export function askRowTarget(ask: OpenAsk, messageIds: ReadonlySet<string>): string {
  return ask.messageId !== undefined && messageIds.has(ask.messageId) ? ask.messageId : askRowId(ask);
}

/** Ids of the thread's bubbles that carry an open ask (and so keep their accent edge and tag). */
export function waitingMessageIds(asks: readonly OpenAsk[] | undefined, hidden: ReadonlySet<string>, messageIds: ReadonlySet<string>): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const ask of asks ?? []) {
    if (!hidden.has(ask.id) && ask.messageId !== undefined && messageIds.has(ask.messageId)) ids.add(ask.messageId);
  }
  return ids;
}

/** The asks with no bubble in the thread (a session's, a card's, a reply that left it): drawn as inline cards. */
export function askCards(asks: readonly OpenAsk[], messageIds: ReadonlySet<string>): OpenAsk[] {
  return asks.filter((ask) => ask.messageId === undefined || !messageIds.has(ask.messageId));
}

/**
 * `messages` (oldest first) with a card row for each of `cards` at the time it was asked: before the
 * first message that came after it. The card row's text is the question; its `role` is "card".
 */
export function withAskRows(messages: readonly AssistantMessage[], cards: readonly OpenAsk[]): AssistantMessage[] {
  if (cards.length === 0) return [...messages];
  const rows = cards.map((ask): AssistantMessage => ({ id: askRowId(ask), role: "card", text: ask.question, at: ask.at })).sort((a, b) => a.at - b.at);
  const out: AssistantMessage[] = [];
  let next = 0;
  for (const message of messages) {
    for (let row = rows[next]; row !== undefined && row.at < message.at; row = rows[next]) {
      out.push(row);
      next += 1;
    }
    out.push(message);
  }
  out.push(...rows.slice(next));
  return out;
}

/** What a session ask says it does when Isaac does not answer; null when it names no default among its answers. */
export function defaultNote(ask: OpenAsk): string | null {
  return ask.default !== undefined && ask.replies.includes(ask.default) ? `Going with ${ask.default} unless you say otherwise.` : null;
}
