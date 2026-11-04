// Line diffs for live file presence: the host derives which lines an agent's edit changed (to
// show its caret and a highlight there), and Relay desktop applies an edit to an open buffer in
// place and merges it with unsaved typing (a line-based three-way merge, like diff3). Pure, no
// dependencies, shared by the host and the desktop renderer (`@relay/protocol/text-diff`).

/** Base lines `[baseStart, baseEnd)` (0-based) became `lines`. An empty base range is an insertion. */
export interface Hunk {
  readonly baseStart: number;
  readonly baseEnd: number;
  readonly lines: readonly string[];
}

/** 1-based, inclusive lines of the new text an edit touched; a pure deletion marks the line after the cut. */
export interface LineRange {
  readonly startLine: number;
  readonly endLine: number;
}

/** Edits beyond which a diff stops looking for matches (the trace grows with its square). */
const MAX_DISTANCE = 2000;

/**
 * Myers' O(ND) diff over lines (`text.split("\n")`, which `join("\n")` rebuilds exactly: a `\r`
 * stays on its line): the hunks that turn `a` into `b`, in order, never overlapping. Common
 * prefix and suffix are trimmed first so the usual small edit to a large file stays cheap.
 */
export function diffLines(a: readonly string[], b: readonly string[]): Hunk[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const n = endA - start;
  const m = endB - start;
  if (n === 0 && m === 0) return [];
  if (n === 0 || m === 0) return [{ baseStart: start, baseEnd: endA, lines: b.slice(start, endB) }];

  // Forward Myers keeping, per D, the part of V that round can read (diagonals -D..D), then a
  // backtrack into matched pairs. Past MAX_DISTANCE edits the middle counts as one rewrite.
  const max = n + m;
  const offset = max;
  const v = new Int32Array(2 * max + 2);
  const trace: Int32Array[] = [];
  let found = false;
  for (let d = 0; d <= Math.min(max, MAX_DISTANCE) && !found; d++) {
    trace.push(v.slice(offset - d, offset + d + 1));
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && (v[offset + k - 1] ?? 0) < (v[offset + k + 1] ?? 0))) x = v[offset + k + 1] ?? 0;
      else x = (v[offset + k - 1] ?? 0) + 1;
      let y = x - k;
      while (x < n && y < m && a[start + x] === b[start + y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = true;
        break;
      }
    }
  }
  if (!found) return [{ baseStart: start, baseEnd: endA, lines: b.slice(start, endB) }];
  const matches: Array<[number, number]> = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0 && (x > 0 || y > 0); d--) {
    // trace[d] holds diagonals -d..d at indexes 0..2d.
    const row = trace[d] as Int32Array;
    const k = x - y;
    let prevK: number;
    if (k === -d || (k !== d && (row[k - 1 + d] ?? 0) < (row[k + 1 + d] ?? 0))) prevK = k + 1;
    else prevK = k - 1;
    const prevX = row[prevK + d] ?? 0;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x--;
      y--;
      matches.push([x, y]);
    }
    if (d > 0) {
      x = prevX;
      y = prevY;
    }
  }
  matches.reverse();
  const hunks: Hunk[] = [];
  let ai = 0;
  let bi = 0;
  for (const [mx, my] of [...matches, [n, m] as [number, number]]) {
    if (mx > ai || my > bi) hunks.push({ baseStart: start + ai, baseEnd: start + mx, lines: b.slice(start + bi, start + my) });
    ai = mx + 1;
    bi = my + 1;
  }
  return hunks;
}

/** The lines of `after` each hunk of `before -> after` touched, 1-based; deletions mark the line now at the cut. */
export function changedRanges(before: string, after: string): LineRange[] {
  const next = after.split("\n");
  const hunks = diffLines(before.split("\n"), next);
  const count = next.length;
  const ranges: LineRange[] = [];
  let shift = 0;
  for (const h of hunks) {
    const start = h.baseStart + shift;
    shift += h.lines.length - (h.baseEnd - h.baseStart);
    if (h.lines.length > 0) ranges.push({ startLine: start + 1, endLine: start + h.lines.length });
    else {
      const line = Math.min(start + 1, count);
      ranges.push({ startLine: line, endLine: line });
    }
  }
  return ranges;
}

export type MergeResult = { readonly ok: true; readonly text: string } | { readonly ok: false };

/**
 * Three-way merge of `ours` and `theirs`, both edited from `base`. Changes to different lines
 * both land; the same change made on both sides lands once; an insertion next to a change keeps
 * both (insertion first). Two different changes to overlapping lines, or two different insertions
 * at one spot, are a conflict: `{ ok: false }`, and the caller keeps `ours` untouched.
 */
export function merge3(base: string, ours: string, theirs: string): MergeResult {
  if (ours === theirs || theirs === base) return { ok: true, text: ours };
  if (ours === base) return { ok: true, text: theirs };
  const b = base.split("\n");
  const mine = diffLines(b, ours.split("\n"));
  const other = diffLines(b, theirs.split("\n"));
  const all: Hunk[] = [];
  let i = 0;
  let j = 0;
  while (i < mine.length || j < other.length) {
    const p = mine[i];
    const q = other[j];
    if (p === undefined) {
      all.push(q as Hunk);
      j++;
      continue;
    }
    if (q === undefined) {
      all.push(p);
      i++;
      continue;
    }
    if (sameHunk(p, q)) {
      all.push(p);
      i++;
      j++;
      continue;
    }
    if (clash(p, q)) return { ok: false };
    // Disjoint: the earlier one first; at one spot the insertion goes before the change.
    const pFirst = p.baseStart < q.baseStart || (p.baseStart === q.baseStart && p.baseEnd === p.baseStart);
    if (pFirst) {
      all.push(p);
      i++;
    } else {
      all.push(q);
      j++;
    }
  }
  const out: string[] = [];
  let at = 0;
  for (const h of all) {
    for (; at < h.baseStart; at++) out.push(b[at] as string);
    out.push(...h.lines);
    at = Math.max(at, h.baseEnd);
  }
  for (; at < b.length; at++) out.push(b[at] as string);
  return { ok: true, text: out.join("\n") };
}

function sameHunk(p: Hunk, q: Hunk): boolean {
  return p.baseStart === q.baseStart && p.baseEnd === q.baseEnd && p.lines.length === q.lines.length && p.lines.every((line, k) => line === q.lines[k]);
}

/** Whether two different hunks cannot both apply: overlapping base lines, an insertion inside the other's lines, or two insertions at one spot. */
function clash(p: Hunk, q: Hunk): boolean {
  const pEmpty = p.baseStart === p.baseEnd;
  const qEmpty = q.baseStart === q.baseEnd;
  if (pEmpty && qEmpty) return p.baseStart === q.baseStart;
  if (pEmpty) return q.baseStart < p.baseStart && p.baseStart < q.baseEnd;
  if (qEmpty) return p.baseStart < q.baseStart && q.baseStart < p.baseEnd;
  return p.baseStart < q.baseEnd && q.baseStart < p.baseEnd;
}
