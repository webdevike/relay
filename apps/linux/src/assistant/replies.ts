// Tap-to-answer replies: an assistant thread may end a reply that asks Isaac something with a few
// clear answers on `[[replies: Yes, push it | Not yet]]`. The host cuts the token from the text and
// hands the answers to the phone as `AssistantMessage.replies`, which shows them as buttons under the
// newest bubble; a tap sends that label as Isaac's next message. Nothing is sent without a tap.

/** Most answers a reply carries; later ones are dropped. */
export const MAX_REPLIES = 4;
/** Longest answer, in characters; a longer one is dropped. */
export const MAX_REPLY_CHARS = 24;

/** The token an assistant ends a reply with. Answers are split on `|` and never hold `]` or a newline. */
const TOKEN = /[ \t\r\n]*\[\[replies:([^\]\n]*)\]\][ \t\r\n]*$/;
const OPENER = "[[replies:";

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

/**
 * Splits the replies token off the end of a reply. `replies` is set when the token leaves two or
 * more answers; a token with fewer is still cut from the text. A token in mid-text is left alone.
 * While the reply is `streaming`, a token that has only partly arrived is cut too, so no flicker of
 * `[[rep` shows.
 */
export function splitReplies(text: string, streaming: boolean): { text: string; replies?: string[] } {
  const match = TOKEN.exec(text);
  if (match !== null) {
    const stripped = text.slice(0, match.index).trimEnd();
    const replies = answers(match[1] ?? "");
    return replies.length < 2 ? { text: stripped } : { text: stripped, replies };
  }
  if (!streaming) return { text };
  // The longest end of the text that starts the opener (`[`, `[[`, `[[rep`, ...).
  for (let length = Math.min(OPENER.length, text.length); length > 0; length -= 1) {
    if (text.endsWith(OPENER.slice(0, length))) return { text: text.slice(0, text.length - length).trimEnd() };
  }
  // An opener whose answers are still arriving: no closing `]]` and no newline after it yet.
  const start = text.lastIndexOf(OPENER);
  if (start < 0) return { text };
  const rest = text.slice(start + OPENER.length);
  return rest.includes("]]") || rest.includes("\n") ? { text } : { text: text.slice(0, start).trimEnd() };
}
