// The ticket summary card: 2-3 plain sentences on what a ticket is, where it stands and what's
// next, written by Claude headless (`claude -p`, no tools, no session) from the synced facts. Kept
// per ticket snapshot in `$XDG_CONFIG_HOME/relay/tickets/summaries.json`, so a ticket is written
// once per change; an answer for a snapshot that moved on meanwhile is dropped.

import { createHash } from "node:crypto";
import { join } from "node:path";
import type { TicketPrFacts } from "@relay/protocol";
import { z } from "zod";
import { readJson, writeJson } from "../reviews/exec";
import type { GuideWriter } from "../reviews/guide";
import type { IssueEntry } from "./store";

const KEEP_SUMMARIES = 200;
const MAX_WORDS = 60;
export const SNAPSHOT_CHANGED = "Ticket changed; summarizing again";
/** What a client sees when Claude can't be run: never its exit text or stderr. */
export const SUMMARY_FAILED = "Couldn't write a summary. Try again in a moment.";

/** Runs the prompt once and answers the model's text (`claudeWriter`). */
export type SummaryWriter = GuideWriter;

/** What a summary is written from: the stored issue and its PRs' facts. */
export interface SummarySnapshot {
  readonly entry: IssueEntry;
  readonly prs: readonly TicketPrFacts[];
}

export interface SummaryAnswer {
  /** Null: no valid summary (facts only). */
  readonly text: string | null;
  readonly error: string | null;
  readonly at: number;
}

const Saved = z.object({
  v: z.literal(1),
  entries: z.record(z.string(), z.object({ text: z.string(), at: z.number() })),
});
type Saved = z.infer<typeof Saved>;

/** Changes whenever anything the summary reads changes. */
export function snapshotKey(s: SummarySnapshot): string {
  const { ticket, comments } = s.entry;
  const parts = [ticket.updatedAt, comments.length, comments.at(-1)?.id ?? null, s.prs.map((p) => [p.repo, p.number, p.updatedAt, p.headSha])];
  return `${ticket.id}@${createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 24)}`;
}

const SYSTEM = [
  "You write the short summary card at the top of a ticket, for Isaac who runs eCard Systems engineering.",
  'Write two or three short plain sentences, under 60 words in total, the way a person would say it out loud: what the ticket is about, where it stands (who settled what, what state the pull request is in, in words like "still a draft with no reviewers"), and the next step if one is clear.',
  'No field dumps, no "Status: X" lists, no ticket IDs, PR numbers or links, no markdown, no headings, no em dashes. Use only the facts given; never invent. Answer with the summary only.',
].join("\n\n");

function prLine(p: TicketPrFacts): string {
  const draft = p.draft ? " (draft)" : "";
  return `${p.title}: ${p.state}${draft}, checks: ${p.checks.state}, review: ${p.decision ?? "none"}, merge state: ${p.mergeState ?? "unknown"}`;
}

/** The ticket's own facts, as prompt lines. */
function ticketLines(t: IssueEntry["ticket"]): string[] {
  const lines = [
    `TICKET: ${t.title}`,
    `State: ${t.state.name}. Assignee: ${t.assignee?.name ?? "none"}. Priority: ${String(t.priority)}. Project: ${t.project?.name ?? "none"}.`,
    `Description: ${t.description.slice(0, 3000)}`,
  ];
  if (t.children.length > 0) lines.push(`Sub-issues: ${t.children.map((c) => `${c.title} (${c.done ? "done" : "open"})`).join("; ")}`);
  if (t.relations.length > 0) lines.push(`Related: ${t.relations.map((r) => `${r.kind} ${r.title}`).join("; ")}`);
  return lines;
}

/** The prompt; `violation` names what the previous answer got wrong. */
export function summaryPrompt(s: SummarySnapshot, violation: string | null = null): string {
  const lines = [SYSTEM, ...ticketLines(s.entry.ticket), "\nCOMMENTS (oldest first)"];
  for (const c of s.entry.comments.slice(-12)) lines.push(`${c.author?.name ?? "someone"} (${new Date(c.at).toISOString().slice(0, 10)}): ${c.body.slice(0, 700)}`);
  lines.push("\nPULL REQUESTS", ...(s.prs.length > 0 ? s.prs.map(prLine) : ["none"]));
  if (violation !== null) lines.push(`\nYour previous answer was rejected: ${violation}. Fix that.`);
  lines.push("\nWrite the summary now.");
  return lines.join("\n");
}

/** What's wrong with the answer, or null when it is a valid summary. */
export function summaryViolation(text: string): string | null {
  if (text.includes("\u2014")) return "it used an em dash";
  if (/\bENG-\d+\b/i.test(text)) return "it named a ticket ID";
  if (/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(text)) return "it contained an ID";
  if (/https?:\/\/|www\./i.test(text)) return "it contained a link";
  const words = text.split(/\s+/).filter(Boolean).length;
  if (words > MAX_WORDS) return `it was ${String(words)} words, over ${String(MAX_WORDS)}`;
  const sentences = text.split(/[.!?]+(?:\s+|$)/).filter((s) => s.trim() !== "").length;
  if (sentences < 2 || sentences > 3) return `it was ${String(sentences)} sentences, not 2 or 3`;
  return null;
}

/** One valid answer, retried once with the violation named; throws when the model can't be run. */
async function writeSummary(write: SummaryWriter, s: SummarySnapshot): Promise<{ text: string | null; error: string | null }> {
  let violation: string | null = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const text = (await write(summaryPrompt(s, violation))).trim();
    violation = summaryViolation(text);
    if (violation === null) return { text, error: null };
  }
  return { text: null, error: `Claude's summary was rejected: ${violation ?? "invalid"}` };
}

/** Summaries per ticket snapshot in `dir/summaries.json`; one generation at a time per snapshot. */
export class SummaryCache {
  private readonly file: string;
  private readonly running = new Map<string, Promise<SummaryAnswer>>();

  constructor(
    dir: string,
    private readonly write: SummaryWriter,
    private readonly now: () => number,
  ) {
    this.file = join(dir, "summaries.json");
  }

  /** The summary for `snapshot`; `current` re-reads the ticket to drop an answer that went stale. */
  read(snapshot: SummarySnapshot, current: () => SummarySnapshot | undefined): Promise<SummaryAnswer> {
    const key = snapshotKey(snapshot);
    const hit = this.saved().entries[key];
    if (hit) return Promise.resolve({ text: hit.text, error: null, at: hit.at });
    const busy = this.running.get(key);
    if (busy) return busy;
    const job = this.generate(key, snapshot, current).finally(() => this.running.delete(key));
    this.running.set(key, job);
    return job;
  }

  private async generate(key: string, snapshot: SummarySnapshot, current: () => SummarySnapshot | undefined): Promise<SummaryAnswer> {
    let out: { text: string | null; error: string | null };
    try {
      out = await writeSummary(this.write, snapshot);
    } catch {
      out = { text: null, error: SUMMARY_FAILED };
    }
    const now = current();
    if (now === undefined || snapshotKey(now) !== key) return { text: null, error: SNAPSHOT_CHANGED, at: this.now() };
    const at = this.now();
    if (out.text !== null) this.keep(key, out.text, at);
    return { ...out, at };
  }

  private saved(): Saved {
    const all = Saved.safeParse(readJson(this.file, {}));
    return all.success ? all.data : { v: 1, entries: {} };
  }

  private keep(key: string, text: string, at: number): void {
    const kept = Object.entries({ ...this.saved().entries, [key]: { text, at } })
      .sort((a, b) => b[1].at - a[1].at)
      .slice(0, KEEP_SUMMARIES);
    writeJson(this.file, { v: 1, entries: Object.fromEntries(kept) });
  }
}
