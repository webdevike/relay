import { describe, expect, test } from "bun:test";
import { Deferred, Effect, Fiber, FileSystem, Layer, Option, Schedule, Schema } from "effect";
import { TestClock } from "effect/testing";
import { Background } from "../src/core/Background.ts";
import { define, job, OnEvent, type Registered, Trigger } from "../src/core/Component.ts";
import { AgentEvent, EventBus, Lifecycle, lifecycle } from "../src/core/Event.ts";
import { request } from "../src/core/Requests.ts";
import { Runner } from "../src/core/Runtime.ts";
import { events as runtimeEvents } from "../src/core/RuntimeEvents.ts";
import { Settings } from "../src/core/Settings.ts";
import { oneProcess, runtime, tempHome } from "./harness.ts";

class Boom extends Schema.TaggedError<Boom>()("Boom", { message: Schema.String }) {}

const contract = {
  id: "probe" as const,
  events: { "probe.done": Schema.Struct({ n: Schema.Number }) },
};

// @ts-expect-error a misspelled event name must not compile
OnEvent(contract, "probe.dnoe");

const probe = (ticked: Deferred.Deferred<void>): Registered =>
  define({
    ...contract,
    purpose: "Test component.",
    agent: { model: "test/default", candidates: ["test/default"], system: "" },
    jobs: [
      job(contract.events, {
        id: "ok",
        description: "Emit probe.done.",
        input: Schema.Struct({ n: Schema.Number }),
        triggers: [Trigger.Manual()],
        run: ({ n }, ctx) => ctx.emit("probe.done", { n }),
      }),
      job(contract.events, {
        id: "boom",
        description: "Always fails.",
        input: Schema.Struct({}),
        triggers: [Trigger.Manual()],
        run: () => Effect.fail(new Boom({ message: "nope" })),
      }),
      job(contract.events, {
        id: "flaky",
        description: "Fails on the default model, works on any other.",
        input: Schema.Struct({}),
        triggers: [Trigger.Manual()],
        run: (_, ctx) =>
          ctx.model === "test/default"
            ? Effect.fail(new Boom({ message: "provider down" }))
            : ctx.emit("probe.done", { n: 1 }),
      }),
      job(contract.events, {
        id: "tick",
        description: "Every minute.",
        input: Schema.Struct({}),
        triggers: [Trigger.Cron({ cron: "* * * * *", input: Effect.succeed({}) })],
        run: () => Deferred.succeed(ticked, undefined),
      }),
    ],
    tools: Layer.empty,
  });

const ofRun = (events: ReadonlyArray<AgentEvent>, run: string) =>
  events.filter((event) => event.run === run);

/** Retry `check` on the live clock until it answers Some, for up to 10 s. */
const eventually = <A, E>(check: Effect.Effect<Option.Option<A>, E>) =>
  check.pipe(
    Effect.flatMap((found) =>
      Option.isSome(found) ? Effect.succeed(found.value) : Effect.fail("not yet" as const),
    ),
    Effect.retry(Schedule.spaced("100 millis")),
    Effect.timeout("10 seconds"),
  );

const decodeChanged = Schema.decodeUnknownEffect(runtimeEvents["config.changed"]);

describe("lifecycle events", () => {
  test("every run is wrapped in typed job.* events that decode with Lifecycle", () =>
    Effect.gen(function* () {
      const root = yield* tempHome;
      const ticked = yield* Deferred.make<void>();
      yield* Effect.gen(function* () {
        const runner = yield* Runner;
        const bus = yield* EventBus;
        const ok = yield* runner.run("probe", "ok", { n: 7 }, { model: "test/override" });
        const boom = yield* runner.run("probe", "boom", {});
        const bad = yield* runner.run("probe", "ok", { n: "seven" });
        expect([ok.ok, boom.ok, bad.ok]).toEqual([true, false, false]);
        const history = yield* bus.history;

        const okEvents = ofRun(history, ok.run);
        expect(okEvents.map((event) => event.type)).toEqual([
          "probe/job.started",
          "probe/probe.done",
          "probe/job.succeeded",
        ]);
        expect(yield* Schema.decodeUnknownEffect(Lifecycle)(okEvents[0]!.data)).toEqual({
          _tag: "job.started",
          input: { n: 7 },
          model: "test/override",
        });
        expect((yield* Schema.decodeUnknownEffect(Lifecycle)(okEvents[2]!.data))._tag).toBe(
          "job.succeeded",
        );

        const failures = (run: string) =>
          ofRun(history, run)
            .flatMap((event) => Option.toArray(lifecycle(event)))
            .filter((event) => event._tag === "job.failed");
        expect(failures(boom.run)).toMatchObject([
          { model: "test/default", error: "Boom", message: "nope" },
        ]);
        expect(failures(bad.run)).toMatchObject([{ error: "SchemaError" }]);
      }).pipe(Effect.provide(runtime(root, { code: [probe(ticked)] })));
    }).pipe(Effect.scoped, Effect.runPromise));

  test("journal lines written before data carried _tag still decode, the tag taken from the envelope type", () => {
    const envelope = { id: "1", component: "prop-render", job: "render", run: "r", at: "" };
    const old = new AgentEvent({
      ...envelope,
      type: "prop-render/job.started",
      data: { input: {}, model: "m" },
    });
    expect(Option.getOrUndefined(lifecycle(old))).toEqual({
      _tag: "job.started",
      input: {},
      model: "m",
    });
    const other = new AgentEvent({
      ...envelope,
      type: "prop-render/render.completed",
      data: { model: "m" },
    });
    expect(Option.isNone(lifecycle(other))).toBe(true);
  });
});

describe("config live reload", () => {
  test(
    "file edits apply without a restart, a bad edit keeps the last good config, another process's set is announced once",
    () =>
      Effect.gen(function* () {
        const root = yield* tempHome;
        const ticked = yield* Deferred.make<void>();
        const world = { code: [probe(ticked)] };
        const file = `${root}/config.json`;
        yield* Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const settings = yield* Settings;
          const bus = yield* EventBus;
          const runner = yield* Runner;
          const modelIs = (expected: string) =>
            Effect.map(settings.current, (current) =>
              Option.liftPredicate(
                current.components?.["probe"]?.model,
                (model) => model === expected,
              ),
            );
          const announcements = bus.history.pipe(
            Effect.flatMap((events) =>
              Effect.forEach(
                events.filter((event) => event.type === "atomic-agents/config.changed"),
                (event) => decodeChanged(event.data),
              ),
            ),
          );

          yield* fs.writeFileString(
            file,
            JSON.stringify({ components: { probe: { model: "a/one" } } }),
          );
          yield* eventually(modelIs("a/one"));
          expect((yield* announcements).map((data) => data.by)).toEqual(["file"]);

          yield* fs.writeFileString(
            file,
            JSON.stringify({ components: { probe: { cron: { tick: "every day" } } } }),
          );
          yield* eventually(
            Effect.map(bus.history, (events) =>
              Option.fromUndefinedOr(
                events.find((event) => event.type === "atomic-agents/config.rejected"),
              ),
            ),
          );
          expect(Option.isSome(yield* modelIs("a/one"))).toBe(true);

          // Another process (`atomic-agents use`) with its own Settings and EventBus over the same home.
          yield* fs.writeFileString(
            file,
            JSON.stringify({ components: { probe: { model: "a/one" } } }),
          );
          yield* Effect.gen(function* () {
            yield* (yield* Settings).set(
              { components: { probe: { model: "b/two" } } },
              "tester",
              "use",
            );
          }).pipe(Effect.provide(Layer.fresh(oneProcess(root, world)))); // fresh: a nested provide would reuse the service's Settings
          yield* eventually(modelIs("b/two"));
          yield* Effect.sleep("1500 millis"); // more watch ticks: a duplicate announcement would land here
          const forB = (yield* announcements).filter(
            (data) => data.config.components?.["probe"]?.model === "b/two",
          );
          expect(forB.map((data) => data.by)).toEqual(["tester"]);

          const next = yield* runner.run("probe", "ok", { n: 1 });
          const [started] = ofRun(yield* bus.history, next.run);
          expect(started?.data).toMatchObject({ _tag: "job.started", model: "b/two" });
        }).pipe(
          Effect.provide(
            Settings.layerWatch.pipe(
              Layer.provideMerge(Background.layer),
              Layer.provideMerge(runtime(root, world)),
            ),
          ),
        );
      }).pipe(Effect.scoped, Effect.runPromise),
    30_000,
  );
});

describe("cron triggers", () => {
  test(
    "a cron job runs when the TestClock reaches its minute, with Clock-based run ids and timings",
    () =>
      Effect.gen(function* () {
        const root = yield* tempHome;
        const ticked = yield* Deferred.make<void>();
        yield* Effect.gen(function* () {
          const bus = yield* EventBus;
          // The trigger loop arms asynchronously: advance a minute at a time until the job has run.
          for (let minute = 1; minute <= 5 && !(yield* Deferred.isDone(ticked)); minute++) {
            yield* TestClock.adjust("1 minute");
            yield* TestClock.withLive(Effect.sleep("50 millis"));
          }
          yield* TestClock.withLive(Deferred.await(ticked).pipe(Effect.timeout("5 seconds")));
          const runs = (yield* bus.history).filter((event) => event.job === "tick");
          expect(runs.map((event) => event.type)).toEqual([
            "probe/job.started",
            "probe/job.succeeded",
          ]);
          const [start, done] = runs;
          expect(start!.at).toMatch(/^1970-01-01T00:0[1-5]:00\.000Z$/);
          expect(start!.run).toMatch(/^19700101T000[1-5]00-[0-9a-f]{8}$/);
          expect(Option.getOrUndefined(lifecycle(done!))).toEqual({
            _tag: "job.succeeded",
            model: "test/default",
            seconds: 0,
          });
        }).pipe(
          Effect.provide(
            Runner.layerTriggers.pipe(
              Layer.provideMerge(Background.layer),
              Layer.provideMerge(runtime(root, { code: [probe(ticked)] })),
            ),
          ),
        );
      }).pipe(Effect.scoped, Effect.provide(TestClock.layer()), Effect.runPromise),
    20_000,
  );
});

describe("fallback model", () => {
  const phases = (events: ReadonlyArray<AgentEvent>, run: string) =>
    ofRun(events, run).flatMap((event) => Option.toArray(lifecycle(event)));
  const withFallback = Effect.gen(function* () {
    yield* (yield* Settings).set(
      { components: { probe: { fallbackModel: "test/backup" } } },
      "tester",
      "use",
    );
  });
  const world = (root: string) => runtime(root, { code: [probe(Deferred.makeUnsafe<void>())] });

  test("a run that fails on the main model is retried once on the fallback, which is recorded as the result's model", () =>
    Effect.gen(function* () {
      const root = yield* tempHome;
      yield* Effect.gen(function* () {
        yield* withFallback;
        const result = yield* (yield* Runner).run("probe", "flaky", {});
        expect(result.ok).toBe(true);
        const seen = phases(yield* (yield* EventBus).history, result.run);
        expect(seen).toMatchObject([
          { _tag: "job.started", model: "test/default" },
          {
            _tag: "job.started",
            model: "test/backup",
            fellBackFrom: "test/default",
            reason: "Boom: provider down",
          },
          { _tag: "job.succeeded", model: "test/backup", fellBack: true },
        ]);
        // A job that fails on the fallback too is one job.failed, naming the model that gave up last.
        const both = yield* (yield* Runner).run("probe", "boom", {});
        expect(both.ok).toBe(false);
        expect(
          phases(yield* (yield* EventBus).history, both.run).filter(
            (phase) => phase._tag === "job.failed",
          ),
        ).toMatchObject([{ model: "test/backup", error: "Boom" }]);
      }).pipe(Effect.provide(world(root)));
    }).pipe(Effect.scoped, Effect.runPromise));

  test("a run that succeeds on the main model never touches the fallback", () =>
    Effect.gen(function* () {
      const root = yield* tempHome;
      yield* Effect.gen(function* () {
        yield* withFallback;
        const result = yield* (yield* Runner).run("probe", "ok", { n: 2 });
        expect(phases(yield* (yield* EventBus).history, result.run)).toEqual([
          { _tag: "job.started", input: { n: 2 }, model: "test/default" },
          { _tag: "job.succeeded", model: "test/default", seconds: expect.any(Number) },
        ]);
      }).pipe(Effect.provide(world(root)));
    }).pipe(Effect.scoped, Effect.runPromise));

  test("with no fallback configured a failure is the old single job.failed", () =>
    Effect.gen(function* () {
      const root = yield* tempHome;
      yield* Effect.gen(function* () {
        const result = yield* (yield* Runner).run("probe", "flaky", {});
        expect(result.ok).toBe(false);
        expect(
          phases(yield* (yield* EventBus).history, result.run).map((phase) => [
            phase._tag,
            phase.model,
          ]),
        ).toEqual([
          ["job.started", "test/default"],
          ["job.failed", "test/default"],
        ]);
      }).pipe(Effect.provide(world(root)));
    }).pipe(Effect.scoped, Effect.runPromise));
});

describe("a run that falls back answers its asker once, from its last attempt", () => {
  const pickEvents = {
    "pick.requested": Schema.Struct({ requestId: Schema.String, draft: Schema.String }),
    "pick.ready": Schema.Struct({
      requestId: Schema.String,
      kind: Schema.String,
      why: Schema.String,
    }),
  };
  const decodeReady = Schema.decodeUnknownOption(pickEvents["pick.ready"]);
  // Like an agent file's `onFailure` (the widget's): a failed model call still emits a "failed: ..." reply, then the job
  // fails. `test/backup` answers after 2 s; `test/silent` fails without a reply.
  const picker = define({
    id: "picker",
    events: pickEvents,
    purpose: "Answer a pick request on whichever model it runs.",
    agent: { model: "test/default", candidates: ["test/default"], system: "" },
    jobs: [
      job(pickEvents, {
        id: "pick",
        description: "Pick for the request on the run's model.",
        input: pickEvents["pick.requested"],
        triggers: [Trigger.OnEvent({ type: "picker/pick.requested" })],
        run: ({ requestId }, ctx) =>
          ctx.model === "test/backup"
            ? Effect.sleep("2 seconds").pipe(
                Effect.andThen(
                  ctx.emit("pick.ready", { requestId, kind: "openui", why: "the real answer" }),
                ),
              )
            : ctx.model === "test/silent"
              ? Effect.sleep("1 second").pipe(
                  Effect.andThen(Effect.fail(new Boom({ message: "silent too" }))),
                )
              : Effect.sleep("400 millis").pipe(
                  Effect.andThen(
                    ctx.emit("pick.ready", {
                      requestId,
                      kind: "none",
                      why: `failed: ${ctx.model} is down`,
                    }),
                  ),
                  Effect.andThen(Effect.fail(new Boom({ message: `${ctx.model} is down` }))),
                ),
      }),
    ],
    asks: {
      request: "pick.requested",
      reply: "pick.ready",
      show: (reply) =>
        Option.match(decodeReady(reply), { onNone: () => "none", onSome: ({ why }) => why }),
    },
    tools: Layer.empty,
  });

  /** Advance the fake clock `ms` in 100 ms steps, letting the service's fibers run between them. */
  const advance = (ms: number) =>
    Effect.gen(function* () {
      for (let at = 0; at < ms; at += 100) {
        yield* TestClock.adjust("100 millis");
        yield* TestClock.withLive(Effect.sleep("2 millis"));
      }
    });

  /**
   * Ask `picker` as a caller does (`Requests.request`) on a running service, `fallbackModel` set when given: what the
   * run had published 1 s in (after the main attempt failed at 0.4 s) and at the end (4 s), and the caller's answer.
   */
  const askPicker = (fallbackModel?: string) =>
    Effect.gen(function* () {
      const root = yield* tempHome;
      return yield* Effect.gen(function* () {
        if (fallbackModel !== undefined)
          yield* (yield* Settings).set(
            { components: { picker: { fallbackModel } } },
            "tester",
            "use",
          );
        const bus = yield* EventBus;
        const published = Effect.map(bus.history, (all) =>
          all
            .filter((event) => event.job === "pick")
            .map((event) => {
              const what = Option.match(lifecycle(event), {
                onSome: (phase) => phase.model,
                onNone: () => Option.getOrUndefined(decodeReady(event.data))?.why,
              });
              return `${event.type.slice("picker/".length)} ${what}`;
            }),
        );
        const asked = yield* Effect.forkChild(request("picker", { draft: "sales up" }, 10_000));
        yield* advance(1_000);
        const early = yield* published;
        yield* advance(3_000);
        return { answer: yield* Fiber.join(asked), early, events: yield* published };
      }).pipe(
        Effect.provide(
          Runner.layerTriggers.pipe(
            Layer.provideMerge(Background.layer),
            Layer.provideMerge(runtime(root, { code: [picker] })),
          ),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer()), Effect.runPromise);

  test("the main attempt's failure reply is held: the asker's only reply is the fallback's real answer", async () => {
    const { answer, early, events } = await askPicker("test/backup");
    // 0.6 s after the main attempt failed, the fallback is running and nothing has answered the asker.
    expect(early).toEqual(["job.started test/default", "job.started test/backup"]);
    expect(events).toEqual([
      "job.started test/default",
      "job.started test/backup",
      "pick.ready the real answer",
      "job.succeeded test/backup",
    ]);
    expect(answer).toMatchObject({
      status: "done",
      text: "the real answer",
      model: "test/backup",
      fellBack: true,
    });
  }, 20_000);

  test("with no fallback the failure reply goes out as soon as the attempt emits it, as before", async () => {
    const { answer, early, events } = await askPicker();
    expect(early).toEqual([
      "job.started test/default",
      "pick.ready failed: test/default is down",
      "job.failed test/default",
    ]);
    expect(events).toEqual(early);
    expect(answer).toMatchObject({ status: "done", text: "failed: test/default is down" });
  }, 20_000);

  test("when the fallback fails too, the run publishes one failure reply: the fallback's", async () => {
    const { answer, events } = await askPicker("test/dead");
    expect(events).toEqual([
      "job.started test/default",
      "job.started test/dead",
      "pick.ready failed: test/dead is down",
      "job.failed test/dead",
    ]);
    expect(answer).toMatchObject({ text: "failed: test/dead is down", fellBack: true });
  }, 20_000);

  test("a fallback that fails without a reply leaves the main attempt's failure reply as the run's one answer", async () => {
    const { answer, events } = await askPicker("test/silent");
    expect(events).toEqual([
      "job.started test/default",
      "job.started test/silent",
      "pick.ready failed: test/default is down",
      "job.failed test/silent",
    ]);
    expect(answer).toMatchObject({ text: "failed: test/default is down" });
  }, 20_000);
});
