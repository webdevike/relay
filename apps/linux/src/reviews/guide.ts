// The Reviews Guide (evaos-electron guide.ts): a PR's changed files grouped into a few sections a
// reviewer reads top to bottom, each with a short title and a what/why paragraph. Written by Claude
// headless (`claude -p`, no tools, no session) from the PR's title, body and diff; when that fails
// the files are grouped by folder instead. Kept per PR head commit in
// `$XDG_CONFIG_HOME/relay/reviews/guides.json`, so a PR is written once per push.

import { tmpdir } from "node:os";
import { ReviewGuide } from "@relay/protocol";
import { z } from "zod";
import { readJson, writeJson, type ToolRun } from "./exec";

const GUIDE_TIMEOUT_MS = 180_000;
/** Diff text the model reads; a longer diff is cut per file, then overall. */
const MAX_DIFF_CHARS = 120_000;
const MAX_FILE_DIFF_CHARS = 12_000;
const KEEP_GUIDES = 40;

/** The model's answer; a section without a title or a file list is skipped, not fatal. */
const Answer = z.object({
  sections: z.array(
    z
      .object({ title: z.string(), why: z.string().optional(), files: z.array(z.unknown()) })
      .nullable()
      .catch(null),
  ),
});
const ClaudeOut = z.object({ result: z.string(), is_error: z.boolean().optional() });
const Saved = z.record(z.string(), ReviewGuide.extend({ at: z.number() }));

export interface GuideInput {
  title: string;
  body: string;
  files: { path: string; additions: number; deletions: number }[];
  /** `gh pr diff` text. */
  diff: string;
}

type Section = ReviewGuide["sections"][number];

/** Core change first: source, then tests, then docs, config and lockfiles. */
export function fileRank(path: string): number {
  if (/(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$|^\.changeset\/|\.(md|json|ya?ml|toml)$/i.test(path)) return 2;
  if (/(\.test|\.spec)\.\w+$|(^|\/)(__tests__|tests?)\//.test(path)) return 1;
  return 0;
}

/** Fallback sections: one per folder (up to two levels deep), source folders first. */
export function folderSections(paths: readonly string[]): Section[] {
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

export function guidePrompt(pr: GuideInput): string {
  return `You write the guided walkthrough for a GitHub pull request review, like Linear's Guide.

Group the PR's changed files into 3 to 6 logical sections (for example: the core logic or policy, the endpoint or API, the client flow, migrations, tests, docs and config). Order the sections so a reviewer reads them top to bottom: the core behavior change first, then what builds on it; tests, then docs, dependency bumps, lockfiles and config come last even when the code needs them. Every changed file goes in exactly one section, in the order a reviewer should read it.

For each section write:
- "title": 2 to 5 plain words naming the part (no PR number, no ticket key, no "feat:").
- "why": 1 to 3 plain sentences on what this part changes and why, for a reviewer who has not seen the PR. Concrete, no filler, no markdown headings.
- "files": the exact file paths from the list below.

Answer with only this JSON, no prose and no code fence:
{"sections":[{"title":"...","why":"...","files":["..."]}]}

PR title: ${pr.title}

PR description:
${pr.body.trim() || "(none)"}

Changed files:
${pr.files.map((f) => `${f.path} (+${String(f.additions)} -${String(f.deletions)})`).join("\n")}

Diff:
${promptDiff(pr.diff)}`;
}

/**
 * The model's answer as sections over exactly the PR's files: unknown paths dropped, a file named
 * twice kept in its first section, files it left out added as a last section. Null when the answer
 * is not the asked-for JSON or names none of the files.
 */
export function parseGuide(text: string, paths: readonly string[]): Section[] | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) return null;
  let json: unknown;
  try {
    json = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  const answer = Answer.safeParse(json);
  if (!answer.success) return null;
  const known = new Set(paths);
  const placed = new Set<string>();
  const sections: Section[] = [];
  for (const s of answer.data.sections) {
    if (!s) continue;
    const files = s.files.filter((f): f is string => typeof f === "string" && known.has(f) && !placed.has(f));
    for (const f of files) placed.add(f);
    if (files.length === 0) continue;
    sections.push({ title: s.title.trim(), why: s.why?.trim() ?? "", files });
  }
  if (sections.length === 0) return null;
  const rest = paths.filter((p) => !placed.has(p));
  if (rest.length > 0) sections.push({ title: "Other changes", why: "", files: rest });
  return sections;
}

/** Runs the prompt once and answers the model's text; throws with a short reason. */
export type GuideWriter = (prompt: string) => Promise<string>;

/** `claude -p` on Sonnet with no tools, no MCP servers, no settings and no saved session. */
export function claudeWriter(run: ToolRun, claude: string): GuideWriter {
  return async (prompt) => {
    const res = await run(
      [claude, "-p", prompt, "--model", "sonnet", "--tools", "", "--output-format", "json", "--no-session-persistence", "--strict-mcp-config", "--setting-sources", ""],
      { cwd: tmpdir(), timeoutMs: GUIDE_TIMEOUT_MS },
    );
    if (res.timedOut) throw new Error("Claude took too long");
    if (res.code !== 0) throw new Error(`claude exited ${res.code === null ? "by a signal" : String(res.code)}`);
    let json: unknown;
    try {
      json = JSON.parse(res.stdout);
    } catch {
      throw new Error("Claude returned no answer");
    }
    const out = ClaudeOut.safeParse(json);
    if (!out.success || out.data.is_error === true) throw new Error("Claude returned no answer");
    return out.data.result;
  };
}

export type GuideRead = (key: string, headSha: string, pr: GuideInput) => Promise<ReviewGuide>;

/** One Guide per PR head, kept in `file`; one generation at a time per head. */
export function guideCache(file: string, write: GuideWriter): GuideRead {
  const running = new Map<string, Promise<ReviewGuide>>();
  const saved = (): z.infer<typeof Saved> => {
    const all = Saved.safeParse(readJson(file, {}));
    return all.success ? all.data : {};
  };
  return (key, headSha, pr) => {
    const id = `${key}@${headSha}`;
    const hit = saved()[id];
    if (hit) return Promise.resolve({ headSha, source: hit.source, error: hit.error, sections: hit.sections });
    const busy = running.get(id);
    if (busy) return busy;
    const paths = pr.files.map((f) => f.path);
    const job = (async (): Promise<ReviewGuide> => {
      try {
        const sections = parseGuide(await write(guidePrompt(pr)), paths);
        if (!sections) throw new Error("Claude answered in the wrong shape");
        const guide: ReviewGuide = { headSha, source: "model", error: null, sections };
        // Only a written Guide is kept; after a fallback the next open asks the model again.
        const kept = Object.entries({ ...saved(), [id]: { ...guide, at: Date.now() } })
          .sort((a, b) => b[1].at - a[1].at)
          .slice(0, KEEP_GUIDES);
        writeJson(file, Object.fromEntries(kept));
        return guide;
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        return { headSha, source: "folders", error, sections: folderSections(paths) };
      } finally {
        running.delete(id);
      }
    })();
    running.set(id, job);
    return job;
  };
}
