import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PlanStore, UNREADABLE_PLAN, validateProposal, type PlanBaseline } from "../src/tickets/plan";

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tickets-plan-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("PlanStore (plan.json)", () => {
  it("saves and loads Relay-only starts; null clears one", () => {
    const store = new PlanStore(dir);
    expect(store.get("ENG-1")).toBeNull();
    store.set([
      { key: "ENG-1", plannedStart: "2026-12-01" },
      { key: "ENG-2", plannedStart: "2026-12-04" },
    ]);
    store.set([{ key: "ENG-2", plannedStart: null }]);
    expect(JSON.parse(readFileSync(join(dir, "plan.json"), "utf8"))).toEqual({ v: 1, starts: { "ENG-1": "2026-12-01" } });
    const again = new PlanStore(dir);
    expect(again.get("ENG-1")).toBe("2026-12-01");
    expect(again.all()).toEqual({ "ENG-1": "2026-12-01" });
  });

  it("starts empty from a missing, broken or other-version file", () => {
    writeFileSync(join(dir, "plan.json"), "{nope");
    expect(new PlanStore(dir).all()).toEqual({});
    writeFileSync(join(dir, "plan.json"), JSON.stringify({ v: 2, starts: { "ENG-1": "2026-12-01" } }));
    expect(new PlanStore(dir).all()).toEqual({});
    writeFileSync(join(dir, "plan.json"), JSON.stringify({ v: 1, starts: { "ENG-1": "Dec 1" } }));
    expect(new PlanStore(dir).all()).toEqual({});
  });
});

describe("validateProposal", () => {
  const T0 = Date.parse("2026-11-20T10:00:00Z");
  const baseline: PlanBaseline = {
    at: { "ENG-1": T0, "ENG-2": T0, "ENG-3": T0 },
    now: { "ENG-1": T0, "ENG-2": T0 + 1 },
  };
  const change = (key: string, over: Record<string, unknown> = {}) => ({ key, dueDate: "2026-12-09", reason: "r", ...over });

  it("keeps rows of the scope at the baseline and drops the rest", () => {
    const out = validateProposal({ summary: "s", changes: [change("ENG-1"), change("ENG-9")] }, baseline);
    expect(out).toEqual({ ok: true, proposal: { summary: "s", changes: [change("ENG-1")] }, dropped: ["ENG-9"], stale: [] });
  });

  it("flags rows whose ticket changed (or left the board) since the baseline as stale", () => {
    const out = validateProposal({ summary: "s", changes: [change("ENG-2"), change("ENG-3")] }, baseline);
    expect(out.ok && out.stale).toEqual(["ENG-2", "ENG-3"]);
    expect(out.ok && out.proposal.changes.map((c) => c.key)).toEqual(["ENG-2", "ENG-3"]);
  });

  it("drops impossible dates and a start after the due date", () => {
    const out = validateProposal(
      {
        summary: "s",
        changes: [
          change("ENG-1", { dueDate: "2026-02-30" }),
          change("ENG-2", { start: "2026-12-10", dueDate: "2026-12-09" }),
          change("ENG-3", { start: "2026-12-01", dueDate: null }),
        ],
      },
      baseline,
    );
    expect(out.ok && out.dropped).toEqual(["ENG-1", "ENG-2"]);
    expect(out.ok && out.proposal.changes.map((c) => c.key)).toEqual(["ENG-3"]);
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
      expect(validateProposal(bad, baseline)).toEqual({ ok: false, error: UNREADABLE_PLAN });
    }
  });

  it("accepts priorities 0 (None) through 4 and finite orders", () => {
    const changes = [0, 1, 2, 3, 4].map((p, i) => change("ENG-1", { priority: p, prioritySortOrder: -1.5 * i }));
    const out = validateProposal({ summary: "s", changes }, baseline);
    expect(out.ok && out.proposal.changes).toHaveLength(5);
  });
});
