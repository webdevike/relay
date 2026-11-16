/**
 * Background messages: text a user-role row carries that Isaac did not type. Background jobs,
 * heartbeats, canvas notices and exchanges, Relay Assist handoffs and tapbacks all arrive in the
 * thread as user turns; the chat shows them as quiet rows instead of a bubble.
 */

export type BackgroundIcon = 'robot' | 'board' | 'hand' | 'chat' | 'reaction' | 'pointer'

/** One `[source] title (link)` line of a heartbeat. */
export interface HeartbeatItem {
  source: string
  title: string
  /** The trailing parenthesis: a link when it is a URL, otherwise a stamp or id. */
  meta: string | null
  link: string | null
}

/** Isaac's comment on lines of a file (the Files editor's Comment): what the row shows. */
export interface FileComment {
  /** The file relative to the Files root it was open under. */
  rel: string
  /** The file, absolute on the Mac. */
  path: string
  start: number
  end: number
  /** The code he selected. */
  code: string
  /** The fence's language, '' when none. */
  language: string
  /** `relay://open/files?...`: the file open in Files with the lines selected. */
  link: string
}

export type BackgroundMessage =
  | {
      kind: 'event'
      icon: BackgroundIcon
      /** `Astra · auto-work ENG-6648 replied to a coworker`: one line, source first. */
      summary: string
      /** The whole text, shown in markdown when the row is opened. */
      text: string
      /** What the message points at (a selection chip: `div.card:nth-of-type(5)`), when it does. */
      chip?: string
      /** A comment Isaac left on a page or board: where it was and what he said (an inline row). */
      comment?: { place: string; note: string }
      /** A comment on lines of a file in Files: the file, the lines, the code and the way back. */
      file?: FileComment
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
/** A page note or a Design Mode change (noteText's header line, then Isaac's words). */
const PAGE_NOTE =
  /^\[(Change request|Note) on web page \S+ "((?:[^"\\]|\\.)*)": ([^\n]*?)(?: \(and (\d+) more below\))?\]\n(.*)/s
/** A comment on a canvas board (noteText's header line, then Isaac's words). */
const CANVAS_COMMENT =
  /^\[(?:Comment|Reply in comment thread) \S+ on board (?:"((?:[^"\\]|\\.)*)"[^\n]*|(\S+),[^\n]*)\]\n(.*)/s
/** A comment on lines of a file in Files (noteText's header line, then Isaac's words, the code, the link). */
const FILE_COMMENT =
  /^\[Comment on file ("(?:[^"\\]|\\.)*") at ("(?:[^"\\]|\\.)*"), lines? (\d+)(?:-(\d+))?\]\n/
const FILE_LINK = /^relay:\/\/open\/files\?\S+$/

/**
 * A Files comment's parts. The code fence is longer than any backtick run in the code, so the
 * opening fence is the nearest line above the closing one that starts with it.
 */
function fileComment(text: string): { note: string; file: FileComment } | null {
  const head = FILE_COMMENT.exec(text)
  if (!head) return null
  const lines = text.slice(head[0].length).split('\n')
  let at = lines.length - 1
  while (at >= 0 && !FILE_LINK.test(lines[at]!.trim())) at--
  const close = lines[at - 1]?.trim() ?? ''
  if (at < 2 || !/^`{3,}$/.test(close)) return null
  let open = at - 2
  while (open >= 0 && !lines[open]!.startsWith(close)) open--
  if (open < 0) return null
  const start = Number(head[3])
  return {
    note: lines.slice(0, open).join('\n').trim(),
    file: {
      rel: unquote(head[1]!.slice(1, -1)),
      path: unquote(head[2]!.slice(1, -1)),
      start,
      end: head[4] === undefined ? start : Number(head[4]),
      code: lines.slice(open + 1, at - 1).join('\n'),
      language: lines[open]!.slice(close.length).trim(),
      link: lines[at]!.trim(),
    },
  }
}

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

const event = (
  icon: BackgroundIcon,
  summary: string,
  text: string,
  chip?: string,
  comment?: { place: string; note: string },
  file?: FileComment,
): BackgroundMessage => ({
  kind: 'event',
  icon,
  summary,
  text,
  ...(chip ? { chip } : {}),
  ...(comment ? { comment } : {}),
  ...(file ? { file } : {}),
})

/** The text of a JSON string literal the header quoted (a title), as is when it isn't one. */
function unquote(literal: string): string {
  try {
    const v: unknown = JSON.parse(`"${literal}"`)
    return typeof v === 'string' ? v : literal
  } catch {
    return literal
  }
}

/** `<div>, selector "#grid > div.card:nth-of-type(5)" (and 2 more below)` as a chip: `div.card:nth-of-type(5) +2`. */
function targetChip(target: string, more: string | undefined): string {
  const tag = /^<([a-z0-9-]+)>/i.exec(target)?.[1]
  let step = tag ?? 'region'
  const sel = /selector ("(?:[^"\\]|\\.)*")/.exec(target)?.[1]
  if (sel !== undefined) {
    try {
      const path = JSON.parse(sel) as string
      step = path.split(/\s*>+\s*/).at(-1) || step
    } catch {
      /* keep the tag */
    }
  }
  return more ? `${step} +${more}` : step
}

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
  const onFile = fileComment(text)
  if (onFile) {
    const { note, file } = onFile
    const name = file.rel.split('/').at(-1) ?? file.rel
    const lines = file.end > file.start ? `${file.start}-${file.end}` : String(file.start)
    return event(
      'pointer',
      said('File comment', firstSentence(note)),
      text,
      `${name}:${lines}`,
      { place: file.rel, note: note.replace(/\s+/g, ' ') },
      file,
    )
  }
  const page = PAGE_NOTE.exec(text)
  if (page) {
    const change = page[1] === 'Change request'
    const note = firstSentence(page[5]!)
    return event(
      'pointer',
      said(change ? 'Design Mode' : 'Page note', note),
      text,
      targetChip(page[3]!, page[4]),
      { place: unquote(page[2]!), note },
    )
  }
  const comment = CANVAS_COMMENT.exec(text)
  if (comment) {
    const note = firstSentence(comment[3]!)
    const card = /, card (?:"((?:[^"\\]|\\.)*)" )?\(([^)]*)\)\]$/.exec(text.split('\n', 1)[0]!)
    const on = card ? unquote(card[1] ?? card[2]!) : undefined
    return event('board', said('Canvas comment', note), text, on, {
      place: comment[1] === undefined ? comment[2]! : unquote(comment[1]),
      note,
    })
  }
  return null
}
