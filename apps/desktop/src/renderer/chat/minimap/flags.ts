import { splitReplies } from '@evaos/chat-core/replies'

/** What a turn wants from Isaac: an answer to a question, or a look at something shipped. */
export type TurnFlag = 'ask' | 'shipped'

/** Protocol `untagged`: a leading `<surface>...</surface>` tag is the agent's, never shown. */
const LEADING_SURFACE = /^\s*<surface>[^<]*<\/surface>[\r\n]*/
const FENCE = /```[\s\S]*?(?:```|$)/g
/** Marks a reply may end on after its question mark: emphasis, quotes, brackets, emoji, spaces. */
const TRAILING = /(?:[\s*_~`"'’”)\]}>]|\p{Extended_Pictographic}|\u200d|\ufe0f)+$/u

/** `text` without its leading surface tag. */
export function untag(text: string): string {
  const tag = LEADING_SURFACE.exec(text)
  return tag === null ? text : text.slice(tag[0].length)
}

/**
 * One line of what a message reads like: surface tag, reply token and fenced code dropped, links
 * and emphasis flattened, whitespace collapsed, cut to `max` characters (with an ellipsis).
 */
export function plain(text: string, max = 280): string {
  // Work on a bounded head: a long reply is never scanned past what could show.
  const head = splitReplies(untag(text), false).text.slice(0, max * 4)
  const flat = head
    .replace(FENCE, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(?:#{1,6}|>|[-*+]|\d+\.)\s+/gm, '')
    .replace(/[*_~`]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat
}

/** True when the reply ends by asking Isaac something: tap-to-answer replies, or a last line ending in `?`. */
export function asksQuestion(text: string): boolean {
  const body = untag(text)
  if (splitReplies(body, false).replies !== undefined) return true
  const prose = body.replace(FENCE, '\n').trimEnd()
  const lastLine = prose.slice(prose.lastIndexOf('\n') + 1)
  const end = lastLine.replace(TRAILING, '')
  if (!/[?？]$/.test(end)) return false
  // A bare URL with a query string is not a question.
  return !/:\/\/\S*\?$/.test(end)
}

/** Phrases that announce something done or ready, each with the words before it that cancel it. */
const SHIPPED: readonly RegExp[] = [
  /\b(?:is|are|now|it's|it’s|went|goes) live\b/gi,
  /\bshipped\b/gi,
  /\bdeployed\b/gi,
  /\brestart\b/gi,
  /\bready to (?:try|test|use|review|check|merge|go)\b/gi,
  /\b(?:is|are|now|it's|it’s) ready\b/gi,
]
/** A link Isaac would open to try what shipped. */
const SHIP_LINK =
  /https?:\/\/\S*(?:deploy|update|release|preview|testflight|workers\.dev|pages\.dev)\S*/i
/** Words just before a phrase that make it a plan or a condition, not an announcement. */
const NOT_YET =
  /(?:\bnot|n['’]t|\bnever|\buntil|\bonce|\bif|\bwhen|\bbefore|\bwait for|\bwill|\bll)\s+(?:\w+\s+)?$/i

/** True when the reply says something shipped or is ready to try (plans and negations excepted). */
export function announcesShipped(text: string): boolean {
  const body = untag(text).replace(FENCE, ' ')
  if (SHIP_LINK.test(body)) return true
  for (const re of SHIPPED) {
    re.lastIndex = 0
    for (let m = re.exec(body); m !== null; m = re.exec(body)) {
      if (!NOT_YET.test(body.slice(Math.max(0, m.index - 24), m.index))) return true
    }
  }
  return false
}

/** What one reply asks and announces, by what it says alone. */
export function replyFlags(text: string): { ask: boolean; shipped: boolean } {
  return { ask: asksQuestion(text), shipped: announcesShipped(text) }
}
