import { daysBetween } from './dates'
import type { JournalEntry } from './journal'
import { displayName, plain, tagline } from './plain'

export interface ThreadNote {
  date: string
  text: string
}
export interface Section {
  title: string
  body: string
}
/** `path` is relative to the Eva root, e.g. workspaces/flo.md; null for the built-in Eva workspace. */
export interface WorkspaceFile {
  id: string
  path: string | null
  text: string
}
export interface Workspace {
  id: string
  name: string
  displayName: string
  tagline: string | null
  sections: Section[]
  notes: ThreadNote[]
  activity: string[]
  lastActive: string | null
  latest: string | null
  openTodos: number
  builtIn: boolean
  path: string | null
}
export interface TimelineItem {
  date: string
  kind: 'journal' | 'thread'
  title: string
  source: string
}

/** eva.rs EVA_WORKSPACE. */
export const EVA_BUILTIN_TEXT =
  "# Eva\n\nEva's own hub: identity, workflows, memory, jobs, and apps like EvaOS.\n"

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/

const desc = (a: string, b: string): number => (a < b ? 1 : a > b ? -1 : 0)

/** Eva's own work is tagged [eva] but has no workspace file; give it one. */
export function withBuiltIn(files: WorkspaceFile[]): WorkspaceFile[] {
  if (files.some((f) => f.id === 'eva')) return files
  return [...files, { id: 'eva', path: null, text: EVA_BUILTIN_TEXT }]
}

/** Port of eva.rs threads_section plus the note parse in workspace_from. */
function parseNotes(lines: string[]): ThreadNote[] {
  const start = lines.findIndex((l) => l.trim() === '## Threads')
  if (start < 0) return []
  const notes: ThreadNote[] = []
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('## ')) break
    if (!line.startsWith('- ')) continue
    const rest = line.slice(2)
    const date = rest.slice(0, 10)
    if (!DAY_RE.test(date)) continue
    notes.push({ date, text: plain(rest.slice(10).replace(/^[/: —-]+/, '')) })
  }
  return notes.sort((a, b) => desc(a.date, b.date))
}

/** Headings with their bodies. Rust kept only headings; the page needs bodies too. */
function parseSections(lines: string[]): Section[] {
  const sections: Section[] = []
  let current: { title: string; body: string[] } | null = null
  const flush = (): void => {
    if (!current) return
    const body = [...current.body]
    while (body.length > 0 && body[body.length - 1]!.trim() === '') body.pop()
    sections.push({ title: current.title, body: body.join('\n') })
  }
  for (const line of lines) {
    if (line.startsWith('## ')) {
      flush()
      current = { title: plain(line.slice(3)), body: [] }
    } else {
      current?.body.push(line)
    }
  }
  flush()
  return sections
}

/** Port of eva.rs workspace_from. `openTags` holds the canonical tag of every open todo. */
export function workspaceFrom(
  file: WorkspaceFile,
  journal: JournalEntry[],
  openTags: string[],
): Workspace {
  const lines = file.text.split(/\r?\n/)
  const h1 = lines.find((l) => l.startsWith('# '))
  const name = h1 ? h1.slice(2).trim() : file.id
  const notes = parseNotes(lines)
  const entries = journal.filter((e) => e.tag === file.id).sort((a, b) => desc(a.date, b.date))
  const activity = [...notes.map((n) => n.date), ...entries.map((e) => e.date)].sort(desc)
  const newestEntry = entries[0]
  const newestNote = notes[0]
  let latest: string | null = null
  if (newestEntry && newestNote)
    latest = newestEntry.date >= newestNote.date ? newestEntry.title : newestNote.text
  else if (newestNote) latest = newestNote.text
  else if (newestEntry) latest = newestEntry.title
  const tag = tagline(file.text)
  return {
    id: file.id,
    name,
    displayName: h1 ? displayName(h1.slice(2)) || file.id : file.id,
    tagline: tag === '' ? null : tag,
    sections: parseSections(lines),
    notes,
    activity,
    lastActive: activity[0] ?? null,
    latest,
    openTodos: openTags.filter((t) => t === file.id).length,
    builtIn: file.path === null,
    path: file.path,
  }
}

/** Most recent activity first (none last), then display name (byte order, as Rust). */
export function sortWorkspaces<T extends Pick<Workspace, 'lastActive' | 'displayName'>>(
  list: T[],
): T[] {
  return [...list].sort((a, b) => {
    if (a.lastActive !== b.lastActive) {
      if (a.lastActive === null) return 1
      if (b.lastActive === null) return -1
      return desc(a.lastActive, b.lastActive)
    }
    return a.displayName < b.displayName ? -1 : a.displayName > b.displayName ? 1 : 0
  })
}

/** Port of Workspace::daily_activity: counts per day ending `today`, oldest first. */
export function dailyActivity(activity: string[], today: string, days: number): number[] {
  const counts = new Array<number>(days).fill(0)
  for (const date of activity) {
    const age = daysBetween(date, today)
    if (age >= 0 && age < days) counts[days - 1 - age]!++
  }
  return counts
}

/** Port of workspace.rs timeline: journal entries and thread notes, newest first, journal first within a day. */
export function timeline(
  ws: Pick<Workspace, 'id' | 'notes'>,
  journal: JournalEntry[],
): TimelineItem[] {
  const items: TimelineItem[] = [
    ...journal
      .filter((e) => e.tag === ws.id)
      .map((e): TimelineItem => ({
        date: e.date,
        kind: 'journal',
        title: e.title,
        source: e.file,
      })),
    ...ws.notes.map((n): TimelineItem => ({
      date: n.date,
      kind: 'thread',
      title: n.text,
      source: 'Threads',
    })),
  ]
  return items.sort((a, b) => desc(a.date, b.date))
}
