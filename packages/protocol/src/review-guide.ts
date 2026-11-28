// The Reviews Guide's prompt, answer check and fallback, shared by the Relay Host and Relay
// Desktop's main process (each runs `claude -p` and keeps the result per head commit) and the
// desktop renderer (hunk ids). The model reads an annotated diff where every hunk has a stable id
// (`path#oldStart,newStart`) and every line its old and new numbers; its answer is checked against
// exactly the diff it was sent (after `promptDiff` cut it), so a Guide only points at code that
// exists. Pure, no imports beyond the shared diff parser.

import { parseDiff, type DiffFile, type DiffLine, type Hunk } from "./unified-diff";

/** Diff text the model reads; a longer diff is cut per file, then overall. */
const MAX_DIFF_CHARS = 120_000;
const MAX_FILE_DIFF_CHARS = 12_000;
/** A line's text in the annotated diff. */
const MAX_LINE_CHARS = 200;
export const MIN_GUIDE_SECTIONS = 3;
export const MAX_GUIDE_SECTIONS = 7;
const MAX_LIST = 10;
const MAX_NOTE_CHARS = 240;

export type GuideSide = "old" | "new";
export type GuideRisk = "low" | "medium" | "high";

export interface GuideCallout {
  line: number;
  side: GuideSide;
  note: string;
}

/** One hunk a section shows: `start`..`end` are lines of `side` inside it. */
export interface GuideHunk {
  id: string;
  path: string;
  side: GuideSide;
  start: number;
  end: number;
  callouts: GuideCallout[];
}

export interface GuideSection {
  title: string;
  /** v1 projection: the explanation, for clients that only know `why/files`. */
  why: string;
  /** v1 projection: the paths of this section's hunks, in order. */
  files: string[];
  explanation: string;
  check: string[];
  risks: string[];
  hunks: GuideHunk[];
}

/** A written Guide (v2) without the record's `headSha/source/error`. */
export interface GuideBody {
  version: 2;
  overview: string;
  risk: GuideRisk;
  riskWhy: string;
  sections: GuideSection[];
  notCovered: { path: string; why: string }[];
  followUps: string[];
  checklist: string[];
}

export interface GuideInput {
  title: string;
  body: string;
  files: { path: string; additions: number; deletions: number }[];
  /** `gh pr diff` text. */
  diff: string;
}

/** The diff as the model got it: files parsed from the cut text, renamed files' old paths by new path. */
export interface SentDiff {
  files: DiffFile[];
  renames: Map<string, string>;
}

/** The label the renderer shows when the model's walkthrough is missing. */
export const FOLDERS_LABEL = "Grouped by folder (the walkthrough couldn't be written)";

/** Core change first: source, then tests, then docs, config and lockfiles. */
export function fileRank(path: string): number {
  if (/(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$|^\.changeset\/|\.(md|json|ya?ml|toml)$/i.test(path)) return 2;
  if (/(\.test|\.spec)\.\w+$|(^|\/)(__tests__|tests?)\//.test(path)) return 1;
  return 0;
}

/** Fallback sections: one per folder (up to two levels deep), source folders first. */
export function folderSections(paths: readonly string[]): { title: string; why: string; files: string[] }[] {
  const groups = new Map<string, string[]>();
  for (const p of [...paths].sort((a, b) => fileRank(a) - fileRank(b) || a.localeCompare(b))) {
    const parts = p.split("/");
    const dir = parts.length > 1 ? parts.slice(0, Math.min(2, parts.length - 1)).join("/") : "";
    groups.set(dir, [...(groups.get(dir) ?? []), p]);
  }
  return [...groups].map(([dir, files]) => ({ title: dir === "" ? "Top-level files" : dir, why: "", files }));
}

/** The diff the model reads: each file's part, long ones cut, the whole capped. */
export function promptDiff(diff: string): string {
  const parts = diff
    .split(/^(?=diff --git )/m)
    .map((part) => (part.length > MAX_FILE_DIFF_CHARS ? `${part.slice(0, MAX_FILE_DIFF_CHARS)}\n[... rest of this file's diff cut]\n` : part));
  const text = parts.join("");
  return text.length > MAX_DIFF_CHARS ? `${text.slice(0, MAX_DIFF_CHARS)}\n[... diff cut]\n` : text;
}

/** Renamed files in a diff: the old path by the new one. */
export function renamesOf(diff: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const chunk of diff.split(/^diff --git /m).slice(1)) {
    const from = /^rename from (.+)$/m.exec(chunk)?.[1];
    const to = /^rename to (.+)$/m.exec(chunk)?.[1];
    if (from !== undefined && to !== undefined) out.set(to, from);
  }
  return out;
}

/** What the model is sent: the cut diff, parsed by the same parser the renderer uses. */
export function sendDiff(diff: string): SentDiff {
  const text = promptDiff(diff);
  return { files: parseDiff(text), renames: renamesOf(text) };
}

const HUNK_START = /^@@ -(\d+)(?:,\d+)? \+(\d+)/;

/** A hunk's stable id: `path#oldStart,newStart` from its header. */
export function hunkId(path: string, hunk: Hunk): string {
  const m = HUNK_START.exec(hunk.header);
  return `${path}#${m?.[1] ?? "0"},${m?.[2] ?? "0"}`;
}

export function lineOn(line: DiffLine, side: GuideSide): number | null {
  return side === "old" ? line.old : line.new;
}

/** The first and last line numbers of `side` in a hunk; null when it has none (a deletion's new side). */
export function hunkRange(hunk: Hunk, side: GuideSide): { lo: number; hi: number } | null {
  let lo = Infinity;
  let hi = -Infinity;
  for (const l of hunk.lines) {
    const n = lineOn(l, side);
    if (n === null) continue;
    lo = Math.min(lo, n);
    hi = Math.max(hi, n);
  }
  return lo > hi ? null : { lo, hi };
}

function annotateLine(l: DiffLine): string {
  const num = (n: number | null): string => (n === null ? "" : String(n)).padStart(5);
  const sign = l.kind === "add" ? "+" : l.kind === "del" ? "-" : " ";
  return `${num(l.old)} ${num(l.new)} |${sign}${l.text.slice(0, MAX_LINE_CHARS)}`;
}

function fileNote(f: DiffFile, from: string | undefined): string {
  if (from !== undefined) return ` (renamed from ${from})`;
  if (f.binary) return " (binary)";
  if (f.hunks.length > 0 && f.hunks.every((h) => hunkRange(h, "new") === null)) return " (deleted)";
  return f.hunks.length === 0 ? " (no text changes)" : "";
}

function annotateFile(f: DiffFile, from: string | undefined): string {
  const hunks = f.hunks.map((h) => [`HUNK ${hunkId(f.path, h)}`, ...h.lines.map(annotateLine)].join("\n"));
  return [`FILE ${f.path}${fileNote(f, from)}`, ...hunks].join("\n");
}

/** The diff with hunk ids and both sides' line numbers, plus the files cut from it. */
export function annotateDiff(sent: SentDiff, paths: readonly string[]): string {
  const shown = new Set(sent.files.map((f) => f.path));
  const cut = paths.filter((p) => !shown.has(p)).map((p) => `FILE ${p} (not shown: the diff was cut for size)`);
  return [...sent.files.map((f) => annotateFile(f, sent.renames.get(f.path))), ...cut].join("\n\n");
}

const ANSWER_SHAPE = `{"overview":"...","risk":"low","riskWhy":"...","sections":[{"title":"...","explanation":"...","check":["..."],"risks":["..."],"hunks":[{"id":"src/a.ts#10,12","side":"new","start":12,"end":30,"callouts":[{"line":18,"side":"new","note":"..."}]}]}],"notCovered":[{"path":"...","why":"..."}],"followUps":["..."],"checklist":["..."]}`;

export function guidePrompt(pr: GuideInput, sent: SentDiff): string {
  const paths = pr.files.map((f) => f.path);
  return `You write the reviewer walkthrough of a GitHub pull request for a staff engineer who must review it quickly and well.

Group the change by CONCEPT, not by folder or file, into ${String(MIN_GUIDE_SECTIONS)} to ${String(MAX_GUIDE_SECTIONS)} sections (fewer only when the diff has fewer hunks). Order them the way a reviewer should read: foundations and contracts first, then the logic built on them, then UI, then tests; docs, config and lockfiles last or not at all.

For each section write:
- "title": 2 to 6 plain words naming the concept (no PR number, no ticket key, no "feat:").
- "explanation": 2 to 4 plain sentences on what changed and why, for a reviewer who has not seen the PR.
- "check": 1 to 4 specific things the reviewer should verify.
- "risks": 0 to 3 things that could break.
- "hunks": the hunks that show this concept, by the id after HUNK in the annotated diff. Cite only ids shown there, each hunk at most once in the whole walkthrough, at most 4 per section. "side" is "new" for added or changed code and "old" for removed code; "start" and "end" are the lines of that side the reviewer should read.
- "callouts": 0 to 3 per hunk, each on a line of that hunk: {"line": its number on "side", "side": "old" or "new", "note": at most 14 words}.

Also write "overview" (what changed and why, 2 to 3 sentences), "risk" (low, medium or high) and "riskWhy" (one sentence on the main risk), "notCovered" (changed files you did not cite, each with a short why), "followUps" (what this PR leaves for later) and "checklist" (4 to 6 short review items).

Use plain, direct language: no em dashes, no markdown headings. Use only facts from the PR text and the diff below.

Answer with only this JSON, no prose and no code fence:
${ANSWER_SHAPE}

PR title: ${pr.title}

PR description:
${pr.body.trim() || "(none)"}

Changed files:
${pr.files.map((f) => `${f.path} (+${String(f.additions)} -${String(f.deletions)})`).join("\n")}

Annotated diff (columns: old line, new line, then |+ added, |- removed, |  unchanged):
${annotateDiff(sent, paths)}`;
}

// ---- The answer, checked against the sent diff ----

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const int = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) ? v : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const strings = (v: unknown): string[] => arr(v).map(str).filter((s) => s !== "").slice(0, MAX_LIST);
const sideOf = (v: unknown): GuideSide | null => (v === "old" || v === "new" ? v : null);

interface Located {
  id: string;
  path: string;
  hunk: Hunk;
}

/** Every hunk of the sent diff by id; a renamed file's hunks also answer to its old path. */
function hunkIndex(sent: SentDiff): Map<string, Located> {
  const index = new Map<string, Located>();
  for (const f of sent.files) {
    const from = sent.renames.get(f.path);
    for (const hunk of f.hunks) {
      const at = { id: hunkId(f.path, hunk), path: f.path, hunk };
      index.set(at.id, at);
      if (from !== undefined) index.set(hunkId(from, hunk), at);
    }
  }
  return index;
}

function callout(raw: unknown, hunk: Hunk, side: GuideSide): GuideCallout | null {
  if (!isObj(raw)) return null;
  const line = int(raw["line"]);
  const on = sideOf(raw["side"]) ?? side;
  const note = str(raw["note"]).slice(0, MAX_NOTE_CHARS);
  if (line === null || note === "") return null;
  return hunk.lines.some((l) => lineOn(l, on) === line) ? { line, side: on, note } : null;
}

/** The side asked for when the hunk has lines there; else new, or old for a deletion. */
function citedSide(raw: Obj, hunk: Hunk): { side: GuideSide; asked: boolean } {
  const want = sideOf(raw["side"]);
  if (want !== null && hunkRange(hunk, want) !== null) return { side: want, asked: true };
  return { side: hunkRange(hunk, "new") === null ? "old" : "new", asked: false };
}

/** The lines a citation reads, clamped to its hunk (the whole hunk when its side was not usable); null when it misses. */
function citedRange(raw: Obj, hunk: Hunk): { side: GuideSide; start: number; end: number } | null {
  const { side, asked } = citedSide(raw, hunk);
  const range = hunkRange(hunk, side);
  if (range === null) return null;
  const start = (asked ? int(raw["start"]) : null) ?? range.lo;
  const end = (asked ? int(raw["end"]) : null) ?? range.hi;
  if (end < start || end < range.lo || start > range.hi) return null;
  return { side, start: Math.max(start, range.lo), end: Math.min(end, range.hi) };
}

/** A cited hunk: unknown ids, repeats and ranges outside the hunk are dropped (null). */
function guideHunk(raw: unknown, index: Map<string, Located>, used: Set<string>): GuideHunk | null {
  if (!isObj(raw)) return null;
  const at = index.get(str(raw["id"]));
  if (at === undefined || used.has(at.id)) return null;
  const cited = citedRange(raw, at.hunk);
  if (cited === null) return null;
  used.add(at.id);
  const callouts = arr(raw["callouts"])
    .map((c) => callout(c, at.hunk, cited.side))
    .filter((c): c is GuideCallout => c !== null);
  return { id: at.id, path: at.path, ...cited, callouts };
}

function guideSection(raw: unknown, index: Map<string, Located>, used: Set<string>): GuideSection | null {
  if (!isObj(raw)) return null;
  const title = str(raw["title"]);
  const hunks = arr(raw["hunks"])
    .map((h) => guideHunk(h, index, used))
    .filter((h): h is GuideHunk => h !== null);
  if (title === "" || hunks.length === 0) return null;
  const explanation = str(raw["explanation"]);
  const files = [...new Set(hunks.map((h) => h.path))];
  return { title, why: explanation, files, explanation, check: strings(raw["check"]), risks: strings(raw["risks"]), hunks };
}

function defaultWhy(file: DiffFile | undefined): string {
  if (file === undefined) return "Not shown to the model: the diff was cut for size.";
  if (file.binary) return "Binary file.";
  if (file.hunks.length === 0) return "No text changes.";
  return "Not part of the walkthrough.";
}

/** Every changed file no section shows, with the model's reason when it gave one. */
function notCovered(raw: unknown, sent: SentDiff, paths: readonly string[], sections: GuideSection[]): GuideBody["notCovered"] {
  const covered = new Set(sections.flatMap((s) => s.files));
  const said = new Map<string, string>();
  for (const n of arr(raw)) if (isObj(n)) said.set(str(n["path"]), str(n["why"]));
  const files = new Map(sent.files.map((f) => [f.path, f]));
  const all = [...new Set([...paths, ...files.keys()])];
  return all
    .filter((p) => !covered.has(p))
    .map((path) => {
      const from = sent.renames.get(path);
      const why = said.get(path) || (from === undefined ? "" : said.get(from)) || defaultWhy(files.get(path));
      return { path, why: why.slice(0, MAX_NOTE_CHARS) };
    });
}

function jsonIn(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1)) as unknown;
  } catch {
    return null;
  }
}

/**
 * The model's answer as a v2 Guide over exactly the diff it was sent: unknown or repeated hunk
 * ids, ranges and callouts outside their hunk, and sections left without a hunk are dropped; every
 * changed file no section shows goes to `notCovered`. Null when the answer is not the asked-for
 * JSON or has fewer than 3 (or the diff's hunk count, when smaller) or more than 7 sections.
 */
export function parseGuide(text: string, sent: SentDiff, paths: readonly string[]): GuideBody | null {
  const json = jsonIn(text);
  if (!isObj(json)) return null;
  const index = hunkIndex(sent);
  const used = new Set<string>();
  const sections = arr(json["sections"])
    .map((s) => guideSection(s, index, used))
    .filter((s): s is GuideSection => s !== null);
  const hunkCount = sent.files.reduce((n, f) => n + f.hunks.length, 0);
  const min = Math.max(1, Math.min(MIN_GUIDE_SECTIONS, hunkCount));
  if (sections.length < min || sections.length > MAX_GUIDE_SECTIONS) return null;
  return {
    version: 2,
    overview: str(json["overview"]),
    risk: json["risk"] === "low" || json["risk"] === "high" ? json["risk"] : "medium",
    riskWhy: str(json["riskWhy"]),
    sections,
    notCovered: notCovered(json["notCovered"], sent, paths, sections),
    followUps: strings(json["followUps"]),
    checklist: strings(json["checklist"]),
  };
}
