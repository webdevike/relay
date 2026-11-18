import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  TRIAL_SWITCH_BADGE_MS,
  type AgentRun,
  type AssistantMessage,
  type ServerMessage,
} from "@relay/protocol";
import { SpecialistRunBook, settleAssistantMessages } from "../src/assistant/specialist-runs";
import { callerThread, trialsOfJournal } from "../src/trials/book";
import { TrialService } from "../src/trials/service";

const dirs: string[] = [];
const services: TrialService[] = [];
afterEach(() => {
  for (const service of services.splice(0)) service.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

let n = 0;
const line = (
  type: string,
  at: string,
  data: unknown,
  extra: { job?: string; run?: string } = {},
): string => {
  const [component = ""] = type.split("/");
  return JSON.stringify({
    id: `e${++n}`,
    type,
    component,
    job: extra.job ?? "draw",
    run: extra.run ?? "r",
    at,
    data,
  });
};

const T0 = "2026-11-17T15:00:00.000Z";
const NOW = Date.parse("2026-11-17T16:00:00.000Z");

const ARMS = [
  { letter: "A", model: "anthropic/claude-sonnet-5-5", label: "Sonnet 5.5", default: false },
  { letter: "B", model: "anthropic/claude-opus-5-5", label: "Opus 5.5", default: true },
  { letter: "C", model: "openai/gpt-6.1-sol", label: "GPT-6.1 Sol", default: false },
];

const started = (trialId = "t1", caller = "agent:nova"): string =>
  line(`diagram/trial.started`, T0, {
    trialId,
    requestId: `req-${trialId}`,
    caller,
    job: "draw",
    request: "Draw the login flow",
    arms: ARMS,
  });

const result = (letter: string, at: string, ok = true, trialId = "t1"): string =>
  line(`diagram/trial.result`, at, {
    trialId,
    letter,
    model: ARMS.find((a) => a.letter === letter)?.model,
    ok,
    seconds: 12,
    ...(ok ? { preview: `![](/tmp/${letter}.png)` } : { error: "timed out" }),
  });

const picked = (pick: string, at = "2026-11-17T15:05:00.000Z", trialId = "t1"): string =>
  line(
    `diagram/trial.picked`,
    at,
    { trialId, pick, surface: "phone", by: "isaac" },
    { job: "trial", run: "pick-1" },
  );

const UNDO_PATCH = { components: { diagram: { model: "anthropic/claude-opus-5-5", trial: true } } };
const switched = (switchId = "s1", at = "2026-11-17T15:10:00.000Z"): string =>
  line(`diagram/trial.switched`, at, {
    switchId,
    trialId: "t1",
    from: "anthropic/claude-opus-5-5",
    to: "anthropic/claude-sonnet-5-5",
    fromLabel: "Opus 5.5",
    toLabel: "Sonnet 5.5",
    kept: false,
    wins: 8,
    of: 10,
    over: ["anthropic/claude-opus-5-5"],
    overLabels: ["Opus 5.5"],
    text: "Diagram: switched to Sonnet 5.5, won 8 of your last 10 picks over Opus 5.5",
    undo: UNDO_PATCH,
  });

const json = (value: unknown): string => JSON.stringify(value);

describe("trialsOfJournal", () => {
  it("streams: a started card runs every arm, then each result flips only its arm", () => {
    const lines = [started()];
    expect(trialsOfJournal(lines, NOW).snapshot.trials[0]).toEqual({
      id: "t1",
      agent: "diagram",
      label: "Diagram",
      thread: "assistant:nova",
      at: Date.parse(T0),
      request: "Draw the login flow",
      arms: [
        { letter: "A", status: "running" },
        { letter: "B", status: "running" },
        { letter: "C", status: "running" },
      ],
    });
    lines.push(result("C", "2026-11-17T15:00:20.000Z"));
    expect(trialsOfJournal(lines, NOW).snapshot.trials[0]?.arms.map((a) => a.status)).toEqual([
      "running",
      "running",
      "done",
    ]);
    lines.push(result("A", "2026-11-17T15:00:30.000Z"));
    const arms = trialsOfJournal(lines, NOW).snapshot.trials[0]?.arms;
    expect(arms?.map((a) => a.status)).toEqual(["done", "running", "done"]);
    expect(arms?.[0]).toEqual({
      letter: "A",
      status: "done",
      preview: "![](/tmp/A.png)",
      seconds: 12,
    });
  });

  it("never names a model before the pick, and reveals every arm's after it", () => {
    const before = [started(), result("A", T0), result("B", T0), result("C", T0)];
    expect(json(trialsOfJournal(before, NOW).snapshot)).not.toMatch(
      /model|Sonnet|Opus|GPT|anthropic|openai/,
    );
    const after = trialsOfJournal([...before, picked("B")], NOW).snapshot.trials[0];
    expect(after?.pick).toBe("B");
    expect(after?.pickedAt).toBe(Date.parse("2026-11-17T15:05:00.000Z"));
    expect(after?.arms.map((a) => [a.letter, a.model, a.modelLabel])).toEqual([
      ["A", "anthropic/claude-sonnet-5-5", "Sonnet 5.5"],
      ["B", "anthropic/claude-opus-5-5", "Opus 5.5"],
      ["C", "openai/gpt-6.1-sol", "GPT-6.1 Sol"],
    ]);
  });

  it("counts the first pick; a second one changes nothing", () => {
    const lines = [
      started(),
      result("A", T0),
      result("B", T0),
      picked("A"),
      picked("B", "2026-11-17T15:06:00.000Z"),
    ];
    const trial = trialsOfJournal(lines, NOW).snapshot.trials[0];
    expect(trial?.pick).toBe("A");
    expect(trial?.pickedAt).toBe(Date.parse("2026-11-17T15:05:00.000Z"));
  });

  it("shows a failed arm with its error and no preview", () => {
    const trial = trialsOfJournal([started(), result("C", T0, false)], NOW).snapshot.trials[0];
    expect(trial?.arms[2]).toEqual({
      letter: "C",
      status: "failed",
      error: "timed out",
      seconds: 12,
    });
  });

  it("records can't tell as an unsure pick, and reveals the models", () => {
    const trial = trialsOfJournal(
      [started(), result("A", T0), result("B", T0), picked("unsure")],
      NOW,
    ).snapshot.trials[0];
    expect(trial?.pick).toBe("unsure");
    expect(trial?.arms[0]?.modelLabel).toBe("Sonnet 5.5");
  });

  it("folds a switch into the card's chat and marks it undone", () => {
    const lines = [started(), switched()];
    expect(trialsOfJournal(lines, NOW).snapshot.switches).toEqual([
      {
        id: "s1",
        agent: "diagram",
        label: "Diagram",
        thread: "assistant:nova",
        at: Date.parse("2026-11-17T15:10:00.000Z"),
        text: "Diagram: switched to Sonnet 5.5, won 8 of your last 10 picks over Opus 5.5",
        from: "anthropic/claude-opus-5-5",
        to: "anthropic/claude-sonnet-5-5",
        fromLabel: "Opus 5.5",
        toLabel: "Sonnet 5.5",
        kept: false,
        undone: false,
      },
    ]);
    const fold = trialsOfJournal(lines, NOW);
    expect(fold.undo.get("s1")).toEqual({ agent: "diagram", patch: UNDO_PATCH, undone: false });
    expect(fold.badges.switched.get("diagram")).toEqual({
      toLabel: "Sonnet 5.5",
      at: Date.parse("2026-11-17T15:10:00.000Z"),
    });
    const undone = trialsOfJournal(
      [...lines, line("diagram/trial.undone", "2026-11-17T15:11:00.000Z", { switchId: "s1" })],
      NOW,
    );
    expect(undone.snapshot.switches[0]?.undone).toBe(true);
    expect(undone.badges.switched.has("diagram")).toBe(false);
  });

  it("skips bad lines and cards with too few arms", () => {
    const fold = trialsOfJournal(
      [
        "not json",
        "{}",
        line("diagram/trial.started", T0, { trialId: "x", arms: [ARMS[0]] }),
        started(),
      ],
      NOW,
    );
    expect(fold.snapshot.trials.map((t) => t.id)).toEqual(["t1"]);
  });
});

describe("callerThread", () => {
  it("maps an assistant caller and an omp session file to their chats", () => {
    expect(callerThread("agent:nova")).toBe("assistant:nova");
    expect(
      callerThread("/Users/ike/.omp/sessions/-Eva/2026-11-17T21-48-51-691Z_01a1eb7b-f46b.jsonl"),
    ).toBe("session:01a1eb7b-f46b");
    expect(callerThread(undefined)).toBeUndefined();
    expect(callerThread("agent:")).toBeUndefined();
    const fold = trialsOfJournal([started("t2", "/s/2026-11-17T21-48-51-691Z_abc.jsonl")], NOW);
    expect(fold.snapshot.trials[0]?.thread).toBe("session:abc");
  });
});

describe("trial badges", () => {
  const armStart = (letter: string, at: string, requestId?: string): string =>
    line(
      "diagram/job.started",
      at,
      {
        _tag: "job.started",
        trial: { id: "t1", letter },
        ...(requestId === undefined ? {} : { requestId }),
      },
      { run: `job-${letter}` },
    );

  it("letters the default arm's run and adds the other arms right after it", () => {
    const lines = [
      started(),
      armStart("A", "2026-11-17T15:00:01.000Z"),
      armStart("B", T0, "req-t1"),
      result("A", "2026-11-17T15:00:13.000Z"),
    ];
    const badges = trialsOfJournal(lines, NOW).badges;
    const ask: AgentRun = {
      run: "req-t1",
      agent: "diagram",
      status: "running",
      startedAt: Date.parse(T0),
    };
    const other: AgentRun = {
      run: "r-x",
      agent: "web-researcher",
      status: "done",
      startedAt: 1,
      seconds: 3,
    };
    const reply: AssistantMessage = {
      id: "a1",
      role: "assistant",
      text: "Drawing",
      at: 5,
      agents: [ask, other],
    };
    // A minute after the ask: the run is still within its time limit.
    const out = settleAssistantMessages([reply], [ask], Date.parse(T0) + 60_000, badges)[0];
    expect(out?.agents).toEqual([
      { ...ask, trial: "B" },
      {
        run: "trial:t1:A",
        agent: "diagram",
        status: "done",
        trial: "A",
        startedAt: Date.parse("2026-11-17T15:00:01.000Z"),
        seconds: 12,
      },
      {
        run: "trial:t1:C",
        agent: "diagram",
        status: "running",
        trial: "C",
        startedAt: Date.parse(T0),
      },
      other,
    ]);
    // Drawn again (an already badged row), nothing moves: the same object.
    const again: AssistantMessage = { ...reply, agents: out?.agents ?? [] };
    expect(settleAssistantMessages([again], [ask], Date.parse(T0) + 60_000, badges)[0]).toBe(again);
  });

  it("names the new model on runs that started within the badge window after a switch", () => {
    const badges = trialsOfJournal([started(), switched()], NOW).badges;
    const switchAt = Date.parse("2026-11-17T15:10:00.000Z");
    const fresh: AgentRun = {
      run: "r-1",
      agent: "diagram",
      status: "done",
      startedAt: switchAt + 60_000,
      seconds: 3,
    };
    const before: AgentRun = {
      run: "r-0",
      agent: "diagram",
      status: "done",
      startedAt: switchAt - 60_000,
      seconds: 3,
    };
    const late: AgentRun = {
      run: "r-2",
      agent: "diagram",
      status: "done",
      startedAt: switchAt + TRIAL_SWITCH_BADGE_MS,
      seconds: 3,
    };
    const reply: AssistantMessage = {
      id: "a1",
      role: "assistant",
      text: "x",
      at: 5,
      agents: [fresh, before, late],
    };
    expect(settleAssistantMessages([reply], [], NOW, badges)[0]?.agents).toEqual([
      { ...fresh, newModel: "Sonnet 5.5" },
      before,
      late,
    ]);
    const untouched: AssistantMessage = {
      id: "a2",
      role: "assistant",
      text: "x",
      at: 6,
      agents: [before],
    };
    expect(settleAssistantMessages([untouched], [], NOW, badges)[0]).toBe(untouched);
  });
});

describe("TrialService", () => {
  const setup = (lines: readonly string[]) => {
    const home = mkdtempSync(join(tmpdir(), "relay-trials-"));
    dirs.push(home);
    const journal = join(home, "events.ndjson");
    writeFileSync(journal, `${lines.join("\n")}\n`);
    const sent: ServerMessage[] = [];
    const book = new SpecialistRunBook(home, 60_000);
    const service = new TrialService({
      home,
      book,
      broadcast: (message) => sent.push(message),
      log: () => undefined,
    });
    services.push(service);
    const appended = (): Record<string, unknown>[] =>
      readFileSync(journal, "utf8")
        .split("\n")
        .slice(lines.length)
        .filter((l) => l !== "")
        .map((l) => JSON.parse(l) as Record<string, unknown>);
    return { service, book, sent, appended, journal };
  };

  it("appends Isaac's pick, pushes the revealed card at once, and refuses a second pick", async () => {
    const { service, sent, appended } = setup([started(), result("A", T0), result("B", T0)]);
    expect((await service.snapshot()).trials[0]?.pick).toBeUndefined();
    expect(await service.pick("t1", "A", "phone")).toEqual({ ok: true });
    const [pick] = appended();
    expect(pick).toMatchObject({
      type: "diagram/trial.picked",
      component: "diagram",
      job: "trial",
      data: { trialId: "t1", pick: "A", surface: "phone", by: "isaac" },
    });
    expect(String(pick?.["run"])).toMatch(/^pick-[0-9a-f]{8}$/);
    expect(Number.isNaN(Date.parse(String(pick?.["at"])))).toBe(false);
    const pushed = sent.at(-1);
    expect(pushed?.t).toBe("trials.snapshot");
    expect(
      pushed?.t === "trials.snapshot" ? pushed.trials[0]?.arms[0]?.modelLabel : undefined,
    ).toBe("Sonnet 5.5");
    expect(await service.pick("t1", "B", "desktop")).toEqual({
      ok: false,
      error: "This trial was already picked",
    });
    expect(appended()).toHaveLength(1);
  });

  it("refuses an unknown trial and a letter that has not finished", async () => {
    const { service, appended } = setup([started(), result("A", T0), result("B", T0)]);
    expect((await service.pick("nope", "A", "phone")).ok).toBe(false);
    expect(await service.pick("t1", "C", "phone")).toEqual({
      ok: false,
      error: "That result has not finished",
    });
    expect(appended()).toEqual([]);
  });

  it("undo appends trial.undone and the switch's config.set, once", async () => {
    const { service, sent, appended } = setup([started(), switched()]);
    expect(await service.undo("s1")).toEqual({ ok: true });
    const [undone, set] = appended();
    expect(undone).toMatchObject({
      type: "diagram/trial.undone",
      component: "diagram",
      data: { switchId: "s1" },
    });
    expect(set).toMatchObject({
      type: "atomic-agents/config.set",
      component: "atomic-agents",
      job: "config",
      data: { by: "isaac", patch: UNDO_PATCH },
    });
    expect(String(set?.["run"])).toMatch(/^undo-[0-9a-f]{8}$/);
    const pushed = sent.at(-1);
    expect(pushed?.t === "trials.snapshot" ? pushed.switches[0]?.undone : undefined).toBe(true);
    expect(await service.undo("s1")).toEqual({
      ok: false,
      error: "This switch was already undone",
    });
    expect((await service.undo("s9")).ok).toBe(false);
    expect(appended()).toHaveLength(2);
  });

  it("pushes the snapshot when a result streams in", async () => {
    const { book, sent, journal } = setup([started()]);
    const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
    await book.notify();
    await settle();
    const first = sent.length;
    appendFileSync(journal, `${result("A", "2026-11-17T15:00:30.000Z")}\n`);
    await book.notify();
    await settle();
    expect(sent.length).toBe(first + 1);
    const pushed = sent.at(-1);
    expect(pushed?.t === "trials.snapshot" ? pushed.trials[0]?.arms[0]?.status : undefined).toBe(
      "done",
    );
  });
});
