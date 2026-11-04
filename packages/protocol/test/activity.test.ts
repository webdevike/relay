import { describe, expect, it } from "vitest";
import { ActivityItem, DAY_MS, mergeActivity, parseServerMessage, type ActivityKind } from "../src";

const NOW = new Date(2026, 10, 4, 14, 0).getTime();
const ALL: ReadonlySet<ActivityKind> = new Set(["helper", "session", "harness", "canvas"]);

function item(over: Partial<ActivityItem> & Pick<ActivityItem, "id">): ActivityItem {
  return {
    kind: "helper",
    owner: "assistant:nova",
    title: over.id,
    status: "working",
    intent: "",
    startedAt: NOW - 60_000,
    updatedAt: NOW - 60_000,
    open: { to: "subagent", file: `/s/${over.id}.jsonl`, name: over.id },
    ...over,
  };
}

describe("mergeActivity", () => {
  it("keeps the start of a run that goes on, and moves updatedAt only when something changed", () => {
    const before = [item({ id: "a", intent: "Reading the diff" })];
    const same = mergeActivity(before, [item({ id: "a", intent: "Reading the diff", startedAt: NOW })], ALL, NOW);
    expect(same[0]).toMatchObject({ startedAt: NOW - 60_000, updatedAt: NOW - 60_000 });
    const moved = mergeActivity(before, [item({ id: "a", intent: "Running tests" })], ALL, NOW);
    expect(moved[0]).toMatchObject({ intent: "Running tests", startedAt: NOW - 60_000, updatedAt: NOW });
  });

  it("ends what the sources stop reporting, and drops finished rows after a day", () => {
    const before = [item({ id: "gone" }), item({ id: "old", status: "done", updatedAt: NOW - DAY_MS - 1 }), item({ id: "recent", status: "done", updatedAt: NOW - 1000 })];
    const next = mergeActivity(before, [], ALL, NOW);
    expect(next.map((i) => [i.id, i.status])).toEqual([
      ["gone", "done"],
      ["recent", "done"],
    ]);
    expect(next.find((i) => i.id === "gone")?.updatedAt).toBe(NOW);
  });

  it("a finished helper reported working again (woken by a follow-up) is a new run", () => {
    const before = [item({ id: "h", status: "done", startedAt: NOW - 3_600_000, updatedAt: NOW - 1_800_000 })];
    const next = mergeActivity(before, [item({ id: "h", status: "working", intent: "Applying the follow-up", startedAt: NOW - 3_600_000 })], ALL, NOW);
    expect(next[0]).toMatchObject({ status: "working", startedAt: NOW, updatedAt: NOW, intent: "Applying the follow-up" });
  });

  it("walks working to waiting to working to done without losing the start", () => {
    const run = (status: ActivityItem["status"], intent: string, previous: ActivityItem[], at: number): ActivityItem[] => mergeActivity(previous, [item({ id: "s", kind: "session", status, intent })], ALL, at);
    let list = run("working", "Editing", [], NOW);
    list = run("waiting", "Approve bash: git push", list, NOW + 1000);
    expect(list[0]).toMatchObject({ status: "waiting", intent: "Approve bash: git push", startedAt: NOW - 60_000, updatedAt: NOW + 1000 });
    list = run("working", "Pushing", list, NOW + 2000);
    expect(list[0]).toMatchObject({ status: "working", startedAt: NOW - 60_000 });
    list = mergeActivity(list, [], ALL, NOW + 3000);
    expect(list[0]).toMatchObject({ status: "done", updatedAt: NOW + 3000 });
  });

  it("leaves the kinds whose source did not answer exactly as they were", () => {
    const harness = item({ id: "harness:w1:p2", kind: "harness", owner: "other", open: { to: "terminal", pane: "w1:p2" } });
    const next = mergeActivity([harness], [], new Set<ActivityKind>(["helper", "session", "canvas"]), NOW);
    expect(next).toEqual([harness]);
  });

  it("lists active rows first, newest change first", () => {
    const next = mergeActivity(
      [],
      [item({ id: "d", status: "done", updatedAt: NOW - 10 }), item({ id: "w1", updatedAt: NOW - 500 }), item({ id: "w2", updatedAt: NOW - 100 })],
      ALL,
      NOW,
    );
    expect(next.map((i) => i.id)).toEqual(["w2", "w1", "d"]);
  });
});

describe("activity.snapshot", () => {
  it("parses, and a row with a bad open target is refused", () => {
    const good = { t: "activity.snapshot", items: [item({ id: "a" })] };
    expect(parseServerMessage(JSON.stringify(good)).ok).toBe(true);
    const bad = { t: "activity.snapshot", items: [{ ...item({ id: "a" }), open: { to: "nowhere" } }] };
    expect(parseServerMessage(JSON.stringify(bad)).ok).toBe(false);
  });
});
