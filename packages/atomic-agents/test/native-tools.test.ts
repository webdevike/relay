import { describe, expect, test } from "bun:test";
import { Deferred, Effect, Exit, FileSystem, Layer, Ref, Schema } from "effect";
import { BunServices } from "@effect/platform-bun";
import {
  type GenerateRequest,
  generateWithTools,
  ModelError,
  ModelRunner,
  tool,
  ToolLoopError,
} from "../src/core/Model.ts";
import { oneProcess, tempHome } from "./harness.ts";

/** `omp --mode rpc` played by a script: the runner under test is omp's own, only the model is scripted. */
const FAKE_OMP = new URL("./fixtures/fake-omp.ts", import.meta.url).pathname;

interface Frame {
  readonly type?: string;
  readonly argv?: ReadonlyArray<string>;
  readonly tools?: ReadonlyArray<{
    readonly name: string;
    readonly parameters: { readonly properties?: Record<string, { readonly type?: string }> };
  }>;
  readonly result?: { readonly content: ReadonlyArray<{ readonly text?: string }> };
}

/** `generateWithTools` over omp's runner with the fake playing `turns`, `read_thread` as the one tool; its runs and the frames omp got. */
const play = (
  turns: ReadonlyArray<unknown>,
  options: {
    readonly maxSteps?: number;
    readonly request?: Partial<GenerateRequest>;
    readonly run?: (id: string) => Effect.Effect<unknown>;
  } = {},
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const root = yield* tempHome;
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(`${root}/scenario.json`, JSON.stringify(turns));
      yield* fs.writeFileString(`${root}/frames.ndjson`, "");
      process.env["FAKE_OMP_SCENARIO"] = `${root}/scenario.json`;
      process.env["FAKE_OMP_LOG"] = `${root}/frames.ndjson`;
      const runs = yield* Ref.make<ReadonlyArray<string>>([]);
      const exit = yield* generateWithTools(
        {
          model: "anthropic/test",
          system: "Triage the message.",
          prompt: "classify m1 and m2",
          ...options.request,
        },
        {
          tools: [
            tool({
              name: "read_thread",
              description: "The thread of a message.",
              args: Schema.Struct({ id: Schema.String }),
              example: `{"id": "<id>"}`,
              run: ({ id }: { readonly id: string }) =>
                Ref.update(runs, (all) => [...all, id]).pipe(
                  Effect.andThen(options.run?.(id) ?? Effect.succeed({ thread: id })),
                ),
            }),
          ],
          answer: Schema.Struct({ verdict: Schema.String }),
          answerExample: `{"verdict": "..."}`,
          maxSteps: options.maxSteps ?? 4,
        },
      ).pipe(
        Effect.provide(ModelRunner.ompAt(FAKE_OMP).pipe(Layer.provide(oneProcess(root)))),
        Effect.exit,
      );
      const frames = (yield* fs.readFileString(`${root}/frames.ndjson`))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Frame);
      return { exit, runs: yield* Ref.get(runs), frames };
    }),
  ).pipe(Effect.provide(BunServices.layer));

const failure = <A, E>(exit: Exit.Exit<A, E>) => {
  if (Exit.isSuccess(exit))
    throw new Error(`expected a failure, got ${JSON.stringify(exit.value)}`);
  const error = exit.cause.reasons.find((reason) => reason._tag === "Fail");
  if (error === undefined) throw new Error(`expected a typed failure, got ${String(exit.cause)}`);
  return error.error;
};

describe("native tool sessions (omp --mode rpc)", () => {
  test("a model that once wrote its own tool results gets real tool calls: both run at once in this process and their results reach the answer", () =>
    Effect.gen(function* () {
      // Each read waits for the other to start: run one after the other, they would both time out.
      const bothStarted = yield* Deferred.make<void>();
      const started = yield* Ref.make(0);
      const { exit, runs, frames } = yield* play(
        [
          {
            text: `{"tool": "read_thread", "args": {"id": "m1"}}\nresult: {"thread": "invented"}`,
            toolCalls: [
              { name: "read_thread", args: { id: "m1" } },
              { name: "read_thread", args: { id: "m2" } },
            ],
          },
          { toolCalls: [{ name: "answer", args: { verdict: "$RESULTS" } }] },
        ],
        {
          run: (id) =>
            Ref.updateAndGet(started, (count) => count + 1).pipe(
              Effect.tap((count) =>
                count === 2 ? Deferred.succeed(bothStarted, undefined) : Effect.void,
              ),
              Effect.andThen(Deferred.await(bothStarted).pipe(Effect.timeout("3 seconds"))),
              Effect.as({ thread: id }),
              Effect.orElseSucceed(() => ({ thread: id, ranAlone: true })),
            ),
        },
      );
      if (!Exit.isSuccess(exit)) throw new Error(String(exit.cause));
      expect(exit.value.answer).toEqual({ verdict: `{"thread":"m1"} | {"thread":"m2"}` });
      expect(runs).toEqual(["m1", "m2"]);
      expect(exit.value.steps).toBe(2);
      expect(exit.value.calls).toEqual([
        { tool: "read_thread", allowed: true },
        { tool: "read_thread", allowed: true },
      ]);
      expect(exit.value.cost).toBeCloseTo(0.002);
      expect(exit.value.tokens).toEqual({ input: 22, output: 10, cachedInput: 4 });
      expect(frames[0]!.argv).toContain("rpc");
      const offered = frames.find((frame) => frame.type === "set_host_tools")!.tools!;
      expect(offered.map((candidate) => candidate.name)).toEqual(["read_thread", "answer"]);
      expect(offered[0]!.parameters.properties?.["id"]?.type).toBe("string");
      expect(offered[1]!.parameters.properties?.["verdict"]?.type).toBe("string");
    }).pipe(Effect.runPromise));

  test("a reply with no tool call and no valid answer (a transcript the model made up) fails at once with ToolLoopError, no tool run", () =>
    Effect.gen(function* () {
      const { exit, runs } = yield* play([
        {
          text: `{"tool": "read_thread", "args": {"id": "m1"}}\nresult: {"messages": 3}\n{"answer": {"verdict": 7}}`,
        },
      ]);
      const error = failure(exit);
      if (!(error instanceof ToolLoopError))
        throw new Error(`expected ToolLoopError, got ${JSON.stringify(error)}`);
      expect(error.message).toContain("model call 1 ended with no tool call and no answer");
      expect(error.steps).toBe(1);
      expect(runs).toEqual([]);
    }).pipe(Effect.runPromise));

  test("a final reply written as the answer object instead of an answer call is the answer", () =>
    Effect.gen(function* () {
      const { exit } = yield* play([{ text: 'Done: ```json\n{"verdict": "fyi"}\n```' }]);
      if (!Exit.isSuccess(exit)) throw new Error(String(exit.cause));
      expect(exit.value.answer).toEqual({ verdict: "fyi" });
    }).pipe(Effect.runPromise));

  test("a model call streaming past the output cap is stopped with ToolLoopError", () =>
    Effect.gen(function* () {
      const { exit } = yield* play([{ stream: 70_000 }]);
      const error = failure(exit);
      if (!(error instanceof ToolLoopError))
        throw new Error(`expected ToolLoopError, got ${JSON.stringify(error)}`);
      expect(error.message).toContain("output cap");
    }).pipe(Effect.runPromise));

  test("a model call that never ends fails with ModelError after the per-call timeout", () =>
    Effect.gen(function* () {
      const { exit } = yield* play([{ stall: true }], { request: { timeout: "1 second" } });
      const error = failure(exit);
      if (!(error instanceof ModelError))
        throw new Error(`expected ModelError, got ${JSON.stringify(error)}`);
      expect(error.message).toBe("model call 1 timed out after 1 s");
    }).pipe(Effect.runPromise));

  test("the second-to-last call's results say the next call is the last; a last call without an answer ends the session", () =>
    Effect.gen(function* () {
      const { exit, runs, frames } = yield* play(
        [
          { toolCalls: [{ name: "read_thread", args: { id: "m1" } }] },
          { toolCalls: [{ name: "read_thread", args: { id: "m2" } }] },
        ],
        { maxSteps: 2 },
      );
      const error = failure(exit);
      if (!(error instanceof ToolLoopError))
        throw new Error(`expected ToolLoopError, got ${JSON.stringify(error)}`);
      expect(error.message).toBe("no answer in 2 model calls");
      expect(runs).toEqual(["m1"]);
      const results = frames.filter((frame) => frame.type === "host_tool_result");
      expect(results[0]!.result!.content[0]!.text).toContain("Your next model call is your last");
    }).pipe(Effect.runPromise));
});
