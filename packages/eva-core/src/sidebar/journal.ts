export interface RecentEntry {
  date: string
  tag: string | null
  title: string
}

const HEADING = /^## (\d{4}-\d{2}-\d{2})(?: \[([^\]]+)\])? (.*)$/

/** Journal headings, newest (last in file) first, capped. Digest is excluded by the date pattern. */
export function recentJournal(text: string, cap = 8): RecentEntry[] {
  const all: RecentEntry[] = []
  for (const line of text.split('\n')) {
    const m = HEADING.exec(line.trimEnd())
    if (m) all.push({ date: m[1]!, tag: m[2] ?? null, title: m[3]!.trim() })
  }
  return all.reverse().slice(0, cap)
}
