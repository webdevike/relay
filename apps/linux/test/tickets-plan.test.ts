import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TicketPlanBaseline } from "@relay/protocol";
import { MAX_APPLIED_STARTS, PlanStore, START_MOVED, UNREADABLE_PLAN, validateProposal, type LiveIssue, type PlanBaseline } from "../src/tickets/plan";

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tickets-plan-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const OP = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

describe("PlanStore (plan.json)", () => {
  it("keeps Relay-only starts per account by issue id; null clears one", () => {
    const store = new PlanStore(dir);
    expect(store.get("user-a", "issue-1")).toBeNull();
    store.save("user-a", [
      { issueId: "issue-1", opId: OP(1), plannedStart: "2026-12-01" },
      { issueId: "issue-2", opId: OP(2), plannedStart: "2026-12-04" },
    ]);
    store.save("user-a", [{ issueId: "issue-2", opId: OP(3), plannedStart: null }]);
    expect(JSON.parse(readFileSync(join(dir, "plan.json"), "utf8"))).toEqual({ v: 2, accounts: { "user-a": { starts: { "issue-1": "2026-12-01" }, applied: [OP(1), OP(2), OP(3)] } } });
    const again = new PlanStore(dir);
    expect(again.get("user-a", "issue-1")).toBe("2026-12-01");
    expect(again.applied("user-a", OP(1))).toBe(true);
    // Another account (a same-key workspace) never sees them.
    expect(again.get("user-b", "issue-1")).toBeNull();
    expect(again.get(null, "issue-1")).toBeNull();
  });

  it("compares and sets: a start another device moved since the draft can't be saved", () => {
    const store = new PlanStore(dir);
    store.save("user-a", [{ issueId: "issue-1", opId: OP(1), plannedStart: "2026-12-01" }]);
    expect(store.startProblem("user-a", { issueId: "issue-1", opId: OP(2), plannedStart: "2026-12-03", basePlannedStart: "2026-12-01" })).toBeNull();
    expect(store.startProblem("user-a", { issueId: "issue-1", opId: OP(2), plannedStart: "2026-12-03", basePlannedStart: null })).toBe(START_MOVED);
    // Already at the target (an earlier try saved it): nothing to refuse.
    expect(store.startProblem("user-a", { issueId: "issue-1", opId: OP(2), plannedStart: "2026-12-01", basePlannedStart: null })).toBeNull();
  });

  it("drops a v1 file (starts by key, no account), a broken one, and everything on wipe", () => {
    writeFileSync(join(dir, "plan.json"), JSON.stringify({ v: 1, starts: { "ENG-1": "2026-12-01" } }));
    expect(new PlanStore(dir).get("user-a", "ENG-1")).toBeNull();
    writeFileSync(join(dir, "plan.json"), "{nope");
    const store = new PlanStore(dir);
    store.save("user-a", [{ issueId: "issue-1", opId: OP(1), plannedStart: "2026-12-01" }]);
    store.wipe();
    expect(store.get("user-a", "issue-1")).toBeNull();
    expect(new PlanStore(dir).get("user-a", "issue-1")).toBeNull();
  });

  it("keeps the newest applied row ids only", () => {
    const store = new PlanStore(dir);
    for (let i = 0; i <= MAX_APPLIED_STARTS; i++) store.save("user-a", [{ issueId: "issue-1", opId: OP(i), plannedStart: "2026-12-01" }]);
    expect(store.applied("user-a", OP(0))).toBe(false);
    expect(store.applied("user-a", OP(MAX_APPLIED_STARTS))).toBe(true);
  });
});

describe("validateProposal", () => {
  const T0 = Date.parse("2026-11-20T10:00:00Z");
  const row = (key: string, over: Partial<TicketPlanBaseline> = {}): TicketPlanBaseline => ({ key, issueId: `issue-${key}`, updatedAt: T0, dueDate: "2026-12-09", priority: 2, prioritySortOrder: 1, plannedStart: null, ...over });
  const at = { "ENG-1": row("ENG-1"), "ENG-2": row("ENG-2"), "ENG-3": row("ENG-3", { plannedStart: "2026-12-01" }) };
  const live = (over: Record<string, Partial<LiveIssue> | null> = {}): Map<string, LiveIssue> =>
    new Map(Object.values(at).flatMap((r): [string, LiveIssue][] => (over[r.key] === null ? [] : [[r.issueId, { identifier: r.key, updatedAt: r.updatedAt, closed: false, ...over[r.key] }]])));
  const baseline = (o: Partial<PlanBaseline> = {}): PlanBaseline => ({ at, live: live(), starts: { "ENG-3": "2026-12-01" }, ...o });
  const change = (key: string, over: Record<string, unknown> = {}) => ({ key, dueDate: "2026-12-09", reason: "r", ...over });

  it("keeps rows of the scope at the baseline with their baseline, and drops the rest", () => {
    const out = validateProposal({ summary: "s", changes: [change("ENG-1"), change("ENG-9")] }, baseline());
    expect(out).toEqual({ ok: true, proposal: { summary: "s", changes: [change("ENG-1")], baseline: [at["ENG-1"]] }, dropped: ["ENG-9"], stale: [] });
  });

  it("flags rows whose ticket changed in Linear or whose Relay start moved since the baseline as stale", () => {
    const out = validateProposal({ summary: "s", changes: [change("ENG-1"), change("ENG-2"), change("ENG-3")] }, baseline({ live: live({ "ENG-2": { updatedAt: T0 + 1 } }), starts: { "ENG-3": "2026-12-02" } }));
    expect(out.ok && out.stale).toEqual(["ENG-2", "ENG-3"]);
    expect(out.ok && out.proposal.stale).toEqual(["ENG-2", "ENG-3"]);
  });

  it("drops a gone, closed or re-keyed issue; without a live read every row is stale", () => {
    const out = validateProposal({ summary: "s", changes: [change("ENG-1"), change("ENG-2"), change("ENG-3")] }, baseline({ live: live({ "ENG-1": null, "ENG-2": { closed: true }, "ENG-3": { identifier: "OPS-3" } }) }));
    expect(out.ok && out.dropped).toEqual(["ENG-1", "ENG-2", "ENG-3"]);
    const blind = validateProposal({ summary: "s", changes: [change("ENG-1")] }, baseline({ live: null }));
    expect(blind.ok && blind.stale).toEqual(["ENG-1"]);
  });

  it("checks the pair each row leaves: impossible dates, a start after the due date, a start-only row after the unchanged due", () => {
    const out = validateProposal(
      {
        summary: "s",
        changes: [
          change("ENG-1", { dueDate: "2026-02-30" }),
          change("ENG-2", { start: "2026-12-10", dueDate: "2026-12-09" }),
          // ENG-3 starts 2026-12-01 (Relay): a due date before it is refused too.
          change("ENG-3", { dueDate: "2026-11-30" }),
          { key: "ENG-1", start: "2026-12-10", reason: "after the unchanged due 2026-12-09" },
          { key: "ENG-2", start: "2026-12-01", dueDate: null, reason: "no due date" },
        ],
      },
      baseline(),
    );
    expect(out.ok && out.dropped).toEqual(["ENG-1", "ENG-2", "ENG-3", "ENG-1"]);
    expect(out.ok && out.proposal.changes.map((c) => c.key)).toEqual(["ENG-2"]);
  });

  it("refuses an answer that isn't a plan: priority outside 0-4, non-finite order, bad date, junk", () => {
    for (const bad of [
      { summary: "s", changes: [change("ENG-1", { priority: 5 })] },
      { summary: "s", changes: [change("ENG-1", { priority: 1.5 })] },
      { summary: "s", changes: [change("ENG-1", { prioritySortOrder: Infinity })] },
      { summary: "s", changes: [change("ENG-1", { dueDate: "Dec 9" })] },
      { summary: "s", changes: [{ key: "ENG-1" }] },
      "Here is my plan: move everything up",
      null,
    ]) {
      expect(validateProposal(bad, baseline())).toEqual({ ok: false, error: UNREADABLE_PLAN });
    }
  });

  it("accepts priorities 0 (None) through 4 and finite orders", () => {
    const changes = [0, 1, 2, 3, 4].map((p, i) => change("ENG-1", { priority: p, prioritySortOrder: -1.5 * i }));
    const out = validateProposal({ summary: "s", changes }, baseline());
    expect(out.ok && out.proposal.changes).toHaveLength(5);
  });
});
