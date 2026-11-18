import { describe, expect, test } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { Cron, Deferred, Effect, Fiber, FileSystem, Layer, Schema } from "effect";
import { TestClock } from "effect/testing";
import { Background } from "../src/core/Background.ts";
import { define, job, type Registered, Trigger } from "../src/core/Component.ts";
import { EventBus } from "../src/core/Event.ts";
import { ModelRunner } from "../src/core/Model.ts";
import { Runner } from "../src/core/Runtime.ts";
import { publishRuntime } from "../src/core/RuntimeEvents.ts";
import * as Scheduler from "../src/core/Scheduler.ts";
import * as Health from "../src/core/observability/Health.ts";
import * as Outcomes from "../src/core/observability/Outcomes.ts";
import * as Roster from "../src/core/observability/Roster.ts";
import * as Tracing from "../src/core/observability/Tracing.ts";
import * as Traces from "../src/core/observability/Traces.ts";
import { oneProcess, tempHome } from "./harness.ts";

const events = { "probe.done": Schema.Struct({ n: Schema.Number }) };

/** `ok` answers at once; `slow` waits for `release` (a run that hangs until the test lets it go). */
const probe = (release: Deferred.Deferred<void>): Registered =>
  define({
    id: "probe",
    events,
    purpose: "Test component.",
    agent: { model: "test/default", candidates: ["test/default"], system: "" },
    jobs: [
      job(events, {
        id: "ok",
        description: "Emit probe.done.",
        input: Schema.Struct({ n: Schema.Number }),
        triggers: [Trigger.Manual()],
        run: ({ n }, ctx) => ctx.emit("probe.done", { n }),
      }),
      job(events, {
        id: "slow",
        description: "Every minute; ends when released.",
        input: Schema.Struct({}),
        triggers: [Trigger.Cron({ cron: "* * * * *", input: Effect.succeed({}) })],
        run: (_, ctx) =>
          Deferred.await(release).pipe(Effect.andThen(ctx.emit("probe.done", { n: 0 }))),
      }),
    ],
    tools: Layer.empty,
  });

/**
 * One service process over `root`, built as `cli.ts` builds it: tracing under the runner and the background layers
 * (`extra`), so their own fibers' spans reach the trace files.
 */
const service = <R>(
  root: string,
  release: Deferred.Deferred<void>,
  extra: Layer.Layer<never, never, R>,
) =>
  extra.pipe(
    Layer.provideMerge(Background.layer),
    Layer.provideMerge(Runner.layer),
    Layer.provideMerge(
      Layer.succeed(ModelRunner, ModelRunner.of({ generate: () => Effect.die("no model calls") })),
    ),
    Layer.provideMerge(Tracing.layer()),
    Layer.provideMerge(oneProcess(root, { code: [probe(release)] })),
  );

/** Let forked fibers run on the live clock (journal tails every 50 ms), from a test on the TestClock. */
const settle = (ms = 300) => TestClock.withLive(Effect.sleep(`${ms} millis`));

describe("outcomes", () => {
  test(
    "a consumer's outcome lands under its run's root; a run nobody reports on is pending, then unknown; a restarted service finds the run on disk",
    () =>
      Effect.gen(function* () {
        const root = yield* tempHome;
        const release = yield* Deferred.make<void>();
        const report = (requestId: string, outcome: "used" | "skipped") =>
          Effect.gen(function* () {
            yield* publishRuntime(
              yield* EventBus,
              "outcome.reported",
              { requestId, consumer: "relay.widgets", outcome, latencyMs: 1200, detail: "live" },
              "outcome",
            );
          });

        yield* Effect.gen(function* () {
          const runner = yield* Runner;
          yield* runner.run("probe", "ok", { n: 1 }, { requestId: "req-used" });
          yield* runner.run("probe", "ok", { n: 2 }, { requestId: "req-silent" });
          yield* runner.run("probe", "ok", { n: 3 });
          yield* report("req-used", "used");
          yield* Effect.sleep("300 millis");
        }).pipe(Effect.provide(service(root, release, Outcomes.layer)), Effect.scoped);

        const now = Date.now();
        const traces = yield* Traces.query(root, { since: 0, limit: 10 });
        const byRequest = (id: string) =>
          traces.find((trace) => trace.root.attributes["agent.request"] === id)!;
        const used = byRequest("req-used");
        expect(
          used.root.children.filter((child) => child.name === "outcome.reported"),
        ).toMatchObject([
          {
            attributes: {
              "agent.id": "probe",
              "outcome.value": "used",
              "outcome.consumer": "relay.widgets",
              "outcome.latency_ms": 1200,
            },
          },
        ]);
        expect(used.outcome).toEqual({ value: "used", consumer: "relay.widgets", latencyMs: 1200 });
        expect(Traces.render(used).split("\n")[0]).toEndWith(
          "outcome: used by relay.widgets after 1.20s",
        );
        expect(byRequest("req-silent").outcome).toEqual({ value: "pending" });
        expect(
          Traces.outcomeOf(byRequest("req-silent"), now + Traces.OUTCOME_WINDOW_MS + 1_000),
        ).toEqual({ value: "unknown" });
        // A run no consumer asked for expects no outcome.
        const manual = traces.find(
          (trace) => trace.root.attributes["agent.request"] === undefined,
        )!;
        expect(manual.outcome).toBeUndefined();

        // A new service process: the runner never saw req-silent, so its outcome finds the run in the trace files.
        yield* Effect.gen(function* () {
          yield* report("req-silent", "skipped");
          yield* Effect.sleep("600 millis");
        }).pipe(Effect.provide(service(root, release, Outcomes.layer)), Effect.scoped);
        const [late] = yield* Traces.query(root, { run: "req-silent", since: 0, limit: 1 });
        expect(late!.outcome).toEqual({
          value: "skipped",
          consumer: "relay.widgets",
          latencyMs: 1200,
        });
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.runPromise),
    20_000,
  );
});

describe("missed ticks", () => {
  const T0 = Date.parse("2026-11-18T10:00:00Z");

  test("ticksBetween: every tick after `from` up to and including `to`", () => {
    const everyFive = Cron.parseUnsafe("*/5 * * * *");
    expect(
      Scheduler.ticksBetween(everyFive, T0, T0 + 15 * 60_000).map((at) => (at - T0) / 60_000),
    ).toEqual([5, 10, 15]);
    expect(Scheduler.ticksBetween(everyFive, T0, T0 + 4 * 60_000)).toEqual([]);
  });

  test(
    "on a fake clock: ticks lost while down, a tick while the last run is still going, a run past its deadline, a refused run",
    () =>
      Effect.gen(function* () {
        const root = yield* tempHome;
        const fs = yield* FileSystem.FileSystem;
        // The last tick a service handled was 10 minutes before this one starts.
        yield* fs.makeDirectory(`${root}/state/schedule`, { recursive: true });
        yield* fs.writeFileString(
          `${root}/state/schedule/probe.slow.json`,
          JSON.stringify({ cron: "* * * * *", expected: T0 - 10 * 60_000 }),
        );
        yield* TestClock.setTime(T0);
        const release = yield* Deferred.make<void>();

        yield* Effect.gen(function* () {
          const runner = yield* Runner;
          const start =
            (job: string): Scheduler.StartRun =>
            (input, schedule) =>
              runner.run("probe", job, input, { schedule });
          const entry = (job: string) => ({
            component: "probe",
            job,
            cron: "* * * * *",
            input: Effect.succeed({}),
          });
          const slow = yield* Effect.forkChild(Scheduler.arm(entry("slow"), start("slow"), 90_000));
          const refused = yield* Effect.forkChild(Scheduler.arm(entry("nope"), start("nope")));
          yield* settle();
          // +1 min: the run starts and hangs; +2: busy; +2.5: past the 90 s deadline; +3: busy.
          for (let minute = 1; minute <= 3; minute++) {
            yield* TestClock.adjust("1 minute");
            yield* settle();
          }
          yield* Deferred.succeed(release, undefined);
          yield* settle();
          // +4 min: the run ended, so this tick runs.
          yield* TestClock.adjust("1 minute");
          yield* settle();
          yield* Fiber.interrupt(slow);
          yield* Fiber.interrupt(refused);
        }).pipe(Effect.provide(service(root, release, Layer.empty)), Effect.scoped);

        const traces = yield* Traces.query(root, { since: 0, limit: 100 });
        const missed = traces
          .filter((trace) => trace.root.name === "schedule.missed")
          .map(({ root: { attributes } }) => ({
            job: attributes["agent.job"],
            reason: attributes["schedule.reason"],
            count: attributes["schedule.count"],
            minute: (Number(attributes["schedule.expected"]) - T0) / 60_000,
          }))
          .sort((a, b) => a.minute - b.minute || String(a.job).localeCompare(String(b.job)));
        expect(missed).toEqual([
          { job: "slow", reason: "down", count: 9, minute: -9 },
          { job: "nope", reason: "not-started", count: 1, minute: 1 },
          { job: "slow", reason: "hung", count: 1, minute: 1 },
          { job: "nope", reason: "not-started", count: 1, minute: 2 },
          { job: "slow", reason: "busy", count: 1, minute: 2 },
          { job: "nope", reason: "not-started", count: 1, minute: 3 },
          { job: "slow", reason: "busy", count: 1, minute: 3 },
          { job: "nope", reason: "not-started", count: 1, minute: 4 },
        ]);
        const runs = traces
          .filter((trace) => trace.root.name === "agent.run")
          .map(({ root: { attributes } }) => [
            attributes["run.trigger"],
            (Number(attributes["schedule.expected"]) - T0) / 60_000,
          ])
          .sort((a, b) => Number(a[1]) - Number(b[1]));
        expect(runs).toEqual([
          ["cron", 1],
          ["cron", 4],
        ]);

        // health over that hour: 4 ticks expected (+1..+4 min), 2 ran, 2 missed busy (the hang ran its tick), 9 down before.
        const health = Health.summarize({
          traces,
          since: T0 - 3_600_000,
          now: T0 + 5 * 60_000,
          agents: [{ id: "probe", enabled: true, crons: [{ job: "slow", cron: "* * * * *" }] }],
          counted: [],
        });
        expect(health.agents[0]!.crons).toEqual([
          {
            job: "slow",
            cron: "* * * * *",
            // No roster check yet: ticks count from now, so none are expected.
            expected: 0,
            ran: 2,
            missed: 11,
            reasons: { down: 9, hung: 1, busy: 2 },
            unaccounted: 0,
          },
        ]);
      }).pipe(
        Effect.scoped,
        Effect.provide(TestClock.layer()),
        Effect.provide(BunServices.layer),
        Effect.runPromise,
      ),
    20_000,
  );
});

describe("roster check", () => {
  test("missing: what config.json counts on (live or shadow, not disabled) that is not loaded, and why", () => {
    const config = {
      components: {
        widget: { mode: "live" as const },
        "ecard-main-watch": { mode: "live" as const },
        "ecard-slack-fetch": { mode: "shadow" as const },
        drafter: { mode: "shadow" as const, enabled: false },
        "no-mode": { enabled: true },
        off: { mode: "off" as const },
      },
    };
    expect(
      Roster.missingAgents(
        ["widget"],
        [{ file: "/home/agents/ecard-slack-fetch/AGENT.md", message: "bad yaml" }],
        config,
      ),
    ).toEqual([
      {
        id: "ecard-main-watch",
        why: "config.json mode live, not loaded: no agent file with this id in the agent dirs",
      },
      {
        id: "ecard-slack-fetch",
        why: "config.json mode shadow, not loaded: its file fails to load (bad yaml)",
      },
    ]);
  });

  test(
    "the service records a roster.check at start with a roster.missing child per absent agent",
    () =>
      Effect.gen(function* () {
        const root = yield* tempHome;
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(
          `${root}/config.json`,
          JSON.stringify({ components: { "ecard-main-watch": { mode: "live" } } }),
        );
        const release = yield* Deferred.make<void>();
        yield* Effect.sleep("300 millis").pipe(
          Effect.provide(service(root, release, Roster.layer)),
          Effect.scoped,
        );
        const [check] = (yield* Traces.query(root, { since: 0, limit: 10 })).filter(
          (trace) => trace.root.name === "roster.check",
        );
        expect(check!.root.attributes).toMatchObject({
          "roster.loaded": 1,
          "roster.loaded_ids": "probe",
          "roster.counted": 1,
          "roster.missing": "ecard-main-watch",
        });
        expect(check!.root.children.map((child) => child.attributes["roster.agent"])).toEqual([
          "ecard-main-watch",
        ]);
        expect(Traces.render(check!).split("\n")[0]).toContain(
          "roster.check 1 agents loaded missing: ecard-main-watch",
        );
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.runPromise),
    20_000,
  );
});
