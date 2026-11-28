// Timeline plan data on the host (PLAN T7.1, T7.3). `plan.json` under the tickets dir keeps the
// Relay-only Timeline starts per Linear account, by issue id:
// `{v: 2, accounts: {[viewerId]: {starts: {[issueId]: 'YYYY-MM-DD'}, applied: [rowOpId]}}}`. A bar's
// start is never written to Linear; it is saved only through the gate's confirmed `applyPlan`, once
// the row's Linear part (if any) is written, and only when the start is still the one the draft was
// made from (compare-and-set), so another device's newer start is never overwritten. `applied` keeps
// the row opIds whose start was saved, so a replayed outcome doesn't save it twice. A v1 file (starts
// by key, no account) is dropped: a key can name another issue on another account. Another account
// (the tickets wipe) clears it all.
// `validateProposal` checks Astra's re-plan answer against the baseline (the visible tickets when
// Isaac asked) and a live read before a device sees it: rows outside the scope, with impossible
// effective dates, or whose issue is gone, closed or now has another key are dropped; rows whose
// ticket or Relay start changed since the baseline are flagged stale.

import { join } from "node:path";
import { TERMINAL_TICKET_STATE_TYPES, TicketPlanProposal, TimelessDate, type TicketBoardFacts, type TicketPlanBaseline, type TicketStateType } from "@relay/protocol";
import { z } from "zod";
import { readJson, writeJson } from "../reviews/exec";
import type { LinearGql } from "../reviews/linear";

/** Row opIds whose start was saved, kept per account (oldest dropped first). */
export const MAX_APPLIED_STARTS = 2000;

const Account = z.object({ starts: z.record(z.string(), TimelessDate), applied: z.array(z.string()) });
type Account = z.infer<typeof Account>;
const PlanFile = z.object({ v: z.literal(2), accounts: z.record(z.string(), Account) });

/** One start the gate's `applyPlan` wrote a row for. */
export interface StartRow {
  readonly issueId: string;
  readonly opId: string;
  readonly plannedStart: string | null;
  /** The start the draft was made from (absent: none). */
  readonly basePlannedStart?: string | null | undefined;
}

export const START_MOVED = "its Relay start changed on another device since this plan was made";

/** `plan.json`: Relay-only Timeline starts per account, by issue id. */
export class PlanStore {
  private readonly path: string;
  private accounts: Record<string, Account>;

  constructor(dir: string) {
    this.path = join(dir, "plan.json");
    const parsed = PlanFile.safeParse(readJson(this.path, null));
    this.accounts = parsed.success ? parsed.data.accounts : {};
  }

  /** The issue's Relay-only start for this account; null: none. */
  get(viewerId: string | null, issueId: string): string | null {
    return viewerId === null ? null : (this.accounts[viewerId]?.starts[issueId] ?? null);
  }

  /** Whether this row opId's start was saved already (a replayed outcome saves nothing again). */
  applied(viewerId: string, opId: string): boolean {
    return this.accounts[viewerId]?.applied.includes(opId) === true;
  }

  /** Why this row's start can't be saved now (another device moved it since the draft), or null. */
  startProblem(viewerId: string, row: StartRow): string | null {
    const now = this.get(viewerId, row.issueId);
    return now === (row.basePlannedStart ?? null) || now === row.plannedStart ? null : START_MOVED;
  }

  /** Sets (or, null, clears) each row's start, records its opId and saves once (throws when it can't). */
  save(viewerId: string, rows: readonly StartRow[]): void {
    if (rows.length === 0) return;
    const prev = this.accounts[viewerId] ?? { starts: {}, applied: [] };
    const starts = { ...prev.starts };
    for (const r of rows) {
      if (r.plannedStart === null) delete starts[r.issueId];
      else starts[r.issueId] = r.plannedStart;
    }
    const applied = [...prev.applied.filter((id) => !rows.some((r) => r.opId === id)), ...rows.map((r) => r.opId)].slice(-MAX_APPLIED_STARTS);
    const accounts = { ...this.accounts, [viewerId]: { starts, applied } };
    writeJson(this.path, { v: 2, accounts });
    this.accounts = accounts;
  }

  /** Another account: no start of the old one stays. */
  wipe(): void {
    this.accounts = {};
    writeJson(this.path, { v: 2, accounts: {} });
  }
}

/** A ticket as a re-plan's baseline holds it. */
export function baselineOf(t: TicketBoardFacts): TicketPlanBaseline {
  return { key: t.key, issueId: t.id, updatedAt: t.updatedAt, dueDate: t.dueDate, priority: t.priority, prioritySortOrder: t.prioritySortOrder, plannedStart: t.plannedStart ?? null };
}

/** An issue as Linear has it now. */
export interface LiveIssue {
  readonly identifier: string;
  readonly updatedAt: number;
  /** Done or canceled: off the Timeline. */
  readonly closed: boolean;
}

const FRESHNESS = `query TicketPlanFreshness($ids: [ID!]!) { issues(filter: { id: { in: $ids } }, first: 250) { nodes { id identifier updatedAt state { type } } } }`;
const Freshness = z.object({ issues: z.object({ nodes: z.array(z.object({ id: z.string(), identifier: z.string(), updatedAt: z.string(), state: z.object({ type: z.string() }) })) }) });

/** The issues by id as Linear has them now (one read); a missing id is gone or unreadable. */
export async function planFreshness(gql: LinearGql, ids: readonly string[]): Promise<ReadonlyMap<string, LiveIssue>> {
  if (ids.length === 0) return new Map();
  const data = Freshness.parse(await gql(FRESHNESS, { ids }));
  return new Map(data.issues.nodes.map((n) => [n.id, { identifier: n.identifier, updatedAt: Date.parse(n.updatedAt), closed: TERMINAL_TICKET_STATE_TYPES[n.state.type as TicketStateType] === true }]));
}

/** The re-plan's baseline and what is true now. */
export interface PlanBaseline {
  /** The scope's visible tickets when Isaac asked, by key. */
  readonly at: Readonly<Record<string, TicketPlanBaseline>>;
  /** Linear now by issue id (a live read); null: it couldn't be read, so every row is stale. */
  readonly live: ReadonlyMap<string, LiveIssue> | null;
  /** The Relay starts now, by key. */
  readonly starts: Readonly<Record<string, string | null>>;
}

export const UNREADABLE_PLAN = "Couldn't read a plan from this answer";

export type ProposalCheck =
  | { ok: false; error: typeof UNREADABLE_PLAN }
  | {
      ok: true;
      /** The proposal with only the rows that may be applied, and their baseline. */
      proposal: TicketPlanProposal;
      /** Keys dropped: outside the scope at the baseline, impossible dates, gone, closed or re-keyed. */
      dropped: string[];
      /** Keys whose ticket or start changed since the baseline (kept; the device compares again). */
      stale: string[];
    };

/** A real calendar day (TimelessDate's regex also takes 2026-02-30). */
function isDay(s: string): boolean {
  const [y, m, d] = s.split("-").map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

type Change = TicketPlanProposal["changes"][number];

/** Both real days (or absent) and the start not after the due date. */
export function validPair(start: string | null, due: string | null): boolean {
  if (start !== null && !isDay(start)) return false;
  if (due !== null && !isDay(due)) return false;
  return start === null || due === null || start <= due;
}

/** A row whose dates hold: still the same open issue in Linear (else drop), unchanged since (else stale). */
function liveVerdict(c: Change, at: TicketPlanBaseline, b: PlanBaseline): "drop" | "stale" | "ok" {
  if (b.live === null) return "stale";
  const live = b.live.get(at.issueId);
  if (live === undefined || live.identifier !== c.key || live.closed) return "drop";
  return live.updatedAt !== at.updatedAt || (b.starts[c.key] ?? null) !== at.plannedStart ? "stale" : "ok";
}

/** A field the row doesn't change keeps the baseline's: the pair it would leave must be valid. */
function verdict(c: Change, b: PlanBaseline): "drop" | "stale" | "ok" {
  const at = b.at[c.key];
  if (at === undefined) return "drop";
  const start = c.start === undefined ? at.plannedStart : c.start;
  return validPair(start, c.dueDate === undefined ? at.dueDate : c.dueDate) ? liveVerdict(c, at, b) : "drop";
}

/**
 * Astra's answer checked against the baseline: the schema (priorities 0-4, finite orders,
 * `YYYY-MM-DD` dates) or the whole answer is unreadable; then each row's key must be one of the
 * scope's visible tickets at the baseline, its effective start <= due, and its issue still open
 * under that key in Linear, else it is dropped; a ticket or start changed since is flagged stale.
 */
export function validateProposal(proposal: unknown, baseline: PlanBaseline): ProposalCheck {
  const parsed = TicketPlanProposal.safeParse(proposal);
  if (!parsed.success) return { ok: false, error: UNREADABLE_PLAN };
  const dropped: string[] = [];
  const stale: string[] = [];
  const changes: Change[] = [];
  for (const c of parsed.data.changes) {
    const v = verdict(c, baseline);
    if (v === "drop") {
      dropped.push(c.key);
      continue;
    }
    if (v === "stale" && !stale.includes(c.key)) stale.push(c.key);
    changes.push(c);
  }
  const keys = new Set(changes.map((c) => c.key));
  const rows = Object.values(baseline.at).filter((r) => keys.has(r.key));
  const out: TicketPlanProposal = { summary: parsed.data.summary, changes, baseline: rows, ...(stale.length > 0 && { stale }) };
  return { ok: true, proposal: out, dropped, stale };
}
