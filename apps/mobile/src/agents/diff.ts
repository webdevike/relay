/**
 * Unified diff text to display rows for the ```ui "diff" widget. Hunk headers (`@@ -a,b +c,d @@`)
 * seed the old/new line numbers; file headers before the first hunk (`diff --git`, `index`, `---`,
 * `+++`) are dropped. A bare +/- snippet with no hunk header still renders, just unnumbered.
 *
 * Each run of consecutive removed/added lines is one change block, classified the way Zed's gutter
 * shows it: removals with additions are "modified", additions alone "added", removals alone
 * "deleted".
 */
export type DiffRowKind = "add" | "del" | "context" | "hunk" | "meta";
export type DiffChange = "added" | "modified" | "deleted";

export interface DiffRow {
  kind: DiffRowKind;
  /** Line content without the +/-/space prefix; for a hunk row, the enclosing scope after `@@`. */
  text: string;
  oldLine: number | null;
  newLine: number | null;
  /** Set on add/del rows: the kind of change block the row belongs to. */
  change: DiffChange | null;
}

export interface ParsedDiff {
  rows: DiffRow[];
  additions: number;
  deletions: number;
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/;
const FILE_HEADER = /^(diff --git |index |--- |\+\+\+ |new file mode|deleted file mode|similarity index|rename (from|to) )/;

export function parseDiff(patch: string): ParsedDiff {
  const rows: DiffRow[] = [];
  let additions = 0;
  let deletions = 0;
  let oldLine: number | null = null;
  let newLine: number | null = null;
  let inHunk = false;
  const lines = patch.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
  for (const line of lines) {
    const hunk = HUNK.exec(line);
    if (hunk !== null) {
      inHunk = true;
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      rows.push({ kind: "hunk", text: hunk[3]?.trim() ?? "", oldLine: null, newLine: null, change: null });
      continue;
    }
    // A new file section ends the previous hunk, so its headers are dropped too.
    if (line.startsWith("diff --git ")) inHunk = false;
    if (!inHunk && FILE_HEADER.test(line)) continue;
    if (line.startsWith("\\")) {
      rows.push({ kind: "meta", text: line, oldLine: null, newLine: null, change: null });
    } else if (line.startsWith("+")) {
      additions++;
      rows.push({ kind: "add", text: line.slice(1), oldLine: null, newLine, change: null });
      if (newLine !== null) newLine++;
    } else if (line.startsWith("-")) {
      deletions++;
      rows.push({ kind: "del", text: line.slice(1), oldLine, newLine: null, change: null });
      if (oldLine !== null) oldLine++;
    } else {
      rows.push({ kind: "context", text: line.startsWith(" ") ? line.slice(1) : line, oldLine, newLine, change: null });
      if (oldLine !== null) oldLine++;
      if (newLine !== null) newLine++;
    }
  }
  let start = 0;
  while (start < rows.length) {
    let end = start;
    while (end < rows.length && (rows[end]?.kind === "add" || rows[end]?.kind === "del")) end++;
    if (end === start) {
      start++;
      continue;
    }
    const block = rows.slice(start, end);
    const hasAdd = block.some((r) => r.kind === "add");
    const hasDel = block.some((r) => r.kind === "del");
    const change: DiffChange = hasAdd && hasDel ? "modified" : hasAdd ? "added" : "deleted";
    for (const row of block) row.change = change;
    start = end;
  }
  return { rows, additions, deletions };
}
