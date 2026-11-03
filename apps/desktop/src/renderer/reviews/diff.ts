// Unified diffs (`gh pr diff`, a commit's `patch`) as files, hunks and split-view rows.

export interface DiffLine {
  kind: 'ctx' | 'add' | 'del'
  text: string
  /** Line number on the old side (ctx, del) and the new side (ctx, add). */
  old: number | null
  new: number | null
}

export interface Hunk {
  header: string
  /** Old-side lines skipped before this hunk (the "N unchanged lines" divider). */
  skipped: number
  lines: DiffLine[]
}

export interface DiffFile {
  path: string
  hunks: Hunk[]
  binary: boolean
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/

/** Hunks of one file's patch (lines from the first `@@`). */
export function parseHunks(patch: string): Hunk[] {
  const hunks: Hunk[] = []
  let cur: Hunk | null = null
  let oldN = 0
  let newN = 0
  let lastOld = 0
  for (const line of patch.split('\n')) {
    const m = HUNK.exec(line)
    if (m) {
      const start = Number(m[1])
      cur = { header: line, skipped: Math.max(0, start - 1 - lastOld), lines: [] }
      hunks.push(cur)
      oldN = start
      newN = Number(m[2])
      continue
    }
    if (!cur) continue
    const sign = line[0]
    const text = line.slice(1)
    if (sign === '+') cur.lines.push({ kind: 'add', text, old: null, new: newN++ })
    else if (sign === '-') cur.lines.push({ kind: 'del', text, old: oldN++, new: null })
    else if (sign === ' ') cur.lines.push({ kind: 'ctx', text, old: oldN++, new: newN++ })
    // `\ No newline at end of file` and the trailing empty split are not lines.
    lastOld = oldN - 1
  }
  return hunks
}

/** Every file of a `git diff` / `gh pr diff` output, in order. */
export function parseDiff(text: string): DiffFile[] {
  const files: DiffFile[] = []
  const chunks = text.split(/^diff --git /m).slice(1)
  for (const chunk of chunks) {
    const head = chunk.split('\n', 1)[0] ?? ''
    const plus = /^\+\+\+ b\/(.+)$/m.exec(chunk)
    const fallback = / b\/(.+)$/.exec(head)
    const path = plus?.[1] ?? fallback?.[1] ?? head
    const at = chunk.search(/^@@ /m)
    files.push({
      path,
      hunks: at < 0 ? [] : parseHunks(chunk.slice(at)),
      binary: /^Binary files /m.test(chunk),
    })
  }
  return files
}

export interface SplitRow {
  left: DiffLine | null
  right: DiffLine | null
}

/** Side-by-side rows: context on both sides, a run of deletions paired with the additions after it. */
export function splitRows(lines: readonly DiffLine[]): SplitRow[] {
  const rows: SplitRow[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    if (line.kind === 'ctx') {
      rows.push({ left: line, right: line })
      i++
      continue
    }
    const dels: DiffLine[] = []
    const adds: DiffLine[] = []
    while (i < lines.length && lines[i]!.kind === 'del') dels.push(lines[i++]!)
    while (i < lines.length && lines[i]!.kind === 'add') adds.push(lines[i++]!)
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) {
      rows.push({ left: dels[k] ?? null, right: adds[k] ?? null })
    }
  }
  return rows
}

/** `src/routes/get-tags.route.ts` as its folder (with the trailing slash) and name. */
export function splitPath(path: string): { dir: string; name: string } {
  const at = path.lastIndexOf('/')
  return at < 0 ? { dir: '', name: path } : { dir: path.slice(0, at + 1), name: path.slice(at + 1) }
}
