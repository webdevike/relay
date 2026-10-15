/** Port of jobs.rs parse_duration: returns milliseconds or null when invalid. */
export function parseDurationMs(text: string): number | null {
  const m = /^(\d+)\s*(ms|s|m|h|d)?$/.exec(text.trim())
  if (!m) return null
  const n = Number(m[1])
  const mult: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }
  return n * mult[m[2] ?? 'm']!
}

function cleanValue(raw: string): string {
  let v = raw.trim()
  if (v.startsWith('"') || v.startsWith("'")) v = v.slice(1)
  if (v.endsWith('"') || v.endsWith("'")) v = v.slice(0, -1)
  return v
}

export function jobFrontmatter(text: string): Map<string, string> {
  const out = new Map<string, string>()
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text.replace(/\r\n/g, '\n'))
  if (!m) return out
  for (const line of m[1]!.split('\n')) {
    const i = line.indexOf(':')
    if (i < 0) continue
    const key = line.slice(0, i).trim()
    if (!/^[A-Za-z_][\w-]*$/.test(key)) continue
    if (!out.has(key)) out.set(key, cleanValue(line.slice(i + 1)))
  }
  return out
}

export function jobScheduled(text: string): boolean {
  const fm = jobFrontmatter(text)
  if (fm.get('enabled') === 'false') return false
  const every = fm.get('every')
  if (every === undefined) return false
  const ms = parseDurationMs(every)
  return ms !== null && ms > 0
}
