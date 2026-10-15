// MeetingTranscriber protocol notes parser, ported from meetings.rs parse_protocol. Pure.
export interface TranscriptLine {
  time: string
  speaker: string | null
  text: string
}
export interface Protocol {
  attendees: string[]
  attendeesSource: string | null
  summary: string[]
  decisions: string[]
  questions: string[]
  transcript: TranscriptLine[]
}

const plain = (s: string): string => s.replaceAll('**', '')

function bullet(items: string[], line: string): void {
  if (line === '') return
  const m = /^[-*] (.*)$/.exec(line)
  if (m) items.push(plain(m[1]!.trim()))
  else if (items.length > 0) items[items.length - 1] += ` ${plain(line)}`
}

function attendeesOf(line: string): { names: string[]; source: string | null } {
  let rest = line.trim()
  let source: string | null = null
  if (rest.endsWith(')')) {
    const inner = rest.slice(0, -1)
    const open = inner.lastIndexOf('(')
    if (open >= 0 && inner.slice(open + 1).includes(':')) {
      source = inner.slice(open + 1).trim()
      rest = inner.slice(0, open).trimEnd()
    }
  }
  return {
    names: rest.split(',').map((n) => n.trim()).filter((n) => n !== ''),
    source,
  }
}

function isSpeaker(who: string): boolean {
  const w = who.trim()
  return (
    w !== '' &&
    [...w].length <= 40 &&
    w.split(/\s+/).length <= 4 &&
    !/[.?!,"[\]]/.test(w)
  )
}

function transcriptLine(line: string): TranscriptLine | null {
  if (!line.startsWith('[')) return null
  const close = line.indexOf(']')
  if (close < 0) return null
  const time = line.slice(1, close)
  if (time === '' || !/^[0-9:]+$/.test(time)) return null
  const rest = line.slice(close + 1).trim()
  const colon = rest.indexOf(':')
  if (colon >= 0) {
    const who = rest.slice(0, colon)
    const said = rest.slice(colon + 1)
    if (isSpeaker(who) && (said === '' || said.startsWith(' '))) {
      return { time, speaker: who.trim(), text: said.trim() }
    }
  }
  return { time, speaker: null, text: rest }
}

/** Parses Summary, Attendees, Decisions, Open Questions and Full Transcript; missing parts stay empty. */
export function parseProtocol(text: string): Protocol {
  const p: Protocol = {
    attendees: [],
    attendeesSource: null,
    summary: [],
    decisions: [],
    questions: [],
    transcript: [],
  }
  let section = ''
  let open = false
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd()
    if (line.startsWith('## ')) {
      section = line.slice(3).trim().toLowerCase()
      continue
    }
    if (line.startsWith('# ') || line.trim() === '---') continue
    const trimmedStart = line.trimStart()
    if (trimmedStart.startsWith('**Attendees:**')) {
      const a = attendeesOf(trimmedStart.slice('**Attendees:**'.length))
      p.attendees = a.names
      p.attendeesSource = a.source
      continue
    }
    const t = line.trim()
    switch (section) {
      case 'summary':
        if (t === '') open = false
        else if (open) p.summary[p.summary.length - 1] += ` ${plain(t)}`
        else {
          p.summary.push(plain(t))
          open = true
        }
        break
      case 'decisions':
        bullet(p.decisions, t)
        break
      case 'open questions':
        bullet(p.questions, t)
        break
      case 'full transcript': {
        if (t === '') break
        const l = transcriptLine(t)
        if (l) p.transcript.push(l)
        else if (p.transcript.length > 0) p.transcript[p.transcript.length - 1]!.text += ` ${t}`
        break
      }
      default:
    }
  }
  return p
}
