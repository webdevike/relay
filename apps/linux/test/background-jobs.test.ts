import { describe, expect, it } from "vitest";
import { BackgroundJobs, ENDED_JOB_LINGER_MS, jobLabel, jobStarted, jobsEnded } from "../src/agents/background-jobs";
import { COMPACTION_NOTICE, parseSessionRows } from "../src/agents/transcript";

const started = (jobId: string, type = "bash") => ({ async: { state: "running", jobId, type } });

describe("background job details", () => {
  it("reads a running async result, and skips subagent jobs and settled results", () => {
    expect(jobStarted(started("bg_1"))).toEqual({ id: "bg_1", type: "bash" });
    expect(jobStarted({ async: { state: "running", jobId: "bg_2" } })).toEqual({ id: "bg_2", type: "job" });
    expect(jobStarted(started("t_1", "task"))).toBeNull();
    expect(jobStarted({ async: { state: "completed", jobId: "bg_1" } })).toBeNull();
    expect(jobStarted({ async: { state: "running" } })).toBeNull();
    expect(jobStarted(undefined)).toBeNull();
  });

  it("reads deliveries, wait snapshots and proc kills as ended, but not jobs still running", () => {
    expect(jobsEnded({ jobs: [{ jobId: "bg_1", type: "bash" }] })).toEqual([{ id: "bg_1", state: "done" }]);
    expect(
      jobsEnded({
        jobs: [
          { id: "bg_2", status: "running" },
          { id: "bg_3", status: "failed" },
          { id: "bg_4", status: "completed" },
        ],
      }),
    ).toEqual([
      { id: "bg_3", state: "failed" },
      { id: "bg_4", state: "done" },
    ]);
    expect(jobsEnded({ proc: { jobs: [{ id: "bg_5", status: "cancelled" }] } })).toEqual([{ id: "bg_5", state: "cancelled" }]);
    expect(jobsEnded({ jobs: "nope", proc: null })).toEqual([]);
  });

  it("labels a call by its command, an eval cell's title, or its first code line", () => {
    expect(jobLabel({ command: "bun test --watch\n" })).toBe("bun test --watch");
    expect(jobLabel({ title: "scrape", code: "x = 1" })).toBe("scrape");
    expect(jobLabel({ code: "\nimport os\nprint(1)" })).toBe("import os");
    expect(jobLabel({ command: "x".repeat(300) })?.length).toBe(160);
    expect(jobLabel({ path: "a.ts" })).toBeUndefined();
  });
});

describe("BackgroundJobs", () => {
  it("starts a job labelled by its call, ends it, and drops it after the linger", () => {
    const jobs = new BackgroundJobs();
    jobs.noteToolCall("call-1", { command: "bun run dev" });
    expect(jobs.apply({ toolCallId: "call-1", details: started("bg_1") }, 100)).toBe(true);
    expect(jobs.list(150)).toEqual([{ id: "bg_1", type: "bash", label: "bun run dev", state: "running", startedAt: 100 }]);

    expect(jobs.apply({ details: { jobs: [{ jobId: "bg_1" }] } }, 200)).toBe(true);
    expect(jobs.list(201)[0]?.state).toBe("done");
    // Ending it again changes nothing.
    expect(jobs.apply({ details: { jobs: [{ id: "bg_1", status: "failed" }] } }, 210)).toBe(false);
    expect(jobs.list(200 + ENDED_JOB_LINGER_MS)).toEqual([]);
  });

  it("falls back to the job id without a known call, ignores plain results, and clears", () => {
    const jobs = new BackgroundJobs();
    expect(jobs.apply({ toolCallId: "unknown", details: started("bg_7", "eval") }, 1)).toBe(true);
    expect(jobs.list(2)[0]).toMatchObject({ id: "bg_7", type: "eval", label: "bg_7" });
    expect(jobs.apply({ toolCallId: "call-2", details: { exitCode: 0 } }, 3)).toBe(false);
    jobs.clear();
    expect(jobs.list(4)).toEqual([]);
  });
});

describe("compaction notice", () => {
  it("turns a compaction entry into a system row between the messages", () => {
    let seq = 0;
    const raw = [
      JSON.stringify({ type: "message", message: { role: "user", content: "hi", timestamp: 1 } }),
      JSON.stringify({ type: "compaction", timestamp: "2026-10-22T10:00:00.000Z", summary: "..." }),
      JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "hello" }], timestamp: 3 } }),
    ].join("\n");
    const rows = parseSessionRows(raw, null, () => String(++seq));
    expect(rows.map((row) => [row.role, row.text])).toEqual([
      ["user", "hi"],
      ["system", COMPACTION_NOTICE],
      ["assistant", "hello"],
    ]);
    expect(rows[1]?.at).toBe(Date.parse("2026-10-22T10:00:00.000Z"));
  });
});
