/**
 * The phone's thread rows as the turn navigator reads them (chat-core `buildTurns`). Only Isaac's
 * messages and the assistant's replies count, and an ask card nobody answered; everything else (tool
 * rows, status lines, cards, errors, Isaac's phone-side echoes and local rows) is left out. `at` is
 * omp's timestamp, so a row's turn key matches the one Relay desktop and the host use.
 */
import type { AgentMessage, AssistantMessage } from "@relay/protocol";
import type { TurnRow } from "@evaos/chat-core/turns";
import { backgroundOf } from "@/lib/background";

/** The text a reply reads as, with the replies token the host cut off put back for the flag rules. */
function withReplies(message: AssistantMessage): string {
  return message.replies === undefined
    ? message.text
    : `${message.text}\n[[replies: ${message.replies.join(" | ")}]]`;
}

/**
 * `rows` is the thread oldest first, as the list shows it reversed. `skip` drops rows that are not
 * part of the host's transcript (the echo of a turn in flight, rows this phone added); `ask` says an
 * ask card is waiting on Isaac, as a row after the last.
 */
export function assistantTurnRows(
  rows: readonly AssistantMessage[],
  skip: (message: AssistantMessage) => boolean,
  ask: boolean,
): TurnRow[] {
  const out: TurnRow[] = [];
  rows.forEach((message, index) => {
    if (skip(message)) return;
    if (message.role === "assistant") {
      out.push({
        index,
        id: message.id,
        role: "assistant",
        text: withReplies(message),
        at: message.at,
        images: (message.images?.length ?? 0) > 0,
        ref: message,
      });
    } else if (message.role === "user" && backgroundOf(message) === null) {
      out.push({
        index,
        id: message.id,
        role: "user",
        text: message.text,
        at: message.at,
        images: (message.images?.length ?? 0) > 0,
        ref: message,
      });
    }
  });
  if (ask) out.push({ index: rows.length, id: "ask", role: "ask", text: "", ref: out });
  return out;
}

/** A session transcript's rows, oldest first; `skip` drops this phone's echoes. */
export function agentTurnRows(
  rows: readonly AgentMessage[],
  skip: (message: AgentMessage) => boolean,
): TurnRow[] {
  const out: TurnRow[] = [];
  rows.forEach((message, index) => {
    if (skip(message)) return;
    if (message.role !== "user" && message.role !== "assistant") return;
    out.push({
      index,
      id: message.id,
      role: message.role,
      text: message.text,
      at: message.at,
      streaming: message.streaming,
      images: (message.images?.length ?? 0) > 0,
      ref: message,
    });
  });
  return out;
}
