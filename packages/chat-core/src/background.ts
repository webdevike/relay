/**
 * Background messages: text a user-role row carries that Isaac did not type. Background jobs,
 * heartbeats, canvas notices and exchanges, Relay Assist handoffs and tapbacks all arrive in the
 * thread as user turns; the chat shows them as quiet rows instead of a bubble.
 */

export type BackgroundIcon = 'robot' | 'board' | 'hand' | 'chat' | 'reaction'

/** One `[source] title (link)` line of a heartbeat. */
export interface HeartbeatItem {
  source: string
  title: string
  /** The trailing parenthesis: a link when it is a URL, otherwise a stamp or id. */
  meta: string | null
  link: string | null
}

export type BackgroundMessage =
  | {
      kind: 'event'
      icon: BackgroundIcon
      /** `Astra · auto-work ENG-6648 replied to a coworker`: one line, source first. */
      summary: string
      /** The whole text, shown in markdown when the row is opened. */
      text: string
    }
  | {
      kind: 'heartbeat'
      from: string
      count: number
      /** Items per source, in order of first appearance. */
      sources: { source: string; count: number }[]
      items: HeartbeatItem[]
      text: string
    }

const MAX_SUMMARY = 160

/** The first sentence or line of `text`, on one line and not longer than a row can use. */
export function firstSentence(text: string): string {
  const line = text.trim().split('\n', 1)[0] ?? ''
  const cut = /^(.*?[.!?])(?:\s|$)/.exec(line)?.[1] ?? line
  const one = cut.replace(/\s+/g, ' ').trim().replace(/[.]$/, '')
  return one.length > MAX_SUMMARY ? `${one.slice(0, MAX_SUMMARY - 1).trimEnd()}…` : one
}

const JOBS = /^\[From (.+?)'s background jobs\]\s*/
const HEARTBEAT = /^Heartbeat:\s*(\d+)\s+new\.?/i
const ITEM = /^\[([^\]\s]+)\]\s+(.+)$/
const STARTED = /^Live canvas started on "(.+?)"/
const WRAP_UP = /^Canvas "(.+?)" wrap-up:\s*(.*)/s
const EXCHANGE = /^Canvas "(.+?)" · ([^:\n]+):\s*(.*)/s
const REQUEST = /^\[Canvas request from ([^\]]+)\]\s*(.*)/s
const HANDOFF = /^\[Relay Assist handoff\]\s*(.*)/s
const REACTED = /^\[(\S+) reacted (.+?) to your message:\s*"(.*?)"\]/s
/** Another assistant put the human's question to this one (the Relay host's consult). */
const ASKED = /^\[Asked by (.+?) in [^\]]+?'s chat\]\s*(.*)/s

function parseItem(line: string): HeartbeatItem | null {
  const m = ITEM.exec(line.trim())
  if (!m) return null
  const source = m[1]!
  let title = m[2]!
  let meta: string | null = null
  const tail = /^(.*\S)\s+\(([^()]+)\)$/.exec(title)
  if (tail) {
    title = tail[1]!
    meta = tail[2]!
  }
  const link = meta !== null && /^https?:\/\/\S+$/.test(meta) ? meta : null
  return { source, title, meta, link }
}

function heartbeat(from: string, rest: string, text: string): BackgroundMessage | null {
  const head = HEARTBEAT.exec(rest)
  if (!head) return null
  const items = rest
    .slice(head[0].length)
    .split('\n')
    .map(parseItem)
    .filter((i): i is HeartbeatItem => i !== null)
  const counts = new Map<string, number>()
  for (const i of items) counts.set(i.source, (counts.get(i.source) ?? 0) + 1)
  return {
    kind: 'heartbeat',
    from,
    count: Number(head[1]),
    sources: [...counts].map(([source, count]) => ({ source, count })),
    items,
    text,
  }
}

const event = (icon: BackgroundIcon, summary: string, text: string): BackgroundMessage => ({
  kind: 'event',
  icon,
  summary,
  text,
})

/** The leading `Source · ` of a summary, when the sentence has anything to say after it. */
const said = (source: string, sentence: string): string =>
  sentence === '' ? source : `${source} · ${sentence}`

/** What a user-role row's text is when it is a background message; null for what Isaac typed. */
export function parseBackground(raw: string): BackgroundMessage | null {
  const text = raw.trim()
  if (text === '') return null
  const jobs = JOBS.exec(text)
  if (jobs) {
    const from = jobs[1]!
    const rest = text.slice(jobs[0].length)
    const beat = heartbeat(from, rest, text)
    if (beat) return beat
    const handoff = HANDOFF.exec(rest)
    if (handoff) return event('hand', said('Relay Assist', firstSentence(handoff[1]!)), text)
    return event('robot', said(from, firstSentence(rest)), text)
  }
  const started = STARTED.exec(text)
  if (started) return event('board', `Canvas · started "${started[1]}"`, text)
  const wrap = WRAP_UP.exec(text)
  if (wrap)
    return event('board', said(`Canvas "${wrap[1]}" wrap-up`, firstSentence(wrap[2]!)), text)
  const exchange = EXCHANGE.exec(text)
  if (exchange) {
    return event(
      'chat',
      said(`Canvas "${exchange[1]}" · ${exchange[2]}`, firstSentence(exchange[3]!)),
      text,
    )
  }
  const request = REQUEST.exec(text)
  if (request) {
    return event(
      'board',
      said(`Canvas request from ${request[1]}`, firstSentence(request[2]!)),
      text,
    )
  }
  const handoff = HANDOFF.exec(text)
  if (handoff) return event('hand', said('Relay Assist', firstSentence(handoff[1]!)), text)
  const asked = ASKED.exec(text)
  if (asked) return event('chat', said(`${asked[1]} asked`, firstSentence(asked[2]!)), text)
  const reacted = REACTED.exec(text)
  if (reacted) {
    return event(
      'reaction',
      `${reacted[1]} reacted ${reacted[2]} to "${firstSentence(reacted[3]!)}"`,
      text,
    )
  }
  return null
}
