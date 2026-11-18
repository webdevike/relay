import { describe, expect, test } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { Effect, FileSystem, Layer, Schema } from "effect";
import { define, job, type Registered, Trigger } from "../src/core/Component.ts";
import { EventBus, makeEvent } from "../src/core/Event.ts";
import { generateWithTools, ModelRunner, tool } from "../src/core/Model.ts";
import { Runner } from "../src/core/Runtime.ts";
import { Settings } from "../src/core/Settings.ts";
import * as Tracing from "../src/core/observability/Tracing.ts";
import * as Traces from "../src/core/observability/Traces.ts";
import { runtime, tempHome } from "./harness.ts";

class Boom extends Schema.TaggedError<Boom>()("Boom", { message: Schema.String }) {}

const events = { "probe.done": Schema.Struct({ n: Schema.Number }) };

/** `flaky` fails on the default model; on the backup it runs a tool loop (a good call, a failing one, an unknown tool). */
const probe: Registered = define({
  id: "probe",
  events,
  purpose: "Test component.",
  agent: { model: "test/default", candidates: ["test/default"], system: "" },
  jobs: [
    job(events, {
      id: "flaky",
      description: "Fails on the default model, uses tools on any other.",
      input: Schema.Struct({}),
      triggers: [Trigger.Manual()],
      run: (_, ctx) =>
        ctx.model === "test/default"
          ? Effect.fail(new Boom({ message: "provider down" }))
          : generateWithTools(
              { model: ctx.model, system: "", prompt: "find x" },
              {
                tools: [
                  tool({
                    name: "lookup",
                    description: "Look an id up.",
                    args: Schema.Struct({ id: Schema.String }),
                    example: '{"id": "x"}',
                    run: ({ id }) =>
                      id === "x"
                        ? Effect.succeed({ found: id })
                        : Effect.fail({ message: `no ${id}` }),
                  }),
                ],
                answer: Schema.Struct({ n: Schema.Number }),
                answerExample: '{"n": 1}',
                maxSteps: 4,
              },
            ).pipe(Effect.flatMap(({ answer }) => ctx.emit("probe.done", answer))),
    }),
    job(events, {
      id: "boom",
      description: "Always fails.",
      input: Schema.Struct({}),
      triggers: [Trigger.Manual()],
      run: () => Effect.fail(new Boom({ message: "nope" })),
    }),
  ],
  tools: Layer.empty,
});

/** The model's replies in order: two tool calls, an unknown tool, the answer. */
const scripted = () => {
  const replies = [
    { tool: "lookup", args: { id: "x" } },
    { tool: "lookup", args: { id: "y" } },
    { tool: "delete_all", args: {} },
    { answer: { n: 3 } },
  ];
  return ModelRunner.of({
    generate: (request) =>
      Effect.succeed({
        text: JSON.stringify(replies.shift()),
        model: request.model,
        provider: "test",
        seconds: 0,
        cost: 0.0012,
        tokens: { input: 120, output: 30, cachedInput: 0 },
      }),
  });
};

/** A tree as names (with the attribute that tells siblings apart), errors marked. */
const outline = (node: Traces.SpanNode): unknown => {
  const what =
    node.attributes["event.type"] ?? node.attributes["tool.name"] ?? node.attributes["model.id"];
  const line = `${node.name}${what === undefined ? "" : ` ${what}`}${node.error === undefined ? "" : ` ✗ ${node.error.tag}`}`;
  return node.children.length === 0 ? line : [line, node.children.map(outline)];
};

describe("traces", () => {
  test(
    "every run is one trace: attempts, the fallback, tool calls and emits as spans, errors by their tag; nothing outside a run",
    () =>
      Effect.gen(function* () {
        const root = yield* tempHome;
        const { flaky, boom } = yield* Effect.gen(function* () {
          yield* (yield* Settings).set(
            { components: { probe: { fallbackModel: "test/backup" } } },
            "tester",
            "use",
          );
          const runner = yield* Runner;
          const flaky = yield* runner.run("probe", "flaky", {});
          const boom = yield* runner.run("probe", "boom", {});
          // Published outside any run: an unsampled root, so it never reaches the files.
          yield* (yield* EventBus).publish(
            yield* makeEvent({
              type: "probe/probe.done",
              component: "probe",
              job: "t",
              run: "loose",
              data: { n: 0 },
            }),
          );
          return { flaky, boom };
        }).pipe(
          Effect.provide(Tracing.layer()),
          Effect.provide(runtime(root, { code: [probe] }, scripted())),
        );
        expect([flaky.ok, boom.ok]).toEqual([true, false]);

        const all = yield* Traces.query(root, { since: 0, limit: 10 });
        expect(all.map((trace) => trace.root.attributes["agent.run"]).sort()).toEqual(
          [flaky.run, boom.run].sort(),
        );
        const [saved] = yield* Traces.query(root, { run: flaky.run, since: 0, limit: 10 });
        expect(saved!.open).toBe(false);
        expect(saved!.root.error).toBeUndefined();
        expect(saved!.root.attributes).toMatchObject({
          "agent.id": "probe",
          "agent.job": "flaky",
          "run.model": "test/backup",
          "run.fell_back": true,
        });
        expect(outline(saved!.root)).toEqual([
          "agent.run test/default",
          [
            "event.emit probe/job.started",
            "agent.attempt test/default ✗ Boom",
            "event.emit probe/job.started",
            [
              "agent.attempt test/backup",
              [
                "tool.call lookup",
                "tool.call lookup ✗ Error",
                "tool.call delete_all ✗ Error",
                "event.emit probe/probe.done",
              ],
            ],
            "event.emit probe/job.succeeded",
          ],
        ]);
        const fallback = saved!.root.children[3]!;
        expect(fallback.attributes).toMatchObject({
          "fallback.from": "test/default",
          "fallback.reason": "Boom: provider down",
        });
        const [, failed, unknown] = fallback.children;
        expect(failed!.attributes).toMatchObject({
          "tool.caller": "model",
          "tool.args": '{"id":"y"}',
        });
        expect(failed!.error).toEqual({ tag: "Error", message: "no y" });
        expect(unknown!.error?.message).toContain("no tool delete_all");

        const [lost] = yield* Traces.query(root, { run: boom.run, since: 0, limit: 10 });
        expect(lost!.root.error).toEqual({ tag: "Boom", message: "nope" });
        expect(Traces.render(lost!).split("\n")[0]).toContain(
          `agent.run probe/boom run ${boom.run}`,
        );
        expect(Traces.render(lost!).split("\n")[0]).toEndWith("✗ Boom: nope");

        const rendered = Traces.render(saved!);
        expect(rendered).toContain("├─ agent.attempt test/default  ");
        expect(rendered).toContain("✗ Boom: provider down");
        expect(rendered).toContain("├─ agent.attempt test/backup fallback from test/default");
        expect(rendered).toContain('│  ├─ tool.call lookup {"id":"y"}');
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.runPromise),
    20_000,
  );

  test(
    "a spec agent's model call carries its harness, tokens and cost",
    () =>
      Effect.gen(function* () {
        const root = yield* tempHome;
        const fs = yield* FileSystem.FileSystem;
        yield* fs.makeDirectory(`${root}/agents`);
        yield* fs.writeFileString(
          `${root}/agents/greeter.json`,
          JSON.stringify({
            id: "greeter",
            purpose: "Greet whoever is named.",
            agent: { model: "test/m", candidates: ["test/m"], system: "You greet people." },
            events: {
              "greet.requested": { requestId: "nonEmptyString", name: "string" },
              "greet.ready": { requestId: "string", greeting: "string" },
            },
            job: {
              id: "greet",
              description: "Greet the name.",
              input: "greet.requested",
              triggers: ["manual"],
              prompt: "Greet {{name}}",
              answer: { greeting: "string" },
              output: "greet.ready",
            },
          }),
        );
        const models = ModelRunner.of({
          generate: (request) =>
            Effect.succeed({
              text: JSON.stringify({ answer: { greeting: "hello" } }),
              model: request.model,
              provider: "test",
              seconds: 0,
              cost: 0.0012,
              tokens: { input: 120, output: 30, cachedInput: 8 },
            }),
        });
        const result = yield* Effect.flatMap(Runner, (runner) =>
          runner.run("greeter", "greet", { requestId: "req-1", name: "Ada" }),
        ).pipe(
          Effect.provide(Tracing.layer()),
          Effect.provide(runtime(root, { dirs: [`${root}/agents`] }, models)),
        );
        expect(result.ok).toBe(true);
        const [trace] = yield* Traces.query(root, { run: "req-1", since: 0, limit: 1 });
        const item = trace!.root.children[1]!.children[0]!;
        expect(item.name).toBe("agent.item");
        expect(item.children[0]).toMatchObject({
          name: "model.call",
          attributes: {
            "agent.id": "greeter",
            "model.harness": "omp",
            "model.id": "test/m",
            "model.provider": "test",
            "tokens.input": 120,
            "tokens.output": 30,
            "tokens.cached": 8,
            "cost.usd": 0.0012,
          },
        });
        expect(Traces.render(trace!)).toContain(
          "model.call omp test/m in 120 out 30 cached 8 $0.0012",
        );
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.runPromise),
    20_000,
  );
});

describe("trace retention", () => {
  const now = Date.parse("2026-11-18T10:30:00Z");
  const MB = 1024 * 1024;
  const files = [
    { name: "2026-11-10T09.jsonl", bytes: 1 * MB },
    { name: "2026-11-17T10.jsonl", bytes: 1 * MB },
    { name: "2026-11-18T08.jsonl", bytes: 1 * MB },
    { name: "2026-11-18T10.jsonl", bytes: 5 * MB },
    { name: "notes.txt", bytes: 50 * MB },
  ];

  test("drops hours past the age limit, then the oldest until the rest fit; never the current hour or other files", () => {
    const limits = { maxAgeHours: 7 * 24, maxBytes: 6 * MB, maxHourBytes: 2 * MB };
    expect(Traces.expired(files, now, limits)).toEqual([
      "2026-11-10T09.jsonl",
      "2026-11-17T10.jsonl",
    ]);
    // The current hour alone over budget: everything else goes, it stays (the hour cap bounds it instead).
    expect(Traces.expired(files, now, { ...limits, maxBytes: 4 * MB })).toEqual([
      "2026-11-10T09.jsonl",
      "2026-11-17T10.jsonl",
      "2026-11-18T08.jsonl",
    ]);
    // An hour that ended exactly maxAgeHours ago goes; the one after it stays.
    expect(
      Traces.expired(
        [
          { name: "2026-11-11T09.jsonl", bytes: 1 },
          { name: "2026-11-11T10.jsonl", bytes: 1 },
        ],
        Date.parse("2026-11-18T10:00:00Z"),
        limits,
      ),
    ).toEqual(["2026-11-11T09.jsonl"]);
  });

  test("prune deletes the expired files in the trace dir and leaves the rest", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "atomic-traces-" });
      for (const file of files)
        yield* fs.writeFileString(`${dir}/${file.name}`, "x".repeat(file.bytes / 1024));
      const gone = yield* Traces.prune(dir, now, {
        maxAgeHours: 7 * 24,
        maxBytes: 6 * 1024,
        maxHourBytes: 2 * 1024,
      });
      expect(gone).toEqual(["2026-11-10T09.jsonl", "2026-11-17T10.jsonl"]);
      expect((yield* fs.readDirectory(dir)).sort()).toEqual([
        "2026-11-18T08.jsonl",
        "2026-11-18T10.jsonl",
        "notes.txt",
      ]);
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.runPromise));
});
