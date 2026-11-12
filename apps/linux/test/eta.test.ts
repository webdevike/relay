import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ActivityItem } from "@relay/protocol";
import { backtest, biasFor, ConfidenceTable, estimatorPredictor, holdout, medianPredictor, type CalibrationRecord } from "../src/eta/accuracy";
import { CalibrationLog } from "../src/eta/calibration";
import { estimateRun, MIN_BUCKET_RUNS, quantile, RunIndex } from "../src/eta/estimate";
import { NO_SOURCES, RunHistory, type AgentSession } from "../src/eta/history";
import { checkboxSteps, classifyKind, TranscriptScan, type RunRecord } from "../src/eta/runs";
import { EtaService } from "../src/eta/service";

const FIXTURES = join(__dirname, "fixtures", "eta");
/** Every finished task and helper run from Isaac's Mac Mini history up to 2026-11-12, helpers with who ran them and agent sessions merged (paths cut to names, turn times thinned). */
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
    expect(classifyKind("CriticBoss3")).toBe("review");
  });

  it("a helper that yields has finished, one that yields an error failed; a task call names who runs each helper", () => {
    const helper = (error?: string): TranscriptScan => {
      const scan = new TranscriptScan("/s/parent/BossR3.jsonl");
      scan.line(line({ type: "session", parentSession: "/s/parent.jsonl" }));
      scan.line(user(0));
      scan.line(line({ type: "message", timestamp: at(12), message: { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", name: "yield", arguments: error === undefined ? { data: { ok: 1 } } : { error } }] } }));
      scan.finish();
      return scan;
    };
    expect(helper().runs()[0]).toMatchObject({ agent: "helper", outcome: "done", durationMs: 12 * MIN });
    expect(helper("could not build").runs()[0]?.outcome).toBe("failed");
    expect(helper()).toMatchObject({ parent: "/s/parent.jsonl", name: "BossR3" });
    const lane = new TranscriptScan("/s/parent/Lane/Lane.Wiring.jsonl");
    lane.line(line({ type: "session", parentSession: "/s/parent/Lane.jsonl" }));
    expect(lane.name).toBe("Wiring");

    const parent = new TranscriptScan("/s/parent.jsonl");
    parent.line(user(0));
    const tasks = [{ name: "BossR3", agent: "helper-code" }, { name: "Scout1" }];
    parent.line(line({ type: "message", timestamp: at(1), message: { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", name: "task", arguments: { tasks } }] } }));
    expect(parent.spawns()).toEqual({ BossR3: "helper-code", Scout1: "task" });
  });
});

describe("RunHistory", () => {
  let dir = "";
  afterEach(() => {
    if (dir !== "") rmSync(dir, { recursive: true, force: true });
  });
  const t0 = Date.parse("2026-11-11T10:00:00Z");
  const jsonl = (...entries: object[]): string => entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
  const msg = (minutes: number, role: string, extra: object = {}): object => ({ type: "message", timestamp: new Date(t0 + minutes * MIN).toISOString(), message: { role, content: [], ...extra } });
  const spawn = (minutes: number, tasks: object[]): object => msg(minutes, "assistant", { stopReason: "toolUse", content: [{ type: "toolCall", name: "task", arguments: { tasks } }] });
  const yielded = (minutes: number): object => msg(minutes, "assistant", { stopReason: "toolUse", content: [{ type: "toolCall", name: "yield", arguments: { data: {} } }] });

  it("mines helpers beside their parent (and a lane's own helpers) with who ran them, and an agent session's rotations as one run", async () => {
    dir = mkdtempSync(join(tmpdir(), "eta-history-"));
    const root = join(dir, "sessions");
    const cwd = join(root, "-Eva");
    const parent = join(cwd, "p.jsonl");
    mkdirSync(join(cwd, "p", "Lane"), { recursive: true });
    writeFileSync(parent, jsonl({ type: "session", cwd: "/Eva" }, msg(0, "user"), spawn(1, [{ name: "BossR3", agent: "helper-code" }, { name: "Lane", agent: "helper-deep" }]), msg(60, "assistant", { stopReason: "stop" })));
    writeFileSync(join(cwd, "p", "BossR3.jsonl"), jsonl({ type: "session", parentSession: parent }, msg(1, "user"), yielded(20)));
    const lane = join(cwd, "p", "Lane.jsonl");
    writeFileSync(lane, jsonl({ type: "session", parentSession: parent }, msg(1, "user"), spawn(2, [{ name: "Wiring", agent: "scout" }]), yielded(40)));
    writeFileSync(join(cwd, "p", "Lane", "Lane.Wiring.jsonl"), jsonl({ type: "session", parentSession: lane }, msg(2, "user"), yielded(9)));
    // An agent session rotated once: two transcripts, one task of 90 minutes that hit its limit.
    const first = join(cwd, "a1.jsonl");
    const second = join(cwd, "a2.jsonl");
    writeFileSync(first, jsonl({ type: "session", cwd: "/Eva" }, msg(100, "user"), msg(101, "assistant", { stopReason: "toolUse" }), msg(140, "assistant", { stopReason: "stop" })));
    writeFileSync(second, jsonl({ type: "session", cwd: "/Eva" }, msg(141, "user"), msg(150, "assistant", { stopReason: "toolUse" }), msg(189, "assistant", { stopReason: "toolUse" })));
    const session: AgentSession = { title: "Boxhead overnight", role: "helper-deep", model: null, thinking: "high", startedAt: t0 + 100 * MIN, endedAt: t0 + 190 * MIN, state: "timeout", limitMs: 90 * MIN, handoff: null, files: [first, second] };
    const history = new RunHistory(join(dir, "cache.json"), [root], () => ({ tasks: new Set(), agentSessions: [session] }));
    await history.refresh(Date.now() + 60 * MIN);
    const runs = history.runs();

    const helpers = Object.fromEntries(runs.filter((run) => run.agent === "helper").map((run) => [run.title, run]));
    expect(helpers["BossR3"]).toMatchObject({ role: "helper-code", outcome: "done", durationMs: 19 * MIN });
    expect(helpers["Lane"]).toMatchObject({ role: "helper-deep", outcome: "done" });
    expect(helpers["Lane.Wiring"]).toMatchObject({ role: "scout", outcome: "done", durationMs: 7 * MIN });
    const tasks = runs.filter((run) => run.agent === "task");
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ title: "Boxhead overnight", role: "helper-deep", outcome: "done", startedAt: t0 + 100 * MIN, durationMs: 90 * MIN, limitMs: 90 * MIN });
    expect(tasks[0]!.turnAt).toEqual([60, 40 * 60, 50 * 60, 89 * 60]);
    // The rotations' own runs are not counted again as chats.
    expect(runs.filter((run) => run.file === first || run.file === second)).toHaveLength(1);
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
    const key = { agent: "task", kind: "other", role: null, model: null, thinking: null } as const;
    const lengths = [...index.bucketsFor(key)[0]!.durations];
    const p90 = quantile(lengths, 0.9);
    const from = Date.parse("2026-11-11T10:00:00Z");
    expect(estimateRun(index, { key, from, turns: 0, steps: null }, from + quantile(lengths, 0.5))?.overrunning).toBe(false);
    expect(estimateRun(index, { key, from, turns: 0, steps: null }, from + p90 * 1.1)?.overrunning).toBe(true);
  });

  it("a plan most of the way done pulls the total in and clears overrunning", () => {
    const key = { agent: "task", kind: "build", role: null, model: null, thinking: null } as const;
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
    const key = { agent: "helper", kind: "other", role: null, model: null, thinking: null } as const;
    expect(estimateRun(empty, { key, from: 0, turns: 4, steps: null }, 5 * MIN)).toBeNull();
    expect(estimateRun(empty, { key, from: 0, turns: 4, steps: { done: 1, total: 4 } }, 5 * MIN)).toMatchObject({ totalMs: 20 * MIN, runs: 0 });
  });

  it("past what history can say, the total climbs with elapsed time instead of parking near full", () => {
    const key = { agent: "helper", kind: "other", role: "helper-code", model: null, thinking: null } as const;
    const longest = index.bucketsFor(key)[0]!.durations.at(-1)!;
    let last = 0;
    for (const times of [1, 1.5, 2, 3]) {
      const eta = estimateRun(index, { key, from: 0, turns: 0, steps: null }, longest * times)!;
      expect(eta.overrunning).toBe(true);
      expect(eta.totalMs).toBeGreaterThan(last);
      // The fill (elapsed over total) holds steady rather than creeping up to 95%.
      expect((longest * times) / eta.totalMs).toBeLessThan(0.85);
      last = eta.totalMs;
    }
  });

  it("never runs past an agent session's --max-time", () => {
    const key = { agent: "task", kind: "other", role: "helper-deep", model: null, thinking: "high" } as const;
    const eta = estimateRun(index, { key, from: 0, turns: 40, steps: { done: 1, total: 5 }, limitMs: 8 * 60 * MIN }, 7.5 * 60 * MIN)!;
    expect(eta.totalMs).toBeLessThanOrEqual(8 * 60 * MIN);
    expect(eta.highMs).toBeLessThanOrEqual(8 * 60 * MIN);
    expect(eta.totalMs).toBeGreaterThan(7.5 * 60 * MIN);
  });

  it("is solid only where replays before the held-out runs were close, and those held-out estimates are", () => {
    const key = { agent: "chat", kind: "other", role: null, model: null, thinking: null } as const;
    expect(estimateRun(index, { key, from: 0, turns: 0, steps: null }, 3 * MIN)?.confidence).toBe("rough");
    const table = ConfidenceTable.build(train);
    const errors: number[] = [];
    let shown = 0;
    for (const run of test.filter((candidate) => candidate.outcome === "done" && candidate.durationMs >= 5000)) {
      for (const share of [0.1, 0.25, 0.5, 0.75, 0.9]) {
        const eta = estimateRun(index, { key: run, from: run.startedAt, turns: 0, steps: null }, run.startedAt + run.durationMs * share, { trust: table.trust });
        shown += 1;
        if (eta?.confidence === "confident") errors.push(Math.abs(eta.totalMs - run.durationMs) / run.durationMs);
      }
    }
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.length).toBeLessThan(shown / 2);
    // About the bar the table was built to: the confident estimates on runs it never saw.
    expect(quantile(errors.sort((a, b) => a - b), 0.5)).toBeLessThan(0.3);
  });
});

describe("calibration", () => {
  const record = (actualMs: number, firstTotal: number, kind: "build" | "fix" = "build"): CalibrationRecord => ({
    id: "session:x",
    title: "x",
    agent: "task",
    role: null,
    kind,
    model: null,
    thinking: null,
    from: 0,
    actualMs,
    predictions: [{ elapsedMs: 0, totalMs: firstTotal, lowMs: firstTotal / 2, highMs: firstTotal * 2, confident: false }],
  });

  it("learns how far off runs like this one were, once there are enough of them", () => {
    const key = { agent: "task", kind: "build", role: null, model: null, thinking: null } as const;
    expect(biasFor([record(20 * MIN, 10 * MIN), record(20 * MIN, 10 * MIN)], key)).toBe(1);
    const longer = Array.from({ length: 6 }, () => record(15 * MIN, 10 * MIN));
    expect(biasFor([...longer, record(MIN, 10 * MIN, "fix")], key)).toBeCloseTo(1.5);
  });

  it("a learned bias stretches the estimate for runs like it", () => {
    const index = new RunIndex(RUNS);
    const key = { agent: "task", kind: "other", role: null, model: null, thinking: null } as const;
    const plain = estimateRun(index, { key, from: 0, turns: 0, steps: null }, 5_000)!;
    const slow = estimateRun(index, { key, from: 0, turns: 0, steps: null }, 5_000, { bias: 1.5 })!;
    expect(slow.totalMs).toBeGreaterThan(plain.totalMs);
    expect(slow.typicalMs).toBeGreaterThan(plain.typicalMs);
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
      history: new RunHistory(join(dir, "cache.json"), [], () => NO_SOURCES),
      calibration,
      sessionFile: (id) => (id === "s" ? file : null),
      isTask: () => true,
      sources: () => NO_SOURCES,
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

  it("an agent session is estimated from its own start across rotations, by its HANDOFF, within its --max-time, and logged when its record ends", async () => {
    dir = mkdtempSync(join(tmpdir(), "eta-"));
    const old = join(dir, "a1.jsonl");
    const file = join(dir, "a2.jsonl");
    const handoff = join(dir, "HANDOFF.md");
    writeFileSync(handoff, "- [x] a\n- [ ] b\n- [ ] c\n- [ ] d\n- [ ] e\n");
    writeFileSync(old, `${userAt(0)}${replyAt(100, "stop")}`);
    // The current rotation started 2 h into a session with an 8 h limit.
    writeFileSync(file, `${JSON.stringify({ type: "session", cwd: dir })}\n${userAt(120)}${replyAt(121, "toolUse")}`);
    const running: AgentSession = { title: "Boxhead overnight", role: "helper-deep", model: null, thinking: "high", startedAt: Date.parse("2026-11-11T10:00:00Z"), endedAt: null, state: "running", limitMs: 8 * 60 * MIN, handoff, files: [old, file] };
    let sessions: readonly AgentSession[] = [running];
    let now = Date.parse("2026-11-11T17:30:00Z");
    const calibration = new CalibrationLog(join(dir, "cal.jsonl"));
    const service = new EtaService({
      history: new RunHistory(join(dir, "cache.json"), [], () => NO_SOURCES),
      calibration,
      sessionFile: () => file,
      isTask: () => true,
      sources: () => ({ tasks: new Set(), agentSessions: sessions }),
      now: () => now,
      log: () => {},
    });
    service.refresh();
    await service.loaded();
    service.useIndex(new RunIndex(RUNS));
    const item: ActivityItem = { id: "session:a", kind: "session", owner: "assistant:nova", title: "Boxhead overnight", status: "working", intent: "", startedAt: now, updatedAt: now, open: { to: "chat", thread: "assistant:nova", session: "a" } };
    const [annotated] = await service.annotate([item]);
    expect(annotated?.eta).toMatchObject({ from: running.startedAt, steps: { done: 1, total: 5 } });
    expect(annotated!.eta!.totalMs).toBeLessThanOrEqual(8 * 60 * MIN);
    expect(annotated!.eta!.totalMs).toBeGreaterThan(7.5 * 60 * MIN);

    sessions = [{ ...running, endedAt: Date.parse("2026-11-11T18:00:00Z"), state: "timeout" }];
    now = Date.parse("2026-11-11T18:02:00Z");
    await service.annotate([]);
    expect(calibration.records()).toHaveLength(1);
    expect(calibration.records()[0]).toMatchObject({ agent: "task", role: "helper-deep", title: "Boxhead overnight", actualMs: 8 * 60 * MIN });
  });

  it("a helper is estimated as the agent its parent's task call named, read from the parent while history lacks it", async () => {
    dir = mkdtempSync(join(tmpdir(), "eta-"));
    const parent = join(dir, "p.jsonl");
    const file = join(dir, "p", "BossR3.jsonl");
    mkdirSync(join(dir, "p"));
    writeFileSync(parent, `${userAt(0)}${replyAt(1, "toolUse", [{ type: "toolCall", name: "task", arguments: { tasks: [{ name: "BossR3", agent: "helper-code" }] } }])}`);
    writeFileSync(file, `${JSON.stringify({ type: "session", parentSession: parent })}\n${userAt(1)}${replyAt(2, "toolUse")}`);
    let now = Date.parse("2026-11-11T10:10:00Z");
    const calibration = new CalibrationLog(join(dir, "cal.jsonl"));
    const service = new EtaService({
      history: new RunHistory(join(dir, "cache.json"), [], () => NO_SOURCES),
      calibration,
      sessionFile: () => null,
      isTask: () => false,
      sources: () => NO_SOURCES,
      now: () => now,
      log: () => {},
    });
    service.refresh();
    await service.loaded();
    service.useIndex(new RunIndex(RUNS));
    const item: ActivityItem = { id: `helper:${file}`, kind: "helper", owner: "session:p", title: "BossR3", status: "working", intent: "", startedAt: now, updatedAt: now, open: { to: "subagent", file, name: "BossR3" } };
    const [annotated] = await service.annotate([item]);
    const buckets = new RunIndex(RUNS).bucketsFor({ agent: "helper", role: "helper-code", kind: "other", model: null, thinking: null });
    const prior = buckets.find((bucket) => bucket.durations.length >= MIN_BUCKET_RUNS)!;
    expect(prior.level).toContain("role=helper-code");
    expect(annotated?.eta?.runs).toBe(prior.durations.length);

    appendFileSync(file, replyAt(30, "toolUse", [{ type: "toolCall", name: "yield", arguments: { data: {} } }]));
    now = Date.parse("2026-11-11T10:33:00Z");
    await service.annotate([]);
    expect(calibration.records()[0]).toMatchObject({ agent: "helper", role: "helper-code", actualMs: 29 * MIN });
  });

  it("leaves items it cannot read alone: waiting, unknown session, missing file", async () => {
    dir = mkdtempSync(join(tmpdir(), "eta-"));
    const service = new EtaService({
      history: new RunHistory(join(dir, "cache.json"), [], () => NO_SOURCES),
      calibration: new CalibrationLog(join(dir, "cal.jsonl")),
      sessionFile: (id) => (id === "gone" ? join(dir, "gone.jsonl") : null),
      isTask: () => false,
      sources: () => NO_SOURCES,
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
