import { parseDay } from './dates'
import { plain } from './plain'
import { canonicalTag } from './tags'

export interface JournalEntry {
  date: string
  tag: string
  title: string
  body: string[]
  /** Path relative to the Eva root, e.g. memory/journal.md */
  file: string
}

/** Port of eva.rs parse_journal_heading: `## 2026-08-19 (cont2) - [eva] Title`. */
export function parseJournalHeading(line: string, file: string): JournalEntry | null {
  if (!line.startsWith('## ')) return null
  const rest = line.slice(3)
  const date = rest.slice(0, 10)
  if (parseDay(date) === null) return null
  const open = rest.indexOf('[')
  if (open < 0) return null
  const close = rest.indexOf(']', open)
  if (close < 0) return null
  return {
    date,
    tag: canonicalTag(rest.slice(open + 1, close)),
    title: plain(rest.slice(close + 1)),
    body: [],
    file,
  }
}

/** Port of eva.rs parse_journal: every tagged entry with the top-level bullets under it. */
export function parseJournal(text: string, file: string): JournalEntry[] {
  const entries: JournalEntry[] = []
  let inEntry = false
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('## ')) {
      const entry = parseJournalHeading(line, file)
      if (entry) {
        entries.push(entry)
        inEntry = true
      } else {
        inEntry = false
      }
    } else if (inEntry && line.startsWith('- ')) {
      entries[entries.length - 1]!.body.push(plain(line.slice(2)))
    }
  }
  return entries
}

/** Newest first; stable. */
export function sortJournal(entries: JournalEntry[]): JournalEntry[] {
  return [...entries].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
}
