// Tap-to-answer replies: an assistant reply that asks Isaac something with a few clear answers may
// end on one last line `[[replies: Yes, push it | Not yet]]`. The chat shows the reply without the
// token and the answers as buttons under the newest bubble; a tap sends that label as Isaac's next
// message. Nothing is sent without a tap. A port of the Relay Host's parser
// (work/relay apps/linux/src/assistant/replies.ts): the desktop reads omp's session files itself.

/** Most answers a reply carries; later ones are dropped. */
export const MAX_REPLIES = 4
/** Longest answer, in characters; a longer one is dropped. */
export const MAX_REPLY_CHARS = 24

/** The token a reply ends with. Answers are split on `|` and never hold `]` or a newline. */
const TOKEN = /[ \t\r\n]*\[\[replies:([^\]\n]*)\]\][ \t\r\n]*$/
const OPENER = '[[replies:'

/** The token's answers: trimmed, inner whitespace collapsed, empty and too-long ones dropped,
 * deduped case-insensitively keeping the first, at most `MAX_REPLIES`. */
function answers(body: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const part of body.split('|')) {
    const label = part.trim().replace(/\s+/g, ' ')
    if (label === '' || label.length > MAX_REPLY_CHARS) continue
    const key = label.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(label)
    if (out.length === MAX_REPLIES) break
  }
  return out
}

/** Where a token that has only partly arrived starts at the end of `text`, else -1: a trailing
 * prefix of `[[replies:` (down to a lone `[`), or `[[replies:` with no `]]` or newline after it. */
function partialStart(text: string): number {
  for (let n = Math.min(OPENER.length, text.length); n > 0; n--) {
    if (text.endsWith(OPENER.slice(0, n))) return text.length - n
  }
  const start = text.lastIndexOf(OPENER)
  if (start < 0) return -1
  const rest = text.slice(start + OPENER.length)
  return rest.includes(']]') || rest.includes('\n') ? -1 : start
}

/**
 * Splits the replies token off the end of a reply. `replies` is set when the token leaves two or
 * more answers; a token with fewer is still cut from the text. A token in mid-text is left alone.
 * While the reply is `streaming`, a token that has only partly arrived is cut too, so `[[rep`
 * never flickers in. The text is trimmed at the end whenever something was cut.
 */
export function splitReplies(
  text: string,
  streaming: boolean,
): { text: string; replies?: string[] } {
  const match = TOKEN.exec(text)
  if (match !== null) {
    const stripped = text.slice(0, match.index).trimEnd()
    const replies = answers(match[1] ?? '')
    return replies.length < 2 ? { text: stripped } : { text: stripped, replies }
  }
  if (!streaming) return { text }
  const start = partialStart(text)
  return start < 0 ? { text } : { text: text.slice(0, start).trimEnd() }
}
