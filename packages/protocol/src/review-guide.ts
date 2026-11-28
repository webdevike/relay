// The Reviews Guide's prompt, answer check and fallback, shared by the Relay Host and Relay
// Desktop's main process (each runs `claude -p` and keeps the result per base and head commit) and
// the desktop renderer (hunk ids). The model reads an annotated diff where every hunk has a stable
// id (`path#oldStart,newStart`) and every line its old and new numbers; its answer is checked
// against exactly the lines it was sent (`guideRequest` bounds the whole prompt on whole lines), so
// a Guide only points at code that exists. Pure, no imports beyond the shared diff parser.

import { parseDiff, type DiffFile, type DiffLine, type Hunk } from "./unified-diff";

/** UTF-8 bytes the whole prompt may take (it goes to `claude -p` on stdin). */
export const MAX_PROMPT_BYTES = 150_000;
/** One file's part of the annotated diff. */
const MAX_FILE_PROMPT_BYTES = 16_000;
const MAX_TITLE_CHARS = 300;
const MAX_BODY_BYTES = 8_000;
const MAX_BODY_LINE_CHARS = 2_000;
const MAX_FILE_LIST_BYTES = 20_000;
/** Kept aside for the cut markers that close the prompt. */
const MARKER_BYTES = 120;
/** A line's text in the annotated diff. */
const MAX_LINE_CHARS = 200;
export const MIN_GUIDE_SECTIONS = 3;
export const MAX_GUIDE_SECTIONS = 7;
const MAX_SECTION_HUNKS = 4;
const MAX_HUNK_CALLOUTS = 3;
const MAX_CHECKS = 4;
const MAX_RISKS = 3;
const MAX_CHECKLIST = 6;
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
  /** v1 projection: the paths this section shows first (each changed file in one section only). */
  files: string[];
  explanation: string;
  check: string[];
  risks: string[];
  /** The cited hunks; empty only in the trailing `REMAINING_TITLE` section old clients read. */
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
  /** Set when the model read only part of the PR (the prompt was cut for size). */
  partial?: true;
}

export interface GuideInput {
  title: string;
  body: string;
  files: { path: string; additions: number; deletions: number }[];
  /** The PR's diff, read at one base and head commit (the same text the Diff tab shows). */
  diff: string;
}

/** The diff as the model got it: exactly the files, hunks and lines the prompt shows. */
export interface SentDiff {
  files: DiffFile[];
  /** Renamed files' old paths by new path. */
  renames: Map<string, string>;
  /** Whether the description, the file list or the diff was cut to fit the prompt. */
  partial: boolean;
}

/** What one Guide asks the model, and the diff its answer is checked against. */
export interface GuideRequest {
  prompt: string;
  sent: SentDiff;
}

/** The label the renderer shows when the model's walkthrough is missing. */
export const FOLDERS_LABEL = "Grouped by folder (the walkthrough couldn't be written)";
/** Why a PR with no text hunks gets the folder grouping without asking the model. */
export const NO_TEXT_CHANGES = "The PR has no text changes to walk through";
/** The trailing section old clients read (they only know `title/why/files`): every file no concept section shows. */
export const REMAINING_TITLE = "Other changed files";
const REMAINING_WHY = "Changed files the walkthrough does not show. Open them in the diff.";

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

// ---- The prompt, bounded on whole lines ----

/** UTF-8 length of `s` without encoding it (a lone surrogate counts as U+FFFD's 3 bytes). */
export function utf8Bytes(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      n += 4;
      i += 1;
    } else n += 3;
  }
  return n;
}

/** Whole lines taken while they fit; each costs its bytes plus the newline that joins it. */
class Lines {
  readonly out: string[] = [];
  constructor(public left: number) {}

  take(line: string): boolean {
    const n = utf8Bytes(line) + 1;
    if (n > this.left) return false;
    this.left -= n;
    this.out.push(line);
    return true;
  }

  /** The leading lines of `lines` within `cap` bytes of this budget; false when one was left out. */
  takeAll(lines: readonly string[], cap: number): boolean {
    const part = new Lines(Math.min(cap, this.left));
    const all = lines.every((l) => part.take(l));
    this.left -= Math.min(cap, this.left) - part.left;
    this.out.push(...part.out);
    return all;
  }
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

/** The leading lines of `hunk` that fit `budget` (none when not even its first line does). */
function sentHunk(path: string, hunk: Hunk, budget: Lines): Hunk | null {
  const mark = budget.out.length;
  const left = budget.left;
  if (!budget.take(`HUNK ${hunkId(path, hunk)}`)) return null;
  const lines: DiffLine[] = [];
  for (const l of hunk.lines) {
    if (!budget.take(annotateLine(l))) break;
    lines.push(l);
  }
  if (lines.length === 0) {
    budget.out.length = mark;
    budget.left = left;
    return null;
  }
  return { ...hunk, lines };
}

/** The leading hunks of `f` that fit `budget`, the last one possibly cut. */
function sentHunks(f: DiffFile, budget: Lines): Hunk[] {
  const hunks: Hunk[] = [];
  for (const h of f.hunks) {
    const sent = sentHunk(f.path, h, budget);
    if (sent === null) break;
    hunks.push(sent);
    if (sent.lines.length < h.lines.length) break;
  }
  return hunks;
}

/** One file's annotated part within `budget`; null when not even its header and first line fit. */
function sentFile(f: DiffFile, from: string | undefined, budget: Lines): { file: DiffFile; cut: boolean } | null {
  const own = new Lines(Math.min(MAX_FILE_PROMPT_BYTES, budget.left) - MARKER_BYTES);
  if (!own.take(`FILE ${f.path}${fileNote(f, from)}`)) return null;
  const hunks = sentHunks(f, own);
  if (hunks.length === 0 && f.hunks.length > 0) return null;
  const cut = hunks.length < f.hunks.length || hunks.at(-1)?.lines.length !== f.hunks.at(-1)?.lines.length;
  budget.takeAll(own.out, Infinity);
  if (cut) budget.take("[... rest of this file's diff cut for size]");
  return { file: { ...f, hunks }, cut };
}

/** The annotated diff within `budget`: whole files while they fit, a long file cut at its own share. */
function sentDiff(files: readonly DiffFile[], renames: Map<string, string>, budget: Lines): { files: DiffFile[]; cut: boolean } {
  const sent: DiffFile[] = [];
  let cut = false;
  for (const f of files) {
    const part = sentFile(f, renames.get(f.path), budget);
    if (part === null) break;
    sent.push(part.file);
    cut ||= part.cut;
  }
  const left = files.length - sent.length;
  if (left > 0) budget.take(`[... ${String(left)} more changed files not shown: the diff was cut for size]`);
  return { files: sent, cut: cut || left > 0 };
}

const ANSWER_SHAPE = `{"overview":"...","risk":"low","riskWhy":"...","sections":[{"title":"...","explanation":"...","check":["..."],"risks":["..."],"hunks":[{"id":"src/a.ts#10,12","side":"new","start":12,"end":30,"callouts":[{"line":18,"side":"new","note":"..."}]}]}],"notCovered":[{"path":"...","why":"..."}],"followUps":["..."],"checklist":["..."]}`;

const INSTRUCTIONS = `You write the reviewer walkthrough of a GitHub pull request for a staff engineer who must review it quickly and well.

Group the change by CONCEPT, not by folder or file, into ${String(MIN_GUIDE_SECTIONS)} to ${String(MAX_GUIDE_SECTIONS)} sections (fewer only when the diff has fewer hunks). Order them the way a reviewer should read: foundations and contracts first, then the logic built on them, then UI, then tests; docs, config and lockfiles last or not at all.

For each section write:
- "title": 2 to 6 plain words naming the concept (no PR number, no ticket key, no "feat:").
- "explanation": 2 to 4 plain sentences on what changed and why, for a reviewer who has not seen the PR.
- "check": 1 to ${String(MAX_CHECKS)} specific things the reviewer should verify.
- "risks": 0 to ${String(MAX_RISKS)} things that could break.
- "hunks": the hunks that show this concept, by the id after HUNK in the annotated diff. Cite only ids shown there, each hunk at most once in the whole walkthrough, at most ${String(MAX_SECTION_HUNKS)} per section. "side" is "new" for added or changed code and "old" for removed code; "start" and "end" are the lines of that side the reviewer should read.
- "callouts": 0 to ${String(MAX_HUNK_CALLOUTS)} per hunk, each on a line of that hunk: {"line": its number on "side", "side": "old" or "new", "note": at most 14 words}.

Also write "overview" (what changed and why, 2 to 3 sentences), "risk" (low, medium or high) and "riskWhy" (one sentence on the main risk), "notCovered" (changed files you did not cite, each with a short why), "followUps" (what this PR leaves for later) and "checklist" (4 to ${String(MAX_CHECKLIST)} short review items).

Use plain, direct language: no em dashes, no markdown headings. Use only facts from the PR text and the diff below. Parts cut for size are marked; do not guess what they hold.

Answer with only this JSON, no prose and no code fence:
${ANSWER_SHAPE}`;

/** The description's lines, a long line cut, within its share of `budget`; true when some of it was cut. */
function takeBody(body: string, budget: Lines): boolean {
  const text = body.trim();
  if (text === "") {
    budget.take("(none)");
    return false;
  }
  const raw = text.split("\n");
  const whole = budget.takeAll(
    raw.map((l) => l.slice(0, MAX_BODY_LINE_CHARS)),
    MAX_BODY_BYTES,
  );
  if (!whole) budget.take("[... description cut for size]");
  return !whole || raw.some((l) => l.length > MAX_BODY_LINE_CHARS);
}

/** The changed files with their counts, within their share of `budget`; true when some were left out. */
function takeFiles(files: GuideInput["files"], budget: Lines): boolean {
  const lines = files.map((f) => `${f.path} (+${String(f.additions)} -${String(f.deletions)})`);
  const before = budget.out.length;
  if (budget.takeAll(lines, MAX_FILE_LIST_BYTES)) return false;
  budget.take(`[... ${String(lines.length - (budget.out.length - before))} more files]`);
  return true;
}

/**
 * The prompt for one Guide, at most `MAX_PROMPT_BYTES` of UTF-8 cut only on whole lines (the
 * description, the file list and each file's diff have their own share), and exactly the diff it
 * shows. Null when the diff has no text hunk to walk through (the model is not asked).
 */
export function guideRequest(pr: GuideInput): GuideRequest | null {
  const all = parseDiff(pr.diff);
  if (!all.some((f) => f.hunks.some((h) => h.lines.length > 0))) return null;
  const renames = renamesOf(pr.diff);
  const budget = new Lines(MAX_PROMPT_BYTES - MARKER_BYTES);
  for (const line of INSTRUCTIONS.split("\n")) budget.take(line);
  budget.take("");
  budget.take(`PR title: ${pr.title.replace(/\s+/g, " ").trim().slice(0, MAX_TITLE_CHARS)}`);
  budget.take("");
  budget.take("PR description:");
  const bodyCut = takeBody(pr.body, budget);
  budget.take("");
  budget.take("Changed files:");
  const filesCut = takeFiles(pr.files, budget);
  budget.take("");
  budget.take("Annotated diff (columns: old line, new line, then |+ added, |- removed, |  unchanged):");
  budget.left += MARKER_BYTES;
  const diff = sentDiff(all, renames, budget);
  if (!diff.files.some((f) => f.hunks.length > 0)) return null;
  return { prompt: budget.out.join("\n"), sent: { files: diff.files, renames, partial: bodyCut || filesCut || diff.cut } };
}

// ---- The answer, checked against the sent diff ----

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const int = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) ? v : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const strings = (v: unknown, max = MAX_LIST): string[] => arr(v).map(str).filter((s) => s !== "").slice(0, max);
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

/** A cited hunk: unknown ids, repeats and ranges outside the hunk are dropped (null); at most 3 callouts. */
function guideHunk(raw: unknown, index: Map<string, Located>, used: Set<string>): GuideHunk | null {
  if (!isObj(raw)) return null;
  const at = index.get(str(raw["id"]));
  if (at === undefined || used.has(at.id)) return null;
  const cited = citedRange(raw, at.hunk);
  if (cited === null) return null;
  used.add(at.id);
  const callouts = arr(raw["callouts"])
    .map((c) => callout(c, at.hunk, cited.side))
    .filter((c): c is GuideCallout => c !== null)
    .slice(0, MAX_HUNK_CALLOUTS);
  return { id: at.id, path: at.path, ...cited, callouts };
}

/** The first `MAX_SECTION_HUNKS` valid citations of a section (later ones stay free for other sections). */
function sectionHunks(raw: unknown, index: Map<string, Located>, used: Set<string>): GuideHunk[] {
  const hunks: GuideHunk[] = [];
  for (const h of arr(raw)) {
    if (hunks.length === MAX_SECTION_HUNKS) break;
    const hunk = guideHunk(h, index, used);
    if (hunk !== null) hunks.push(hunk);
  }
  return hunks;
}

/** A section with its title, explanation, at least one check and one hunk; null otherwise. */
function guideSection(raw: unknown, index: Map<string, Located>, used: Set<string>): GuideSection | null {
  if (!isObj(raw)) return null;
  const title = str(raw["title"]);
  const explanation = str(raw["explanation"]);
  const check = strings(raw["check"], MAX_CHECKS);
  if (title === "" || explanation === "" || check.length === 0) return null;
  const hunks = sectionHunks(raw["hunks"], index, used);
  if (hunks.length === 0) return null;
  const files = [...new Set(hunks.map((h) => h.path))];
  return { title, why: explanation, files, explanation, check, risks: strings(raw["risks"], MAX_RISKS), hunks };
}

function defaultWhy(file: DiffFile | undefined): string {
  if (file === undefined) return "Not shown to the model: the diff was cut for size.";
  if (file.binary) return "Binary file.";
  if (file.hunks.length === 0) return "No text changes.";
  return "Not part of the walkthrough.";
}

/** Every changed file no section shows, with the model's reason when it gave one. */
function notCovered(raw: unknown, sent: SentDiff, paths: readonly string[], sections: GuideSection[]): GuideBody["notCovered"] {
  const covered = new Set(sections.flatMap((s) => s.hunks.map((h) => h.path)));
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

/**
 * The v1 projection old clients read (`title/why/files` only, every changed file exactly once):
 * each path in the first section that shows it, then one hunk-less `REMAINING_TITLE` section with
 * every file the walkthrough does not show. A v2 reader skips that section and lists `notCovered`.
 */
function withV1Files(sections: GuideSection[], left: GuideBody["notCovered"]): GuideSection[] {
  const seen = new Set<string>();
  const owned = sections.map((s) => ({ ...s, files: s.files.filter((p) => !seen.has(p) && Boolean(seen.add(p))) }));
  if (left.length === 0) return owned;
  const files = left.map((n) => n.path);
  return [...owned, { title: REMAINING_TITLE, why: REMAINING_WHY, files, explanation: REMAINING_WHY, check: [], risks: [], hunks: [] }];
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

/** The Guide-wide prose: overview, risk (exactly low, medium or high), riskWhy and a checklist; null when any is missing. */
function guideProse(json: Obj): { overview: string; risk: GuideRisk; riskWhy: string; checklist: string[] } | null {
  const overview = str(json["overview"]);
  const risk = json["risk"] === "low" || json["risk"] === "medium" || json["risk"] === "high" ? json["risk"] : null;
  const riskWhy = str(json["riskWhy"]);
  const checklist = strings(json["checklist"], MAX_CHECKLIST);
  if (overview === "" || risk === null || riskWhy === "" || checklist.length === 0) return null;
  return { overview, risk, riskWhy, checklist };
}

/**
 * The model's answer as a v2 Guide over exactly the diff it was sent: unknown or repeated hunk
 * ids, ranges and callouts outside their hunk, citations past 4 per section and callouts past 3
 * per hunk are dropped, and so are sections without a title, explanation, check or hunk; every
 * changed file no section shows goes to `notCovered`. Null when the answer is not the asked-for
 * JSON, lacks the overview, a valid risk, its reason or a checklist, or has fewer than 3 (or the
 * diff's hunk count, when smaller) or more than 7 sections.
 */
export function parseGuide(text: string, sent: SentDiff, paths: readonly string[]): GuideBody | null {
  const json = jsonIn(text);
  if (!isObj(json)) return null;
  const prose = guideProse(json);
  if (prose === null) return null;
  const index = hunkIndex(sent);
  const used = new Set<string>();
  const sections = arr(json["sections"])
    .map((s) => guideSection(s, index, used))
    .filter((s): s is GuideSection => s !== null);
  const hunkCount = sent.files.reduce((n, f) => n + f.hunks.length, 0);
  const min = Math.max(1, Math.min(MIN_GUIDE_SECTIONS, hunkCount));
  if (sections.length < min || sections.length > MAX_GUIDE_SECTIONS) return null;
  const left = notCovered(json["notCovered"], sent, paths, sections);
  return {
    version: 2,
    overview: prose.overview,
    risk: prose.risk,
    riskWhy: prose.riskWhy,
    sections: withV1Files(sections, left),
    notCovered: left,
    followUps: strings(json["followUps"]),
    checklist: prose.checklist,
    ...(sent.partial ? { partial: true as const } : {}),
  };
}
