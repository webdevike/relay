/**
 * Eva's specialist router on Isaac's rows of an assistant thread (protocol `specialist-router.ts`, the host puts it
 * on the row as `router`): what the quiet line under his bubble says, and what its sheet lists.
 */
import {
  routerDetail,
  routerLine,
  routerParts,
  routerPicked,
  type AssistantMessage,
  type RouterParts,
  type RouterTurn,
} from "@relay/protocol";

export interface RouterRowView {
  /** The line in pieces: the why shrinks to one line, the head and the after-turn mark stay whole. */
  readonly parts: RouterParts;
  /** The whole line, what VoiceOver reads. */
  readonly label: string;
}

/** The router line `message` shows: only Isaac's rows where the router picked a specialist; null for every other row (none and skipped included). */
export function routerRowOf(message: Pick<AssistantMessage, "role" | "router">): RouterRowView | null {
  const turn = message.router;
  if (message.role !== "user" || turn === undefined || !routerPicked(turn.decision)) return null;
  return {
    parts: routerParts(turn.decision, turn.outcome),
    label: routerLine(turn.decision, turn.outcome),
  };
}

const REQUEST_LABEL = "Suggested request";

/** The sheet's labelled rows, with the suggested request apart as pretty JSON (drawn as a code block). */
export function routerSheetOf(turn: RouterTurn): {
  rows: [label: string, value: string][];
  request: string | null;
} {
  const all = routerDetail(turn);
  return {
    rows: all.filter(([label]) => label !== REQUEST_LABEL),
    request: all.find(([label]) => label === REQUEST_LABEL)?.[1] ?? null,
  };
}
