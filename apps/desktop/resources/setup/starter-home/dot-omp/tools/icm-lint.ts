#!/usr/bin/env bun
// ICM lint: checks that this home base's routing and context files keep their ICM shape
// (Interpretable Context Methodology: small routers, one home per fact, every
// path resolves). Run it from the home base root after a batch of edits; it needs
// `git init` there (it reads the file list from git).
//
//   bun .omp/tools/icm-lint.ts           report, exit 1 when there are errors (warnings never fail)
//   bun .omp/tools/icm-lint.ts --json    same, as JSON
//
// Checks (tokens = bytes / 4):
//   budget  AGENTS.md <= 60 lines; every CONTEXT.md and workspaces/*.md card <= 600 tokens;
//           every references/ topic file <= 2,500 tokens; every workflows/ runbook router
//           (workflows/<name>.md) and runbook sub-file (workflows/<name>/<topic>.md) warns
//           over 1,500 tokens and errors over 2,500
//   reach   every runbook sub-file workflows/<name>/<topic>.md is named, as that path, in its
//           router workflows/<name>.md (moved detail stays reachable)
//   path    every backticked repo-relative path resolves. Skipped as foreign: a first
//           segment that is not a top-level Eva entry (work/, secrets/, ~/..., src/...),
//           apps/<x> or docs/<x> when <x> is not in Eva (another repo's tree), paths
//           written `<repo>:<path>` (another repo, e.g. `node-client-api-service:docs/plans/x.md`),
//           and gitignored paths (runtime state such as jobs/.runs/). Placeholders
//           (<ws>, {{key}}, *, $RUN) are skipped. A missing path that exists in the main
//           checkout (untracked there, so it lands with that checkout) is a warning.
//   h1      every markdown file starts with an H1 (after frontmatter)
//   claude  CLAUDE.md is exactly `@AGENTS.md`
//   directive  a malformed deviation directive (below)
//   contract   (warning) a workflows/ runbook router other than CONTEXT.md lacks `## Outputs` or `## Check`
// Scope: AGENTS.md, CLAUDE.md, every CONTEXT.md, and markdown under workspaces/,
// workflows/, references/, jobs/, .omp/templates/.
//
// Recorded deviations: an HTML comment, anywhere in the file,
//   <!-- icm: budget 800, <reason> -->   raises that file's token budget
//   <!-- icm: no-h1, <reason> -->        exempts it from the H1 rule
// A CONTEXT.md may carry one for a sibling file by naming it, so a paste-ready
// body stays clean: <!-- icm: no-h1 linear-ticket-template.md, <reason> -->.
// The reason is required.
//
// IMPORT SAFETY: .omp/tools/ is import-scanned at every session start; all side
// effects live behind import.meta.main.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export type LintKind = "budget" | "path" | "h1" | "claude" | "directive" | "contract" | "reach";

export interface LintError {
	kind: LintKind;
	file: string;
	line?: number;
	message: string;
}

export interface LintResult {
	ok: boolean;
	errors: LintError[];
	/** Never fail the run: paths only in the main checkout, runbooks missing Outputs/Check, runbooks over 1,500 tokens. */
	warnings: LintError[];
	counts: Record<LintKind, number>;
	checked: { files: number; paths: number; foreign: number };
}

const DIRECTIVE = /<!--\s*icm:\s*(budget\s+(\d+)|no-h1)(?:\s+([^\s,]+))?\s*(?:,\s*([^>]*?))?\s*-->/g;

const AGENTS_MAX_LINES = 60;
const ROUTER_MAX_TOKENS = 600;
const TOPIC_MAX_TOKENS = 2500;
const RUNBOOK_WARN_TOKENS = 1500;
const RUNBOOK_MAX_TOKENS = 2500;
const RUNBOOK_SUBFILE = /^workflows\/([^/]+)\/[^/]+\.md$/;
const SCOPE_DIRS = ["workspaces/", "workflows/", "references/", "jobs/", ".omp/templates/"];
/**
 * Top-level names other repos use too (eCard `docs/plans/`, `.claude/rules/`, the API's `jobs/view_jobs/`).
 * A path under one whose second segment is missing from Eva is another repo's path when it has at least
 * this many segments (`jobs/CONTEXT.md` stays checked; `jobs/view_jobs/x.ts` is foreign).
 */
const SHARED_TOP: Record<string, number> = { apps: 2, docs: 2, ".claude": 2, jobs: 3 };
const PATH_TOKEN = /^[A-Za-z0-9._@-]+(\/[A-Za-z0-9._@+-]+)*\/?$/;
/** A whole span that is one path with spaces in its file name (`workspaces/hexagon/Horizon Landing Page.html`). */
const SPACED_PATH = /^[A-Za-z0-9._@-]+\/[^`<>{}*$]*\.[A-Za-z0-9]+$/;
const PLACEHOLDER = /YYYY|\bNN\b|XXXX/;

function git(root: string, args: string[], input?: string): string {
	const r = spawnSync("git", args, { cwd: root, input, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
	return r.stdout ?? "";
}

function inScope(path: string): boolean {
	if (path === "AGENTS.md" || path === "CLAUDE.md") return true;
	if (path === "CONTEXT.md" || path.endsWith("/CONTEXT.md")) return true;
	return SCOPE_DIRS.some((d) => path.startsWith(d));
}

/** Body lines after frontmatter, with their 1-based line numbers. */
function bodyStart(lines: string[]): number {
	if (lines[0] !== "---") return 0;
	const close = lines.indexOf("---", 1);
	return close < 0 ? 0 : close + 1;
}

/** Backticked path-like tokens outside fenced code blocks, with line numbers. */
function backtickedTokens(lines: string[]): { token: string; line: number }[] {
	const out: { token: string; line: number }[] = [];
	let fence = "";
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const f = /^\s*(```|~~~)/.exec(line);
		if (f) {
			if (!fence) fence = f[1];
			else if (f[1] === fence) fence = "";
			continue;
		}
		if (fence) continue;
		for (const m of line.matchAll(/`([^`]+)`/g)) {
			const span = m[1].trim();
			if (span.includes(" ") && !/\s-/.test(span) && SPACED_PATH.test(span)) {
				out.push({ token: span, line: i + 1 });
				continue;
			}
			for (const raw of span.split(/\s+/)) {
				if (raw.includes("://")) continue;
				const token = raw
					.replace(/^[("'[]+/, "")
					.replace(/[)"',.;:\]]+$/, "")
					.replace(/:\d+(-\d+)?(,\d+(-\d+)?)*$/, "")
					.replace(/#.*$/, "");
				if (token && PATH_TOKEN.test(token) && !token.includes("..") && !PLACEHOLDER.test(token)) out.push({ token, line: i + 1 });
			}
		}
	}
	return out;
}

export function lint(root = join(import.meta.dir, "../..")): LintResult {
	const errors: LintError[] = [];
	const warnings: LintError[] = [];
	const all = git(root, ["ls-files", "--cached", "--others", "--exclude-standard"]).split("\n").filter(Boolean);
	const top = new Set(all.map((p) => p.split("/")[0]));
	const files = [...new Set(all.filter((p) => p.endsWith(".md") && inScope(p)))].filter((p) => existsSync(join(root, p))).sort();
	// The main checkout, when linting a worktree: its untracked files land with it.
	const commonDir = git(root, ["rev-parse", "--git-common-dir"]).trim();
	const mainRoot = commonDir ? dirname(resolve(root, commonDir)) : root;
	const texts = new Map(files.map((f) => [f, readFileSync(join(root, f), "utf8")]));

	// claude: the Claude Code entry is a one-line import of AGENTS.md.
	const claude = join(root, "CLAUDE.md");
	if (!existsSync(claude) || readFileSync(claude, "utf8").trim() !== "@AGENTS.md") {
		errors.push({ kind: "claude", file: "CLAUDE.md", message: "must be exactly `@AGENTS.md`" });
	}

	// Recorded deviations, keyed by the file they apply to.
	const budgets = new Map<string, number>();
	const noH1 = new Set<string>();
	for (const [file, text] of texts) {
		for (const m of text.matchAll(DIRECTIVE)) {
			if (text[m.index - 1] === "`") continue; // quoted in docs, not a directive
			const line = text.slice(0, m.index).split("\n").length;
			const isContext = file === "CONTEXT.md" || file.endsWith("/CONTEXT.md");
			if (!m[4]) {
				errors.push({ kind: "directive", file, line, message: "deviation directive needs a reason after the comma" });
				continue;
			}
			if (m[3] && !isContext) {
				errors.push({ kind: "directive", file, line, message: "only a CONTEXT.md may name a sibling file" });
				continue;
			}
			const target = m[3] ? (dirname(file) === "." ? m[3] : `${dirname(file)}/${m[3]}`) : file;
			if (!texts.has(target)) {
				errors.push({ kind: "directive", file, line, message: `names \`${target}\`, which is not a linted file` });
				continue;
			}
			if (m[2]) budgets.set(target, Number(m[2]));
			else noH1.add(target);
		}
	}

	let paths = 0;
	let foreign = 0;
	const missing: { token: string; file: string; line: number }[] = [];
	for (const [file, text] of texts) {
		const lines = text.split("\n");

		// budget
		const size = Math.round(Buffer.byteLength(text) / 4); // tokens = bytes / 4
		const raised = budgets.get(file);
		if (file === "AGENTS.md") {
			const n = text.replace(/\n$/, "").split("\n").length;
			if (n > AGENTS_MAX_LINES) errors.push({ kind: "budget", file, message: `${n} lines (max ${AGENTS_MAX_LINES})` });
		} else if (file === "CONTEXT.md" || file.endsWith("/CONTEXT.md") || /^workspaces\/[^/]+\.md$/.test(file)) {
			const max = raised ?? ROUTER_MAX_TOKENS;
			if (size > max) errors.push({ kind: "budget", file, message: `~${size} tokens (router max ${max}${raised ? ", recorded deviation" : ""})` });
		} else if (file.startsWith("references/")) {
			const max = raised ?? TOPIC_MAX_TOKENS;
			if (size > max) errors.push({ kind: "budget", file, message: `~${size} tokens (topic max ${max}${raised ? ", recorded deviation" : ""})` });
		} else if (file.startsWith("workflows/")) {
			// Runbook routers and their sub-files: one stage or topic per file.
			const max = raised ?? RUNBOOK_MAX_TOKENS;
			const kind = RUNBOOK_SUBFILE.test(file) ? "sub-file" : "runbook";
			if (size > max) errors.push({ kind: "budget", file, message: `~${size} tokens (${kind} max ${max}${raised ? ", recorded deviation" : ""})` });
			else if (!raised && size > RUNBOOK_WARN_TOKENS) {
				warnings.push({ kind: "budget", file, message: `~${size} tokens (${kind} target ${RUNBOOK_WARN_TOKENS}; split it behind a router)` });
			}
		}

		// h1 (CLAUDE.md is an import line, not a document)
		if (file !== "CLAUDE.md" && !noH1.has(file)) {
			const start = bodyStart(lines);
			const first = lines.slice(start).findIndex((l) => l.trim() !== "");
			if (first < 0 || !/^# \S/.test(lines[start + first])) {
				errors.push({ kind: "h1", file, line: first < 0 ? undefined : start + first + 1, message: "does not start with an H1" });
			}
		}

		// contract (warning): runbooks name what they produce and how a pass is observed.
		// A no-h1 file is a paste-ready body (linear-ticket-template.md), not a runbook.
		if (/^workflows\/[^/]+\.md$/.test(file) && file !== "workflows/CONTEXT.md" && !noH1.has(file)) {
			for (const h of ["Outputs", "Check"]) {
				if (!new RegExp(`^## ${h}\\b`, "m").test(text)) warnings.push({ kind: "contract", file, message: `runbook has no \`## ${h}\` section` });
			}
		}

		// reach: a runbook sub-file is named by its router, so moved detail is one hop away.
		const sub = RUNBOOK_SUBFILE.exec(file);
		if (sub) {
			const router = texts.get(`workflows/${sub[1]}.md`);
			if (!router) errors.push({ kind: "reach", file, message: `no router \`workflows/${sub[1]}.md\`` });
			else if (!router.includes(file)) errors.push({ kind: "reach", file, message: `not named in its router \`workflows/${sub[1]}.md\`` });
		}

		// path
		for (const { token, line } of backtickedTokens(lines)) {
			const clean = token.replace(/\/$/, "");
			const segs = clean.split("/");
			if (!top.has(segs[0])) {
				foreign++;
				continue;
			}
			paths++;
			if (existsSync(join(root, clean))) continue;
			const shared = SHARED_TOP[segs[0]];
			if (shared && segs.length >= shared && !existsSync(join(root, segs[0], segs[1]))) {
				foreign++;
				continue;
			}
			missing.push({ token: clean, file, line });
		}
	}

	// Gitignored paths are runtime state (jobs/.runs/, apps/<nested repo>): not checkable from a checkout.
	// Each is asked as a file and as a directory, since `jobs/.runs/` only matches the latter.
	const asked = [...new Set(missing.map((m) => m.token))].flatMap((t) => [t, `${t}/`]);
	const ignored = missing.length
		? new Set(git(root, ["check-ignore", "--no-index", "--stdin"], `${asked.join("\n")}\n`).split("\n").map((p) => p.replace(/\/$/, "")))
		: new Set<string>();
	for (const m of missing) {
		if (ignored.has(m.token)) {
			foreign++;
			paths--;
			continue;
		}
		if (mainRoot !== root && existsSync(join(mainRoot, m.token))) {
			warnings.push({ kind: "path", file: m.file, line: m.line, message: `\`${m.token}\` exists only in the main checkout (untracked there)` });
			continue;
		}
		errors.push({ kind: "path", file: m.file, line: m.line, message: `\`${m.token}\` does not resolve` });
	}

	const counts: Record<LintKind, number> = { budget: 0, path: 0, h1: 0, claude: 0, directive: 0, contract: 0, reach: 0 };
	for (const e of errors) counts[e.kind]++;
	return { ok: errors.length === 0, errors, warnings, counts, checked: { files: files.length, paths, foreign } };
}

function report(result: LintResult): string {
	const out: string[] = [];
	for (const kind of ["claude", "directive", "budget", "h1", "reach", "path"] as LintKind[]) {
		const group = result.errors.filter((e) => e.kind === kind);
		if (!group.length) continue;
		out.push(`${kind} (${group.length})`);
		for (const e of group) out.push(`  ${e.file}${e.line ? `:${e.line}` : ""}  ${e.message}`);
	}
	if (result.warnings.length) {
		out.push(`warnings (${result.warnings.length})`);
		for (const w of result.warnings) out.push(`  ${w.file}${w.line ? `:${w.line}` : ""}  ${w.message}`);
	}
	const { files, paths, foreign } = result.checked;
	const total = result.errors.length;
	const warned = result.warnings.length ? `, ${result.warnings.length} warning${result.warnings.length === 1 ? "" : "s"}` : "";
	out.push(
		`${total ? `${total} error${total === 1 ? "" : "s"}` : "ok"}: ${files} files, ${paths} paths checked, ${foreign} foreign skipped${warned}` +
			(total ? ` (${Object.entries(result.counts).filter(([, n]) => n).map(([k, n]) => `${k} ${n}`).join(", ")})` : ""),
	);
	return out.join("\n");
}

if (import.meta.main) {
	const rootFlag = process.argv.indexOf("--root");
	const root = rootFlag >= 0 ? process.argv[rootFlag + 1] : join(import.meta.dir, "../..");
	if (!existsSync(root) || !statSync(root).isDirectory()) {
		console.error(`icm-lint: no such root ${root}`);
		process.exit(2);
	}
	const result = lint(root);
	console.log(process.argv.includes("--json") ? JSON.stringify(result, null, 2) : report(result));
	process.exit(result.ok ? 0 : 1);
}
