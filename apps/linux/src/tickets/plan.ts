// Timeline plan data on the host (PLAN T7.1, T7.3). `plan.json` under the tickets dir keeps the
// Relay-only Timeline starts `{v: 1, starts: {[key]: 'YYYY-MM-DD'}}`: a bar's start is never
// written to Linear (only due dates, priorities and orders are, through the gate's `applyPlan`).
// `validateProposal` checks Astra's re-plan answer against the draft's baseline before a device
// sees it: rows outside the scope or with impossible dates are dropped, rows whose ticket changed
// since the baseline are flagged stale.

import { join } from "node:path";
import { TicketKey, TicketPlanProposal, TimelessDate } from "@relay/protocol";
import { z } from "zod";
import { readJson, writeJson } from "../reviews/exec";

const PlanFile = z.object({ v: z.literal(1), starts: z.record(TicketKey, TimelessDate) });

/** `plan.json`: Relay-only Timeline starts by ticket key. */
export class PlanStore {
  private readonly path: string;
  private readonly starts: Record<string, string>;

  constructor(dir: string) {
    this.path = join(dir, "plan.json");
    const parsed = PlanFile.safeParse(readJson(this.path, null));
    this.starts = parsed.success ? { ...parsed.data.starts } : {};
  }

  /** The ticket's Relay-only start; null: none. */
  get(key: string): string | null {
    return this.starts[key] ?? null;
  }

  all(): Readonly<Record<string, string>> {
    return this.starts;
  }

  /** Sets (or, null, clears) each row's start and saves once. */
  set(rows: readonly { key: string; plannedStart: string | null }[]): void {
    for (const r of rows) {
      if (r.plannedStart === null) delete this.starts[r.key];
      else this.starts[r.key] = r.plannedStart;
    }
    writeJson(this.path, { v: 1, starts: this.starts });
  }
}

/** The draft's baseline: the scope's tickets and their `updatedAt` then, and now. */
export interface PlanBaseline {
  /** The milestone's (or project's) tickets when the draft was made: key -> updatedAt. */
  readonly at: Readonly<Record<string, number>>;
  /** Their `updatedAt` now; a missing key left the board. */
  readonly now: Readonly<Record<string, number>>;
}

export const UNREADABLE_PLAN = "Couldn't read a plan from this answer";

export type ProposalCheck =
  | { ok: false; error: typeof UNREADABLE_PLAN }
  | {
      ok: true;
      /** The proposal with only the rows that may be applied. */
      proposal: TicketPlanProposal;
      /** Keys dropped: outside the scope at the baseline, or impossible dates. */
      dropped: string[];
      /** Keys whose ticket changed since the baseline (kept; the device reconfirms them). */
      stale: string[];
    };

/** A real calendar day (TimelessDate's regex also takes 2026-02-30). */
function isDay(s: string): boolean {
  const [y, m, d] = s.split("-").map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

type Change = TicketPlanProposal["changes"][number];

function validDates(c: Change): boolean {
  const start = c.start ?? null;
  const due = c.dueDate ?? null;
  if (start !== null && !isDay(start)) return false;
  if (due !== null && !isDay(due)) return false;
  return start === null || due === null || start <= due;
}

/**
 * Astra's answer checked against the baseline: the schema (priorities 0-4, finite orders,
 * `YYYY-MM-DD` dates) or the whole answer is unreadable; then keys must be the scope's tickets at
 * the baseline and dates real days with start <= due, else the row is dropped; a ticket changed
 * since the baseline is flagged stale.
 */
export function validateProposal(proposal: unknown, baseline: PlanBaseline): ProposalCheck {
  const parsed = TicketPlanProposal.safeParse(proposal);
  if (!parsed.success) return { ok: false, error: UNREADABLE_PLAN };
  const dropped: string[] = [];
  const stale: string[] = [];
  const changes: Change[] = [];
  for (const c of parsed.data.changes) {
    const at = baseline.at[c.key];
    if (at === undefined || !validDates(c)) {
      dropped.push(c.key);
      continue;
    }
    if (baseline.now[c.key] !== at) stale.push(c.key);
    changes.push(c);
  }
  return { ok: true, proposal: { summary: parsed.data.summary, changes }, dropped, stale };
}
