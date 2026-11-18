import { describe, expect, it } from "vitest";
import {
  MAX_WORK_DETAIL,
  MAX_WORK_STEPS,
  THINKING_DETAIL,
  foldTurnWork,
  stepSummary,
  turnWorkDetail,
  workDuration,
  workHeader,
  workMessageOf,
  type WorkMessage,
} from "../src/turn-work";
import { ServerMessage } from "../src/index";

/** omp transcript messages as the session file holds them (`message` entries' `message`). */
const user = (timestamp: number, text = "hi", synthetic = false) => ({
  role: "user",
  timestamp,
  content: [{ type: "text", text }],
  ...(synthetic ? { synthetic: true } : {}),
});
const assistant = (
  timestamp: number,
  duration: number,
  parts: {
    thinking?: string;
    text?: string;
    calls?: { id: string; name: string; intent?: string; arguments: object }[];
  },
) => ({
  role: "assistant",
  timestamp,
  duration,
  content: [
    ...(parts.thinking === undefined
      ? []
      : [{ type: "thinking", thinking: parts.thinking, thinkingSignature: "sig" }]),
    ...(parts.text === undefined ? [] : [{ type: "text", text: parts.text }]),
    ...(parts.calls ?? []).map((call) => ({ type: "toolCall", ...call })),
  ],
});
const result = (timestamp: number, toolCallId: string, text: string, isError = false) => ({
  role: "toolResult",
  timestamp,
  toolCallId,
  toolName: "bash",
  isError,
  content: [{ type: "text", text }],
});

const fold = (raw: unknown[]): WorkMessage[] =>
  raw.map(workMessageOf).filter((m): m is WorkMessage => m !== null);

/** Isaac asks; Nova thinks, runs two tools in parallel (one fails), then an edit, then replies. Then a second turn. */
const TRANSCRIPT = fold([
  user(1_000, "what is live?"),
  assistant(1_010, 2_000, {
    thinking: "Isaac wants a fresh view of what is live. List the sessions first.",
    calls: [
      {
        id: "a",
        name: "bash",
        intent: "Checking running sessions",
        arguments: { command: "omp sessions --running\n| head", i: "Checking running sessions" },
      },
      {
        id: "b",
        name: "read",
        intent: "Reading thread memory",
        arguments: { path: "memory/threads/nova.md", i: "Reading thread memory" },
      },
    ],
  }),
  result(4_410, "a", "nova  working\nhelper idle"),
  result(3_200, "b", "ENOENT: no such file", true),
  { role: "custom", customType: "relay-guest", timestamp: 4_500, content: "x" },
  assistant(4_420, 1_000, {
    thinking: "Now note it.",
    calls: [
      {
        id: "c",
        name: "edit",
        arguments: {
          i: "Updating thread memory",
          input: "[memory/threads/nova.md#46B7]\n@@ ## Live\n+ relay-mobile-peek",
        },
      },
    ],
  }),
  result(5_720, "c", "[memory/threads/nova.md#F991]"),
  user(5_800, "reminder", true),
  assistant(5_730, 3_000, { text: "Two sessions are live." }),
  user(20_000, "thanks"),
  assistant(20_010, 500, { text: "Any time." }),
]);

describe("foldTurnWork", () => {
  it("groups a turn from its user message to the next and keeps synthetic users inside it", () => {
    const work = foldTurnWork(TRANSCRIPT, 5_730, false);
    expect(work?.at).toBe(1_000);
    expect(work?.endedAt).toBe(8_730);
    expect(work?.steps.map((step) => step.id)).toEqual(["a", "b", "c"]);
    expect(foldTurnWork(TRANSCRIPT, 20_010, false)?.steps).toEqual([]);
  });

  it("times each step from the end of the message that called it to its result, and the model time per turn", () => {
    const work = foldTurnWork(TRANSCRIPT, 1_000, false);
    expect(work?.modelMs).toBe(6_000);
    const [a, b, c] = work?.steps ?? [];
    expect(a).toMatchObject({
      tool: "bash",
      title: "Checking running sessions",
      summary: "omp sessions --running",
      startedAt: 3_010,
      endedAt: 4_410,
      status: "done",
      output: "nova working",
    });
    expect(b).toMatchObject({
      tool: "read",
      summary: "memory/threads/nova.md",
      startedAt: 3_010,
      endedAt: 3_200,
      status: "failed",
    });
    // No intent on the part: the `i` argument names it; an edit's file comes from its patch header.
    expect(c).toMatchObject({
      tool: "edit",
      title: "Updating thread memory",
      summary: "memory/threads/nova.md",
      status: "done",
    });
  });

  it("excerpts the first thinking once done, the newest while running", () => {
    expect(foldTurnWork(TRANSCRIPT, 1_000, false)?.thinking).toEqual({
      excerpt: "Isaac wants a fresh view of what is live. List the sessions first.",
      chars: 66 + 12,
    });
    const live = fold([
      user(1_000),
      assistant(1_010, 2_000, { thinking: "first" }),
      assistant(3_020, 1_000, {
        thinking: "second",
        calls: [{ id: "x", name: "bash", arguments: { command: "ls" } }],
      }),
    ]);
    expect(foldTurnWork(live, null, true)?.thinking?.excerpt).toBe("second");
  });

  it("marks the live session's newest turn running: an unanswered call runs, `now` says tools", () => {
    const live = fold([
      user(1_000),
      assistant(1_010, 1_000, {
        calls: [{ id: "a", name: "bash", arguments: { command: "sleep 5" } }],
      }),
    ]);
    const work = foldTurnWork(live, null, true);
    expect(work).toMatchObject({ running: true, now: { kind: "tools", since: 2_010 } });
    expect(work?.endedAt).toBeUndefined();
    expect(work?.steps[0]).toMatchObject({ status: "running" });
    expect(work?.steps[0]?.endedAt).toBeUndefined();
  });

  it("says the model is at work once every call answered, and only the newest turn runs", () => {
    const live = fold([
      user(1_000),
      assistant(1_010, 1_000, { calls: [{ id: "a", name: "bash", arguments: { command: "ls" } }] }),
      result(2_500, "a", "ok"),
    ]);
    expect(foldTurnWork(live, null, true)?.now).toEqual({ kind: "model", since: 2_500 });
    expect(foldTurnWork(TRANSCRIPT, 1_000, true)?.running).toBe(false);
  });

  it("an older turn's call without a result is done without an end, never running", () => {
    const old = fold([
      user(1_000),
      assistant(1_010, 100, { calls: [{ id: "a", name: "bash", arguments: { command: "ls" } }] }),
      user(9_000),
    ]);
    const step = foldTurnWork(old, 1_000, true)?.steps[0];
    expect(step?.status).toBe("done");
    expect(step?.endedAt).toBeUndefined();
  });

  it("keeps the newest MAX_WORK_STEPS steps of a long turn and counts the rest", () => {
    const calls = Array.from({ length: MAX_WORK_STEPS + 5 }, (_, i) => ({
      id: `c${String(i)}`,
      name: "bash",
      arguments: { command: `echo ${String(i)}` },
    }));
    const work = foldTurnWork(fold([user(1), assistant(2, 1, { calls })]), null, false);
    expect(work?.steps).toHaveLength(MAX_WORK_STEPS);
    expect(work?.earlier).toBe(5);
    expect(work?.steps[0]?.id).toBe("c5");
  });

  it("is null for an empty transcript, and survives the wire", () => {
    expect(foldTurnWork([], null, false)).toBeNull();
    const work = foldTurnWork(TRANSCRIPT, 1_000, false);
    expect(
      ServerMessage.parse({ t: "assistant.work.res", rid: "r1", ok: true, work }),
    ).toMatchObject({ work });
  });
});

describe("turnWorkDetail", () => {
  it("gives a step's input and output, and whether it failed", () => {
    expect(turnWorkDetail(TRANSCRIPT, 1_000, "a")).toEqual({
      input: "omp sessions --running\n| head",
      output: "nova  working\nhelper idle",
    });
    expect(turnWorkDetail(TRANSCRIPT, 1_000, "b")).toMatchObject({
      failed: true,
      output: "ENOENT: no such file",
    });
    expect(turnWorkDetail(TRANSCRIPT, 1_000, "c")?.input).toContain("+ relay-mobile-peek");
    expect(turnWorkDetail(TRANSCRIPT, 20_000, "a")).toBeNull();
  });

  it("gives the turn's whole thinking, cut at MAX_WORK_DETAIL", () => {
    expect(turnWorkDetail(TRANSCRIPT, 1_000, THINKING_DETAIL)?.text).toBe(
      "Isaac wants a fresh view of what is live. List the sessions first.\n\nNow note it.",
    );
    const long = fold([user(1), assistant(2, 1, { thinking: "x".repeat(MAX_WORK_DETAIL + 10) })]);
    expect(turnWorkDetail(long, null, THINKING_DETAIL)).toMatchObject({ truncated: true });
  });
});

describe("words", () => {
  it("summarizes a call's input by tool", () => {
    expect(stepSummary("grep", { pattern: "Live", path: "memory", i: "x" })).toBe("Live memory");
    expect(stepSummary("task", { tasks: [{}, {}], i: "x" })).toBe("2 tasks");
    expect(stepSummary("eval", { code: "\nprint(1)\nprint(2)", language: "py" })).toBe("print(1)");
    expect(stepSummary("wait", { i: "Waiting" })).toBe("");
  });

  it("heads the sheet Working with a clock while running, Thought with the model time once done", () => {
    const done = foldTurnWork(TRANSCRIPT, 1_000, false);
    if (done === null) throw new Error("no turn");
    expect(workHeader(done, 99_000)).toEqual({ title: "Thought 6s", meta: "3 tools" });
    expect(workHeader({ ...done, running: true }, 10_000)).toEqual({
      title: "Working",
      meta: "0:09 · 3 tools",
    });
    expect(workHeader({ ...done, steps: [] }, 0).meta).toBe("");
    expect(workDuration(9)).toBe("<0.1s");
    expect(workDuration(400)).toBe("0.4s");
    expect(workDuration(125_000)).toBe("2m 05s");
  });
});
