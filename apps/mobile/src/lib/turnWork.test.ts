import { describe, expect, it } from "vitest";
import type { AssistantMessage, TurnStep } from "@relay/protocol";
import { detailLines, stepView, workBrains } from "./turnWork";

const row = (
  id: string,
  role: AssistantMessage["role"],
  extra: Partial<AssistantMessage> = {},
): AssistantMessage => ({ id, role, text: id, at: 0, ...extra });
const none = () => false;

describe("workBrains", () => {
  const rows = [
    row("u1", "user"),
    row("a1", "assistant"),
    row("a2", "assistant"),
    row("job", "status"),
    row("a3", "assistant"),
    // A guest's joined line sits inside a turn; it does not start one.
    row("g", "status", { guest: { kind: "join", agent: { id: "astra", title: "Astra" } } }),
    row("u2", "user"),
    row("a4", "assistant"),
  ];

  it("puts a brain on the last reply of every turn, the newest live while the thread works", () => {
    expect([...workBrains(rows, true, true, none)]).toEqual([
      ["a2", "settled"],
      ["a3", "settled"],
      ["a4", "live"],
    ]);
    expect(workBrains(rows, false, true, none).get("a4")).toBe("settled");
  });

  it("shows none with Show work off (or a host without it), so no row can ask for work", () => {
    expect(workBrains(rows, true, false, none).size).toBe(0);
  });

  it("a turn still without a reply has no brain on an older one, and skipped rows do not split turns", () => {
    const running = [row("u1", "user"), row("a1", "assistant"), row("u2", "user")];
    expect([...workBrains(running, true, true, none)]).toEqual([["a1", "settled"]]);
    const echo = [
      row("u1", "user"),
      row("a1", "assistant"),
      row("pending:x", "user"),
      row("a2", "assistant"),
    ];
    expect([...workBrains(echo, false, true, (r) => r.id.startsWith("pending:"))]).toEqual([
      ["a2", "settled"],
    ]);
  });
});

describe("stepView", () => {
  const step: TurnStep = {
    id: "s",
    tool: "mcp__relay__browser_read",
    title: "",
    summary: "page",
    startedAt: 1_000,
    status: "done",
    endedAt: 2_400,
  };

  it("names a step by its intent, else its tool, and times it", () => {
    expect(stepView(step, 0)).toEqual({
      title: "browser_read",
      tool: "browser_read",
      summary: "page",
      time: "1.4s",
      error: null,
    });
    expect(stepView({ ...step, title: "Reading the page" }, 0).title).toBe("Reading the page");
  });

  it("runs a clock while running, and shows a failed step's error", () => {
    expect(stepView({ ...step, status: "running", endedAt: undefined }, 10_000).time).toBe("0:09");
    expect(stepView({ ...step, status: "failed", output: "ENOENT" }, 0).error).toBe("ENOENT");
    expect(stepView({ ...step, endedAt: undefined }, 0).time).toBe("");
  });
});

describe("detailLines", () => {
  it("tones a patch's added and removed lines, never a header or another tool's output", () => {
    expect(detailLines("edit", "--- a\n+++ b\n- old\n+ new\n ctx").map((l) => l.tone)).toEqual([
      null,
      null,
      "del",
      "add",
      null,
    ]);
    expect(detailLines("bash", "- not a patch").map((l) => l.tone)).toEqual([null]);
  });
});
