// Quick-open ranking: the fzy algorithm (github.com/jhawthorn/fzy, MIT) over a file's name and its
// path. A match inside the file name beats the same letters spread over folders, a consecutive run
// beats scattered letters, and a letter after `/`, `-`, `_`, `.` or a lower-to-upper change counts
// as a word start. Spaces split the query into pieces that must all match.

const GAP_LEADING = -0.005
const GAP_TRAILING = -0.005
const GAP_INNER = -0.01
const CONSECUTIVE = 1.0
const SLASH = 0.9
const WORD = 0.8
const CAPITAL = 0.7
const DOT = 0.6
/** A piece that matches inside the file name outranks one that needs the folders. */
const NAME_BONUS = 2
const MAX_LEN = 1024

export interface FuzzyMatch {
  score: number
  /** Matched character indexes into the scored path, ascending. */
  positions: number[]
}

function bonusAt(text: string, i: number): number {
  if (i === 0) return SLASH
  const prev = text[i - 1]!
  const ch = text[i]!
  if (prev === '/') return SLASH
  if (prev === '-' || prev === '_' || prev === ' ') return WORD
  if (prev === '.') return DOT
  if (prev >= 'a' && prev <= 'z' && ch >= 'A' && ch <= 'Z') return CAPITAL
  return 0
}

/** True when every query character appears in order (case-insensitive). */
function isSubsequence(q: string, t: string): boolean {
  let j = 0
  for (let i = 0; i < t.length && j < q.length; i++) if (t[i] === q[j]) j++
  return j === q.length
}

/** fzy's score and positions of `q` (lowercase) in `text`; null when it does not match. */
function fzy(q: string, text: string): FuzzyMatch | null {
  const lower = text.toLowerCase()
  if (!isSubsequence(q, lower)) return null
  const n = q.length
  const m = text.length
  if (n === m) return { score: Infinity, positions: [...Array(n).keys()] }
  if (m > MAX_LEN) return null
  const bonus = new Float64Array(m)
  for (let j = 0; j < m; j++) bonus[j] = bonusAt(text, j)
  // D[i][j]: best score ending with q[i] matched at text[j]; M[i][j]: best score of q[0..i] in text[0..j].
  const D = new Float64Array(n * m)
  const M = new Float64Array(n * m)
  for (let i = 0; i < n; i++) {
    let prevScore = -Infinity
    const gap = i === n - 1 ? GAP_TRAILING : GAP_INNER
    for (let j = 0; j < m; j++) {
      const k = i * m + j
      if (q[i] === lower[j]) {
        let score = -Infinity
        if (i === 0) score = j * GAP_LEADING + bonus[j]!
        else if (j > 0) {
          const pm = M[(i - 1) * m + j - 1]!
          const pd = D[(i - 1) * m + j - 1]!
          score = Math.max(pm + bonus[j]!, pd + CONSECUTIVE)
        }
        D[k] = score
        prevScore = Math.max(score, prevScore + gap)
        M[k] = prevScore
      } else {
        D[k] = -Infinity
        prevScore = prevScore + gap
        M[k] = prevScore
      }
    }
  }
  const positions = new Array<number>(n)
  let matchRequired = false
  for (let i = n - 1, j = m - 1; i >= 0; i--) {
    for (; j >= 0; j--) {
      const k = i * m + j
      if (D[k]! !== -Infinity && (matchRequired || D[k] === M[k])) {
        matchRequired = i > 0 && j > 0 && M[k] === D[(i - 1) * m + j - 1]! + CONSECUTIVE
        positions[i] = j
        j--
        break
      }
    }
  }
  return { score: M[(n - 1) * m + m - 1]!, positions }
}

/** Scores one piece against the path, preferring a match inside the file name. */
function scorePiece(piece: string, path: string, nameStart: number): FuzzyMatch | null {
  const inName = fzy(piece, path.slice(nameStart))
  if (inName) {
    return {
      score: (inName.score === Infinity ? 10 : inName.score) + NAME_BONUS,
      positions: inName.positions.map((p) => p + nameStart),
    }
  }
  const whole = fzy(piece, path)
  if (!whole) return null
  return { score: whole.score === Infinity ? 10 : whole.score, positions: whole.positions }
}

/** Scores `query` against a `/`-separated path; null when any piece fails to match. */
export function fuzzyScore(query: string, path: string): FuzzyMatch | null {
  const pieces = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (pieces.length === 0) return { score: 0, positions: [] }
  const nameStart = path.lastIndexOf('/') + 1
  let score = 0
  const positions = new Set<number>()
  for (const piece of pieces) {
    const m = scorePiece(piece, path, nameStart)
    if (!m) return null
    score += m.score
    for (const p of m.positions) positions.add(p)
  }
  return { score, positions: [...positions].sort((a, b) => a - b) }
}

export interface Ranked {
  path: string
  score: number
  positions: number[]
}

/**
 * The best `limit` paths for `query`, best first. Ties go to the shorter path, then the
 * alphabetical one. `boost` lifts recently opened files (higher is more recent).
 */
export function rankPaths(
  query: string,
  paths: readonly string[],
  limit: number,
  boost?: (path: string) => number,
): Ranked[] {
  const out: Ranked[] = []
  for (const path of paths) {
    const m = fuzzyScore(query, path)
    if (!m) continue
    out.push({ path, score: m.score + (boost?.(path) ?? 0), positions: m.positions })
  }
  out.sort(
    (a, b) => b.score - a.score || a.path.length - b.path.length || a.path.localeCompare(b.path),
  )
  return out.slice(0, limit)
}
/** `src/app.ts:42:7` gives the path query and where to jump. */
export function parseQuery(raw: string): { query: string; line?: number; column?: number } {
  const m = raw.trim().match(/^(.*?)(?::(\d+))?(?::(\d+))?$/)
  const query = (m?.[1] ?? raw).trim()
  const line = m?.[2] ? Number(m[2]) : undefined
  const column = m?.[3] ? Number(m[3]) : undefined
  return { query, line, column }
}
