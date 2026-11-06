// Tap-to-answer replies: an assistant thread may end a reply that asks Isaac something with a few
// clear answers on `[[replies: Yes, push it | Not yet]]`. The host cuts the token from the text and
// hands the answers to the phone as `AssistantMessage.replies`, which shows them as buttons under the
// newest bubble; a tap sends that label as Isaac's next message. Nothing is sent without a tap.
// A line `[[ask-label: Short label]]` right before the token names the question for its open-ask
// badge (`asks.ts`); it is cut with the token and never shows.

import { MAX_ASK_LABEL } from "@relay/protocol";

/** Most answers a reply carries; later ones are dropped. */
export const MAX_REPLIES = 4;
/** Longest answer, in characters; a longer one is dropped. */
export const MAX_REPLY_CHARS = 24;

/** The token an assistant ends a reply with. Answers are split on `|` and never hold `]` or a newline. */
const TOKEN = /[ \t\r\n]*\[\[replies:([^\]\n]*)\]\][ \t\r\n]*$/;
/** An ask-label line at the end of what precedes the token (like the token, whitespace around it is taken). */
const LABEL = /[ \t\r\n]*\[\[ask-label:([^\]\n]*)\]\][ \t\r\n]*$/;
const OPENERS = ["[[replies:", "[[ask-label:"];

/** The token's answers: trimmed, inner whitespace collapsed, empty and too-long ones dropped, deduped case-insensitively, at most `MAX_REPLIES`. */
function answers(body: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of body.split("|")) {
    const label = part.trim().replace(/\s+/g, " ");
    if (label.length === 0 || label.length > MAX_REPLY_CHARS) continue;
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(label);
    if (out.length === MAX_REPLIES) break;
  }
  return out;
}

/** An ask label as the badge takes it: trimmed, inner whitespace collapsed, cut to `MAX_ASK_LABEL` with an ellipsis; undefined when empty. */
function cleanLabel(body: string): string | undefined {
  const label = body.trim().replace(/\s+/g, " ");
  if (label.length === 0) return undefined;
  if (label.length <= MAX_ASK_LABEL) return label;
  const head = label.slice(0, MAX_ASK_LABEL - 1);
  return `${/[\uD800-\uDBFF]$/.test(head) ? head.slice(0, -1) : head.trimEnd()}…`;
}

/** `text` with a trailing ask-label line cut, and its label. */
function cutLabel(text: string): { text: string; label?: string } {
  const match = LABEL.exec(text);
  if (match === null) return { text };
  const stripped = text.slice(0, match.index).trimEnd();
  const label = cleanLabel(match[1] ?? "");
  return label === undefined ? { text: stripped } : { text: stripped, label };
}

/** Where a token that has only partly arrived starts at the end of `text`, else -1: a trailing prefix of an opener (down to a lone `[`), or an opener with no `]]` or newline after it. */
function partialStart(text: string): number {
  let best = -1;
  for (const opener of OPENERS) {
    for (let length = Math.min(opener.length, text.length); length > 0; length -= 1) {
      if (text.endsWith(opener.slice(0, length))) {
        const start = text.length - length;
        if (best < 0 || start < best) best = start;
        break;
      }
    }
    const start = text.lastIndexOf(opener);
    if (start < 0) continue;
    const rest = text.slice(start + opener.length);
    if (!rest.includes("]]") && !rest.includes("\n") && (best < 0 || start < best)) best = start;
  }
  return best;
}

/**
 * Splits the replies token off the end of a reply. `replies` is set when the token leaves two or
 * more answers; a token with fewer is still cut from the text. A token in mid-text is left alone.
 * An ask-label line right before a cut token is cut too and comes back as `label`. While the reply
 * is `streaming`, a token or ask-label line that has only partly arrived is cut too, and so is a
 * whole ask-label line still waiting for its token, so no flicker of `[[rep` or the label shows.
 */
export function splitReplies(text: string, streaming: boolean): { text: string; replies?: string[]; label?: string } {
  const match = TOKEN.exec(text);
  if (match !== null) {
    const { text: stripped, label } = cutLabel(text.slice(0, match.index).trimEnd());
    const replies = answers(match[1] ?? "");
    return { text: stripped, ...(replies.length < 2 ? {} : { replies }), ...(label === undefined ? {} : { label }) };
  }
  if (!streaming) return { text };
  const start = partialStart(text);
  return { text: cutLabel(start < 0 ? text : text.slice(0, start).trimEnd()).text };
}
