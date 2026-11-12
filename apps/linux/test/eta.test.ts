import { mkdtempSync, readFileSync, appendFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ActivityItem } from "@relay/protocol";
import { backtest, biasFor, estimatorPredictor, medianPredictor, type CalibrationRecord } from "../src/eta/accuracy";
import { CalibrationLog } from "../src/eta/calibration";
import { estimateRun, quantile, RunIndex } from "../src/eta/estimate";
import { RunHistory } from "../src/eta/history";
import { holdout } from "../src/eta/report";
import { checkboxSteps, classifyKind, TranscriptScan, type RunRecord } from "../src/eta/runs";
import { EtaService } from "../src/eta/service";

const FIXTURES = join(__dirname, "fixtures", "eta");
/** Every finished task and helper run from Isaac's Mac Mini history up to 2026-11-12 (paths cut to names, turn times thinned). */
const RUNS = JSON.parse(readFileSync(join(FIXTURES, "runs.json"), "utf8")) as RunRecord[];
const MIN = 60_000;

describe("TranscriptScan on a real transcript", () => {
  const scan = new TranscriptScan("todo-session.jsonl");
  for (const line of readFileSync(join(FIXTURES, "todo-session.jsonl"), "utf8").split("\n")) scan.line(line);
  const runs = scan.finish();

  it("keeps messages that land mid-turn (steers) in the run they land in", () => {
    // Eight user messages arrive while the agent works; only the first starts a run.
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ startedAt: Date.parse("2026-11-12T02:24:27.714Z"), durationMs: Date.parse("2026-11-12T02:52:39.305Z") - Date.parse("2026-11-12T02:24:27.714Z"), outcome: "done", model: "claude-opus-5-5" });
  });

  it("follows the todo list as plan steps, ending with every step done", () => {
    const steps = runs[0]!.stepsAt;
    expect(steps.length).toBeGreaterThan(2);
    for (let i = 1; i < steps.length; i += 1) expect(steps[i]![0]).toBeGreaterThanOrEqual(steps[i - 1]![0]);
    const [, done, total] = steps.at(-1)!;
    expect(done).toBe(total);
  });
});

describe("TranscriptScan rules", () => {
  const line = (entry: object): string => JSON.stringify(entry);
  const at = (minutes: number): string => new Date(Date.parse("2026-11-11T10:00:00Z") + minutes * MIN).toISOString();
  const user = (minutes: number): string => line({ type: "message", timestamp: at(minutes), message: { role: "user", content: [] } });
  const reply = (minutes: number, stopReason = "stop"): string => line({ type: "message", timestamp: at(minutes), message: { role: "assistant", content: [], stopReason } });

  it("a new request after a reply starts a new run in a session", () => {
    const scan = new TranscriptScan("/s/chat.jsonl");
    [user(0), reply(1, "toolUse"), reply(5), user(6), reply(8)].forEach((text) => scan.line(text));
    expect(scan.runs().map((run) => run.durationMs)).toEqual([5 * MIN]);
    expect(scan.open()).toMatchObject({ startedAt: Date.parse(at(6)), turns: 1, replied: true });
  });

  it("a helper's harness nudge after its reply is the same run; a follow-up much later is a new one", () => {
    const scan = new TranscriptScan("/s/parent/LaneBoss2.jsonl");
    scan.line(line({ type: "session", parentSession: "/s/parent.jsonl", cwd: "/Eva" }));
    [user(0), reply(4), user(5), reply(7), user(30), reply(31)].forEach((text) => scan.line(text));
    expect(scan.runs()).toHaveLength(1);
    expect(scan.runs()[0]).toMatchObject({ agent: "helper", title: "LaneBoss2", durationMs: 7 * MIN });
  });

  it("reads HANDOFF checkboxes, todo phases and 'step k of n'", () => {
    expect(checkboxSteps("- [x] host\n- [x] phone\n- [ ] desktop\n")).toEqual({ done: 2, total: 3 });
    expect(checkboxSteps("- [ ] only one")).toBeNull();
    const scan = new TranscriptScan("/s/a.jsonl");
    scan.line(line({ type: "session", cwd: "/Eva/work/x" }));
    scan.line(user(0));
    scan.line(line({ type: "message", timestamp: at(1), message: { role: "assistant", stopReason: "toolUse", content: [{ type: "text", text: "Step 3 of 5: wiring the host." }, { type: "toolCall", name: "write", arguments: { path: "HANDOFF.md" } }] } }));
    expect(scan.open()).toMatchObject({ steps: { done: 2, total: 5 }, planFile: "/Eva/work/x/HANDOFF.md" });
  });

  it("names the kind of work from the title", () => {
    expect(classifyKind("Ship phone fix: host 0.2.94 + OTA")).toBe("deploy");
    expect(classifyKind("Golf: fix Rapier aliasing crash on mode switch")).toBe("fix");
    expect(classifyKind("PaymentAuthFormTool")).toBe("other");
    expect(classifyKind("Relay: progress-fill badges with learned ETAs")).toBe("other");
  });
});

describe("estimateRun on real history", () => {
  const { train, test } = holdout(RUNS);
  const index = new RunIndex(train);
  const tasks = test.filter((run) => run.agent === "task");

  it("beats 'similar runs take their median' on held-out task runs from halfway on", () => {
    const ours = backtest(tasks, estimatorPredictor(index));
    const plain = backtest(tasks, medianPredictor(index));
    expect(ours.runs).toBeGreaterThan(50);
    const half = (accuracy: typeof ours): number => accuracy.checkpoints.find((row) => row.at === 0.5)!.medianError;
    expect(half(ours)).toBeLessThan(half(plain) * 0.7);
  });

  it("never says done while the run goes on, and holds the range around its total", () => {
    for (const run of tasks) {
      for (const share of [0.1, 0.5, 0.9, 1.5]) {
        const now = run.startedAt + run.durationMs * share;
        const eta = estimateRun(index, { key: run, from: run.startedAt, turns: 0, steps: null }, now);
        expect(eta).not.toBeNull();
        expect(eta!.totalMs).toBeGreaterThan(now - run.startedAt);
        expect(eta!.lowMs).toBeLessThanOrEqual(eta!.totalMs);
        expect(eta!.highMs).toBeGreaterThanOrEqual(eta!.totalMs);
      }
    }
  });

  it("calls a run longer than nearly every similar one overrunning", () => {
    const key = { agent: "task", kind: "other", model: null, thinking: null } as const;
    const lengths = [...index.bucketsFor(key)[0]!.durations];
    const p90 = quantile(lengths, 0.9);
    const from = Date.parse("2026-11-11T10:00:00Z");
    expect(estimateRun(index, { key, from, turns: 0, steps: null }, from + quantile(lengths, 0.5))?.overrunning).toBe(false);
    expect(estimateRun(index, { key, from, turns: 0, steps: null }, from + p90 * 1.1)?.overrunning).toBe(true);
  });

  it("a plan most of the way done pulls the total in and clears overrunning", () => {
    const key = { agent: "task", kind: "build", model: null, thinking: null } as const;
    const from = Date.parse("2026-11-11T10:00:00Z");
    const now = from + 60 * MIN;
    const blind = estimateRun(index, { key, from, turns: 0, steps: null }, now)!;
    const planned = estimateRun(index, { key, from, turns: 0, steps: { done: 9, total: 10 } }, now)!;
    expect(planned.totalMs).toBeLessThan(blind.totalMs);
    expect(planned.overrunning).toBe(false);
    expect(planned.steps).toEqual({ done: 9, total: 10 });
  });

  it("with no history, a plan alone still gives an estimate; with neither there is none", () => {
    const empty = new RunIndex([]);
    const key = { agent: "helper", kind: "other", model: null, thinking: null } as const;
    expect(estimateRun(empty, { key, from: 0, turns: 4, steps: null }, 5 * MIN)).toBeNull();
    expect(estimateRun(empty, { key, from: 0, turns: 4, steps: { done: 1, total: 4 } }, 5 * MIN)).toMatchObject({ totalMs: 20 * MIN, runs: 0 });
  });
});

describe("calibration", () => {
  const record = (actualMs: number, firstTotal: number, kind: "build" | "fix" = "build"): CalibrationRecord => ({
    id: "session:x",
    title: "x",
    agent: "task",
    kind,
    model: null,
    thinking: null,
    from: 0,
    actualMs,
    predictions: [{ elapsedMs: 0, totalMs: firstTotal, lowMs: firstTotal / 2, highMs: firstTotal * 2, confident: false }],
  });

  it("learns how far off runs like this one were, once there are enough of them", () => {
    const key = { agent: "task", kind: "build", model: null, thinking: null } as const;
    expect(biasFor([record(20 * MIN, 10 * MIN), record(20 * MIN, 10 * MIN)], key)).toBe(1);
    const longer = Array.from({ length: 6 }, () => record(15 * MIN, 10 * MIN));
    expect(biasFor([...longer, record(MIN, 10 * MIN, "fix")], key)).toBeCloseTo(1.5);
  });

  it("a learned bias stretches the estimate for runs like it", () => {
    const index = new RunIndex(RUNS);
    const key = { agent: "task", kind: "other", model: null, thinking: null } as const;
    const plain = estimateRun(index, { key, from: 0, turns: 0, steps: null }, 2 * MIN)!;
    const slow = estimateRun(index, { key, from: 0, turns: 0, steps: null }, 2 * MIN, { bias: 1.5 })!;
    expect(slow.totalMs).toBeGreaterThan(plain.totalMs);
  });
});

describe("EtaService", () => {
  let dir = "";
  afterEach(() => {
    if (dir !== "") rmSync(dir, { recursive: true, force: true });
  });

  const entry = (minutes: number, body: object): string => `${JSON.stringify({ timestamp: new Date(Date.parse("2026-11-11T10:00:00Z") + minutes * MIN).toISOString(), ...body })}\n`;
  const userAt = (m: number): string => entry(m, { type: "message", message: { role: "user", content: [] } });
  const replyAt = (m: number, stopReason: string, content: object[] = []): string => entry(m, { type: "message", message: { role: "assistant", content, stopReason } });

  it("estimates a working session from its transcript and plan, then logs how long it really took", async () => {
    dir = mkdtempSync(join(tmpdir(), "eta-"));
    const file = join(dir, "s.jsonl");
    const handoff = join(dir, "HANDOFF.md");
    writeFileSync(handoff, "- [x] host\n- [ ] phone\n- [ ] desktop\n- [ ] ship\n");
    writeFileSync(file, `${JSON.stringify({ type: "session", cwd: dir })}\n${userAt(0)}${replyAt(1, "toolUse", [{ type: "toolCall", name: "write", arguments: { path: "HANDOFF.md" } }])}`);
    let now = Date.parse("2026-11-11T10:10:00Z");
    const calibration = new CalibrationLog(join(dir, "cal.jsonl"));
    const service = new EtaService({
      history: new RunHistory(join(dir, "cache.json"), [], () => new Set()),
      calibration,
      sessionFile: (id) => (id === "s" ? file : null),
      isTask: () => true,
      now: () => now,
      log: () => {},
    });
    service.refresh();
    await service.loaded();
    service.useIndex(new RunIndex(RUNS));
    const item: ActivityItem = { id: "session:s", kind: "session", owner: "assistant:nova", title: "Build the thing", status: "working", intent: "", startedAt: now, updatedAt: now, open: { to: "chat", thread: "assistant:nova", session: "s" } };

    const [first] = await service.annotate([item]);
    expect(first?.eta).toMatchObject({ from: Date.parse("2026-11-11T10:00:00Z"), steps: { done: 1, total: 4 } });
    expect(first!.eta!.totalMs).toBeGreaterThan(10 * MIN);

    writeFileSync(handoff, "- [x] host\n- [x] phone\n- [x] desktop\n- [ ] ship\n");
    appendFileSync(file, replyAt(25, "toolUse"));
    now = Date.parse("2026-11-11T10:26:00Z");
    const [later] = await service.annotate([item]);
    expect(later?.eta?.steps).toEqual({ done: 3, total: 4 });

    // It replies and stops being reported working; once quiet, the run is logged.
    appendFileSync(file, replyAt(30, "stop"));
    now = Date.parse("2026-11-11T10:33:00Z");
    await service.annotate([]);
    expect(calibration.records()).toHaveLength(1);
    expect(calibration.records()[0]).toMatchObject({ id: "session:s", agent: "task", actualMs: 30 * MIN });
    expect(calibration.records()[0]!.predictions.length).toBeGreaterThanOrEqual(2);
    // The log survives a restart.
    expect(new CalibrationLog(join(dir, "cal.jsonl")).records()).toHaveLength(1);
  });

  it("leaves items it cannot read alone: waiting, unknown session, missing file", async () => {
    dir = mkdtempSync(join(tmpdir(), "eta-"));
    const service = new EtaService({
      history: new RunHistory(join(dir, "cache.json"), [], () => new Set()),
      calibration: new CalibrationLog(join(dir, "cal.jsonl")),
      sessionFile: (id) => (id === "gone" ? join(dir, "gone.jsonl") : null),
      isTask: () => false,
      now: () => 0,
      log: () => {},
    });
    const base = { kind: "session", owner: "other", title: "t", intent: "", startedAt: 0, updatedAt: 0 } as const;
    const items: ActivityItem[] = [
      { ...base, id: "session:w", status: "waiting", open: { to: "chat", thread: "session:w", session: "w" } },
      { ...base, id: "session:u", status: "working", open: { to: "chat", thread: "session:u", session: "u" } },
      { ...base, id: "session:gone", status: "working", open: { to: "chat", thread: "session:gone", session: "gone" } },
    ];
    expect(await service.annotate(items)).toEqual(items);
  });
});
