import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRun, AssistantMessage } from "@relay/protocol";
import {
  SpecialistRunBook,
  settleAssistantMessages,
  specialistRunsOfJournal,
} from "../src/assistant/specialist-runs";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

let n = 0;
const line = (
  type: string,
  at: string,
  data: unknown,
  extra: { job?: string; run?: string; caller?: string } = {},
): string => {
  const [component = ""] = type.split("/");
  return JSON.stringify({
    id: `e${++n}`,
    type,
    component,
    job: extra.job ?? "render",
    run: extra.run ?? "20261117T150701-aaaa",
    at,
    ...(extra.caller === undefined ? {} : { caller: extra.caller }),
    data,
  });
};

/** The journal lines of a prop-render run as the service writes them (run.requested, job.started, output, job.succeeded|failed). */
const propRender = (
  requestId: string,
  at: string,
  end?: { ok: boolean; at: string; seconds: number },
): string[] => [
  line(
    "atomic-agents/run.requested",
    at,
    { requestId, agent: "prop-render", job: "render", input: { subject: "wind turbine" } },
    { job: "ask", run: `ask-${requestId}`, caller: "agent:nova" },
  ),
  line("prop-render/job.started", at, { _tag: "job.started", requestId, input: { subject: "x" }, model: "m" }, { run: requestId }),
  ...(end === undefined
    ? []
    : [
        line("prop-render/render.completed", end.at, { subject: "x" }, { run: requestId }),
        line(
          `prop-render/job.${end.ok ? "succeeded" : "failed"}`,
          end.at,
          end.ok
            ? { _tag: "job.succeeded", seconds: end.seconds }
            : { _tag: "job.failed", seconds: end.seconds, message: "render crashed" },
          { run: requestId },
        ),
      ]),
];

describe("specialistRunsOfJournal", () => {
  it("folds each request to running, done or failed, with its start time and seconds", () => {
    const lines = [
      ...propRender("r-done", "2026-11-17T15:07:01.399Z", { ok: true, at: "2026-11-17T15:08:39.420Z", seconds: 98 }),
      ...propRender("r-failed", "2026-11-17T15:07:06.000Z", { ok: false, at: "2026-11-17T15:07:30.000Z", seconds: 24 }),
      ...propRender("r-running", "2026-11-17T15:07:12.000Z"),
      line("atomic-agents/run.requested", "2026-11-17T15:07:20.000Z", { requestId: "r-rejected", agent: "diagram", job: "draw", input: {} }, { job: "ask", run: "ask-x" }),
      line("atomic-agents/run.rejected", "2026-11-17T15:07:21.000Z", { requestId: "r-rejected", agent: "diagram", error: "bad request" }, { job: "ask", run: "ask-x" }),
      // Another component's own correlated events are no specialist run.
      line("widget/job.started", "2026-11-17T15:07:22.000Z", { _tag: "job.started", input: { requestId: "bake-1" }, model: "m" }, { job: "pick", run: "w1" }),
      line("widget/job.succeeded", "2026-11-17T15:07:23.000Z", { _tag: "job.succeeded", seconds: 1 }, { job: "pick", run: "w1" }),
    ];
    expect(specialistRunsOfJournal(lines)).toEqual([
      { run: "r-done", agent: "prop-render", status: "done", startedAt: Date.parse("2026-11-17T15:07:01.399Z"), seconds: 98, model: "m" },
      { run: "r-failed", agent: "prop-render", status: "failed", startedAt: Date.parse("2026-11-17T15:07:06.000Z"), seconds: 24, error: "render crashed", model: "m" },
      { run: "r-running", agent: "prop-render", status: "running", startedAt: Date.parse("2026-11-17T15:07:12.000Z"), model: "m" },
      { run: "r-rejected", agent: "diagram", status: "failed", startedAt: Date.parse("2026-11-17T15:07:20.000Z"), error: "bad request" },
    ]);
  });

  it("an ask pair's request is done once its reply carrying the request id arrives", () => {
    const lines = [
      line("diagram/diagram.requested", "2026-11-17T15:00:00.000Z", { requestId: "p-1", description: "d" }, { job: "ask", run: "ask-p1" }),
      line("diagram/job.started", "2026-11-17T15:00:00.100Z", { _tag: "job.started", requestId: "p-1", input: { requestId: "p-1" }, model: "m" }, { job: "draw", run: "d1" }),
      line("diagram/diagram.rendered", "2026-11-17T15:00:09.000Z", { requestId: "p-1", image: "x" }, { job: "draw", run: "d1" }),
    ];
    expect(specialistRunsOfJournal(lines)).toEqual([
      { run: "p-1", agent: "diagram", status: "done", startedAt: Date.parse("2026-11-17T15:00:00.000Z"), model: "m" },
    ]);
  });
});

describe("settleAssistantMessages", () => {
  const ran: AgentRun = { run: "r-1", agent: "prop-render", status: "running", startedAt: 1_000 };
  const reply: AssistantMessage = { id: "a1", role: "assistant", text: "Rendering", at: 5, agents: [ran] };
  const status: AssistantMessage = { id: "s1", role: "status", text: "Prop render is on it · 54:00", at: 6, agents: [ran] };
  const none: AssistantMessage = { id: "u1", role: "user", text: "hi", at: 1 };

  it("a run the service finished reads done on its reply, and the status row's caption says so; other rows stay the same objects", () => {
    const service: AgentRun[] = [{ run: "r-1", agent: "prop-render", status: "done", startedAt: 1_000, seconds: 98 }];
    const out = settleAssistantMessages([none, reply, status], service, 60 * 60_000);
    expect(out[0]).toBe(none);
    expect(out[1]?.agents).toEqual([{ ...ran, status: "done", seconds: 98 }]);
    expect(out[2]?.agents?.[0]?.status).toBe("done");
    expect(out[2]?.text).toBe("Answered with Prop render · 1m 38s");
  });

  it("a run the service has no record of fails, and a run it still runs stays running", () => {
    const stillOut: AgentRun[] = [{ run: "r-1", agent: "prop-render", status: "running", startedAt: 1_000 }];
    expect(settleAssistantMessages([reply], stillOut, 5_000)[0]).toBe(reply);
    expect(settleAssistantMessages([reply], [], 5_000)[0]?.agents?.[0]).toMatchObject({ status: "failed" });
  });

  it("without a service (no journal here) the transcript stands", () => {
    expect(settleAssistantMessages([reply], null, 5_000)[0]).toBe(reply);
  });
});

describe("SpecialistRunBook", () => {
  const book = (): { home: string; journal: string } => {
    const home = mkdtempSync(join(tmpdir(), "relay-journal-"));
    dirs.push(home);
    return { home, journal: join(home, "events.ndjson") };
  };

  // The fixtures are dated: the book judges them against a clock set a minute after the first ask.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse("2026-11-17T15:08:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("is null while the service has no journal, and reads a run that finished after the last read", async () => {
    const { home, journal } = book();
    const runs = new SpecialistRunBook(home);
    expect(await runs.current()).toBeNull();
    writeFileSync(journal, `${propRender("r-1", "2026-11-17T15:07:01.000Z").join("\n")}\n`);
    expect((await runs.current())?.map((r) => r.status)).toEqual(["running"]);
    appendFileSync(
      journal,
      `${line("prop-render/job.succeeded", "2026-11-17T15:08:39.000Z", { _tag: "job.succeeded", seconds: 98 }, { run: "r-1" })}\n`,
    );
    expect((await runs.current())?.map((r) => r.status)).toEqual(["done"]);
  });

  it("tells listeners once when a run's state moved, not when nothing did", async () => {
    const { home, journal } = book();
    writeFileSync(journal, `${propRender("r-1", "2026-11-17T15:07:01.000Z").join("\n")}\n`);
    const runs = new SpecialistRunBook(home);
    let heard = 0;
    const stop = runs.onChange(() => {
      heard += 1;
    });
    try {
      await runs.notify();
      await runs.notify();
      expect(heard).toBe(1);
      appendFileSync(
        journal,
        `${line("prop-render/job.succeeded", "2026-11-17T15:08:39.000Z", { _tag: "job.succeeded", seconds: 98 }, { run: "r-1" })}\n`,
      );
      await runs.notify();
      expect(heard).toBe(2);
      appendFileSync(journal, `${line("widget/widget.ready", "2026-11-17T15:09:00.000Z", { requestId: "bake" }, { job: "pick", run: "w" })}\n`);
      await runs.notify();
      expect(heard).toBe(2);
    } finally {
      stop();
    }
  });

  it("a run the service lost (no end in the journal) reads failed past its time limit, and the listeners hear it with no journal write", async () => {
    const { home, journal } = book();
    const asked = Date.parse("2026-11-17T15:07:01.000Z");
    writeFileSync(journal, `${propRender("r-1", new Date(asked).toISOString()).join("\n")}\n`);
    const runs = new SpecialistRunBook(home);
    let heard = 0;
    const stop = runs.onChange(() => {
      heard += 1;
    });
    try {
      vi.setSystemTime(asked + 5 * 60_000);
      await runs.notify();
      expect((await runs.current())?.map((r) => r.status)).toEqual(["running"]);
      expect(heard).toBe(1);
      vi.setSystemTime(asked + 21 * 60_000);
      await runs.notify();
      expect((await runs.current())?.[0]).toMatchObject({ run: "r-1", status: "failed", error: expect.any(String) });
      expect(heard).toBe(2);
    } finally {
      stop();
    }
  });
});

describe("the model a run ran on", () => {
  const started = (requestId: string, extra: Record<string, unknown>, model: string): string =>
    line("prop-render/job.started", "2026-11-17T15:07:02Z", { _tag: "job.started", requestId, input: {}, model, ...extra }, { run: requestId });

  it("is the one the run started on, its thinking level, and the backup after a fallback", () => {
    const ask = propRender("req-1", "2026-11-17T15:07:01Z").slice(0, 1);
    const plain = specialistRunsOfJournal([...ask, started("req-1", { thinking: "high" }, "anthropic/claude-haiku-5-5")]);
    expect(plain[0]).toMatchObject({ model: "anthropic/claude-haiku-5-5", thinking: "high" });
    expect(plain[0]?.fellBack).toBeUndefined();
    const fell = specialistRunsOfJournal([
      ...ask,
      started("req-1", {}, "anthropic/claude-haiku-5-5"),
      started("req-1", { fellBackFrom: "anthropic/claude-haiku-5-5" }, "openrouter/moonshotai/kimi-k3.1-pro"),
    ]);
    expect(fell[0]).toMatchObject({ model: "openrouter/moonshotai/kimi-k3.1-pro", fellBack: true });
  });

  it("reaches a finished row from the service, and a trial's own run stays blind until the pick", () => {
    const done: AgentRun = { run: "r-1", agent: "prop-render", status: "done", startedAt: 1_000, seconds: 9 };
    const row: AssistantMessage = { id: "a1", role: "assistant", text: "ok", at: 5, agents: [done] };
    const service: AgentRun[] = [{ ...done, model: "anthropic/claude-haiku-5-5", thinking: "low" }];
    expect(settleAssistantMessages([row], service, 2_000)[0]?.agents?.[0]).toMatchObject({
      model: "anthropic/claude-haiku-5-5",
      thinking: "low",
    });
    const badge = (picked: boolean) => ({
      byRequest: new Map([["r-1", { trialId: "t1", agent: "prop-render", letter: "A" as const, picked, others: [{ letter: "B" as const, status: "done" as const, model: "openai/gpt-6.1-sol" }] }]]),
      switched: new Map(),
    });
    const blind = settleAssistantMessages([row], service, 2_000, badge(false))[0]?.agents ?? [];
    expect(blind.map((r) => [r.trial, r.model])).toEqual([["A", undefined], ["B", undefined]]);
    const shown = settleAssistantMessages([row], service, 2_000, badge(true))[0]?.agents ?? [];
    expect(shown.map((r) => r.model)).toEqual(["anthropic/claude-haiku-5-5", "openai/gpt-6.1-sol"]);
  });
});
