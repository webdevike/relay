import { describe, expect, test } from "bun:test";
import { Effect, FileSystem, Layer, Option, Ref, Schedule, Schema } from "effect";
import { publishRequest } from "../src/core/Ask.ts";
import { Background } from "../src/core/Background.ts";
import { ModelCatalog } from "../src/core/Catalog.ts";
import { define, job, type Registered, Trigger } from "../src/core/Component.ts";
import { type AgentEvent, EventBus, makeEvent } from "../src/core/Event.ts";
import { Runner } from "../src/core/Runtime.ts";
import { Settings } from "../src/core/Settings.ts";
import {
  type CatalogModel,
  clearWinner,
  family,
  modelLabel,
  previewOf,
  relevantModels,
  trialEvents,
} from "../src/core/Trial.ts";
import { benchFile, checkCatalog, freshModels, layerTrials } from "../src/core/TrialService.ts";
import { runtime, tempHome } from "./harness.ts";

const SONNET = "anthropic/claude-sonnet-5-5";
const OPUS = "anthropic/claude-opus-5-5";
const SOL = "openai-codex/gpt-6-sol";

const contract = {
  id: "taster" as const,
  events: {
    "taste.requested": Schema.Struct({
      requestId: Schema.optionalKey(Schema.String),
      brief: Schema.String,
    }),
    "taste.done": Schema.Struct({
      requestId: Schema.optionalKey(Schema.String),
      text: Schema.String,
      model: Schema.String,
      cost: Schema.Number,
    }),
  },
};

/** How long each model takes: the default answers first, the slowest arm last. */
const DELAY: Record<string, number> = { [SONNET]: 100, [SOL]: 700, [OPUS]: 1400 };

const taster = (trial: boolean): Registered =>
  define({
    ...contract,
    purpose: "Test taste agent.",
    agent: { model: SONNET, candidates: [SONNET, SOL, OPUS], system: "", trial },
    jobs: [
      job(contract.events, {
        id: "taste",
        description: "Answer the brief after the model's delay.",
        input: contract.events["taste.requested"],
        triggers: [Trigger.OnEvent({ type: "taster/taste.requested" }), Trigger.Manual()],
        run: (input, ctx) =>
          Effect.sleep(`${DELAY[ctx.model] ?? 50} millis`).pipe(
            Effect.andThen(
              ctx.emit("taste.done", {
                ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
                text: `answer ${DELAY[ctx.model]}`,
                model: ctx.model,
                cost: 0.01,
              }),
            ),
          ),
      }),
    ],
    tools: Layer.empty,
    asks: { request: "taste.requested", reply: "taste.done", show: () => "none" },
  });

/** Retry `check` until it answers Some, for up to 15 s. */
const eventually = <A, E>(check: Effect.Effect<Option.Option<A>, E>) =>
  check.pipe(
    Effect.flatMap((found) =>
      Option.isSome(found) ? Effect.succeed(found.value) : Effect.fail("not yet" as const),
    ),
    Effect.retry(Schedule.spaced("50 millis")),
    Effect.timeout("15 seconds"),
  );

const ofType = (events: ReadonlyArray<AgentEvent>, type: string) =>
  events.filter((event) => event.type === type);

/** The providers' lists (`list`, after a refresh) and omp's cache before it (`cached`, default the same). */
const stubCatalog = (
  lists: Ref.Ref<ReadonlyArray<CatalogModel>>,
  cached: Ref.Ref<ReadonlyArray<CatalogModel>> = lists,
) =>
  Layer.succeed(ModelCatalog, ModelCatalog.of({ cached: Ref.get(cached), list: Ref.get(lists) }));

const cat = (selector: string, name: string): CatalogModel => ({
  selector,
  name,
  provider: selector.split("/")[0]!,
});

describe("trial rules", () => {
  test("8 of the last 10, else a clear lead from 15 picks; can't tell is nobody's win", () => {
    const picks = (winners: ReadonlyArray<string | null>) =>
      winners.map((winner, at) => ({ at, winner }));
    expect(clearWinner(picks(["a", "a", "a", "a", "a", "a", "a", null, "b", "c"]))).toBeUndefined();
    expect(clearWinner(picks(["a", "a", "a", "a", "a", "a", "a", "a", "b", "c"]))).toEqual({
      winner: "a",
      wins: 8,
      of: 10,
      rule: "window",
    });
    // 9 to 5 at 15 picks: short of twice the runner-up, so not clear yet.
    expect(clearWinner(picks([..."abababababacaaa"]))).toBeUndefined();
  });

  test("labels Isaac reads, with no vendor", () => {
    expect(modelLabel(SONNET, "Claude Sonnet 5.5")).toBe("Sonnet 5.5");
    expect(modelLabel("openai-codex/gpt-6.1-sol", "GPT-6.1-Sol")).toBe("GPT-6.1 Sol");
    expect(modelLabel(OPUS)).toBe("Opus 5.5");
    expect(modelLabel("openai-codex/gpt-6.2-sol")).toBe("GPT-6.2 Sol");
    expect(modelLabel("openrouter/moonshotai/kimi-k3.1-pro")).toBe("Kimi K3.1 Pro");
  });

  test("a new release of an agent's own model line is tried first; other providers never", () => {
    expect(family("openai-codex/gpt-6.2-sol")).toBe(family(SOL));
    expect(
      relevantModels(
        [SONNET, SOL, OPUS],
        [
          "openai-codex/gpt-6.2-astra",
          "openai-codex/gpt-6.2-sol",
          "openai-codex/gpt-6.2-luna",
          "xai/grok-5",
        ],
      ),
    ).toEqual([
      "openai-codex/gpt-6.2-sol",
      "openai-codex/gpt-6.2-astra",
      "openai-codex/gpt-6.2-luna",
    ]);
    expect(
      freshModels(
        [cat(SONNET, "Claude Sonnet 5.5")],
        [
          cat(SONNET, "Claude Sonnet 5.5"),
          cat(`${SONNET}-20261117`, "Claude Sonnet 5.5"),
          cat("openai-codex/gpt-6.2-sol", "GPT-6.2-Sol"),
        ],
      ).map((model) => model.selector),
    ).toEqual(["openai-codex/gpt-6.2-sol"]);
  });

  test("the card preview shows the result and never the model", () => {
    const preview = previewOf({
      image: "/runs/diagram/r1/diagram.png",
      summary: "Three boxes in a loop.",
      model: SONNET,
      cost: 0.02,
    });
    expect(preview).toBe("![](</runs/diagram/r1/diagram.png>)\n\nThree boxes in a loop.");
    expect(
      previewOf({
        score: 7,
        findings: [{ rule: "contrast", fix: "darken the label" }],
        model: OPUS,
      }),
    ).toBe("**7/10**\n\n- contrast: darken the label");
  });
});

describe("a trial request", () => {
  test(
    "runs every model at once, answers the caller from its own model first, and streams each result as it ends",
    () =>
      Effect.gen(function* () {
        const root = yield* tempHome;
        yield* Effect.gen(function* () {
          const bus = yield* EventBus;
          const requestId = yield* publishRequest(
            taster(true),
            { request: "taste.requested", reply: "taste.done" },
            { brief: "a calm logo" },
            "agent:nova",
          );
          const results = yield* eventually(
            Effect.map(bus.history, (events) => {
              const found = ofType(events, "taster/trial.result");
              return found.length === 3 ? Option.some(found) : Option.none();
            }),
          );
          const events = yield* bus.history;
          const [started] = ofType(events, "taster/trial.started");
          const plan = Schema.decodeUnknownSync(trialEvents["trial.started"])(started!.data);
          expect(plan).toMatchObject({
            requestId,
            caller: "agent:nova",
            job: "taste",
            request: "a calm logo",
          });
          expect(started!.caller).toBe("agent:nova");
          expect(plan.arms.map((arm) => arm.letter)).toEqual(["A", "B", "C"]);
          expect(plan.arms.filter((arm) => arm.default).map((arm) => arm.model)).toEqual([SONNET]);
          expect(new Set(plan.arms.map((arm) => arm.model))).toEqual(new Set([SONNET, SOL, OPUS]));

          // The caller's answer is its own model's, once, and lands before the slower arms finish.
          const replies = ofType(events, "taster/taste.done");
          expect(replies.map((event) => event.data)).toEqual([
            { requestId, text: "answer 100", model: SONNET, cost: 0.01 },
          ]);
          const decoded = results.map((event) =>
            Schema.decodeUnknownSync(trialEvents["trial.result"])(event.data),
          );
          expect(decoded.map((result) => result.model)).toEqual([SONNET, SOL, OPUS]);
          expect(decoded.map((result) => result.preview)).toEqual([
            "answer 100",
            "answer 700",
            "answer 1400",
          ]);
          expect(decoded.every((result) => result.ok && result.cost === 0.01)).toBe(true);
          expect(Date.parse(replies[0]!.at)).toBeLessThan(Date.parse(results[1]!.at));
          // In parallel: the slowest arm ends about 1.4 s in, not 2.2 s.
          expect(Date.parse(results[2]!.at) - Date.parse(started!.at)).toBeLessThan(2000);

          // Each arm's run is tagged with its letter; only the default carries the caller's request.
          const starts = events.filter((event) => event.type === "taster/job.started");
          const letterOf = (model: string) => plan.arms.find((arm) => arm.model === model)!.letter;
          for (const event of starts) {
            const data = event.data as {
              model: string;
              requestId?: string;
              trial: { id: string; letter: string };
            };
            expect(data.trial).toEqual({ id: plan.trialId, letter: letterOf(data.model) });
            expect(data.requestId === requestId).toBe(data.model === SONNET);
          }
        }).pipe(
          Effect.provide(
            Runner.layerTriggers.pipe(
              Layer.provideMerge(Background.layer),
              Layer.provideMerge(runtime(root, { code: [taster(true)] })),
            ),
          ),
        );
      }).pipe(Effect.scoped, Effect.runPromise),
    20_000,
  );

  test(
    "with the trial off, or with no caller to show a card to, a request runs once",
    () =>
      Effect.gen(function* () {
        const root = yield* tempHome;
        yield* Effect.gen(function* () {
          const bus = yield* EventBus;
          yield* publishRequest(
            taster(true),
            { request: "taste.requested", reply: "taste.done" },
            { brief: "x" },
          );
          yield* (yield* Settings).set({ components: { taster: { trial: false } } }, "test", "set");
          yield* publishRequest(
            taster(true),
            { request: "taste.requested", reply: "taste.done" },
            { brief: "y" },
            "agent:nova",
          );
          yield* eventually(
            Effect.map(bus.history, (events) =>
              ofType(events, "taster/job.succeeded").length === 2
                ? Option.some(true)
                : Option.none(),
            ),
          );
          yield* Effect.sleep("1500 millis");
          const events = yield* bus.history;
          expect(ofType(events, "taster/trial.started")).toEqual([]);
          expect(ofType(events, "taster/job.started")).toHaveLength(2);
        }).pipe(
          Effect.provide(
            Runner.layerTriggers.pipe(
              Layer.provideMerge(Background.layer),
              Layer.provideMerge(runtime(root, { code: [taster(true)] })),
            ),
          ),
        );
      }).pipe(Effect.scoped, Effect.runPromise),
    20_000,
  );
});

/** A finished trial in the journal: `trial.started` (A sonnet default, B sol, C opus) and three results. */
const seedTrial = (trialId: string) =>
  Effect.gen(function* () {
    const bus = yield* EventBus;
    const put = (name: "trial.started" | "trial.result", data: unknown) =>
      Effect.flatMap(
        makeEvent({
          type: `taster/${name}`,
          component: "taster",
          job: "taste",
          run: `trial-${trialId}`,
          caller: "agent:nova",
          data,
        }),
        bus.publish,
      );
    yield* put("trial.started", {
      trialId,
      caller: "agent:nova",
      job: "taste",
      request: "a brief",
      arms: [
        { letter: "A", model: SONNET, label: "Sonnet 5.5", default: true },
        { letter: "B", model: SOL, label: "GPT-6 Sol", default: false },
        { letter: "C", model: OPUS, label: "Opus 5.5", default: false },
      ],
    });
    for (const [letter, model] of [
      ["A", SONNET],
      ["B", SOL],
      ["C", OPUS],
    ] as const)
      yield* put("trial.result", {
        trialId,
        letter,
        model,
        ok: true,
        preview: "x",
        seconds: 1,
        cost: 0.01,
      });
  });

/** Relay Host's pick (or undo) line. */
const hostWrites = (type: string, component: string, data: unknown) =>
  Effect.gen(function* () {
    const bus = yield* EventBus;
    yield* bus.publish(yield* makeEvent({ type, component, job: "trial", run: "pick-test", data }));
  });

describe("the trial service", () => {
  test(
    "saves every pick on the bench, switches on 8 of 10 with its own message, and Undo brings the old model and the trial back",
    () =>
      Effect.gen(function* () {
        const root = yield* tempHome;
        const lists = yield* Ref.make<ReadonlyArray<CatalogModel>>([
          cat(SONNET, "Claude Sonnet 5.5"),
        ]);
        yield* Effect.gen(function* () {
          const bus = yield* EventBus;
          const settings = yield* Settings;
          const fs = yield* FileSystem.FileSystem;
          const picks = ["B", "B", "A", "B", "unsure", "B", "B", "B", "B", "B"];
          for (const [index, pick] of picks.entries()) {
            yield* seedTrial(`t${index}`);
            yield* hostWrites("taster/trial.picked", "taster", {
              trialId: `t${index}`,
              pick,
              surface: "phone",
              by: "isaac",
            });
          }
          const switched = yield* eventually(
            Effect.map(bus.history, (events) =>
              Option.fromUndefinedOr(ofType(events, "taster/trial.switched")[0]),
            ),
          );
          const data = Schema.decodeUnknownSync(trialEvents["trial.switched"])(switched.data);
          expect(data).toMatchObject({
            trialId: "t9",
            from: SONNET,
            to: SOL,
            kept: false,
            wins: 8,
            of: 10,
            over: [SONNET, OPUS],
            text: "Taster: switched to GPT-6 Sol, won 8 of your last 10 picks over Sonnet 5.5 and Opus 5.5",
            undo: { components: { taster: { model: null, trial: null } } },
          });
          expect((yield* settings.current).components?.["taster"]).toEqual({
            model: SOL,
            trial: false,
          });

          const bench = (yield* fs.readFileString(benchFile(root, "taster")))
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line));
          expect(bench).toHaveLength(10);
          expect(bench[4]).toMatchObject({
            trialId: "t4",
            pick: "unsure",
            winner: null,
            surface: "phone",
          });
          expect(bench[0]).toMatchObject({
            pick: "B",
            winner: SOL,
            arms: [
              { letter: "A", model: SONNET, ok: true, cost: 0.01 },
              { letter: "B", model: SOL },
              { letter: "C", model: OPUS },
            ],
          });

          // Undo, as Relay Host does it: trial.undone plus config.set with the switch's patch.
          yield* hostWrites("taster/trial.undone", "taster", { switchId: data.switchId });
          yield* hostWrites("atomic-agents/config.set", "atomic-agents", {
            by: "isaac",
            patch: data.undo,
          });
          yield* eventually(
            Effect.map(settings.current, (current) =>
              current.components?.["taster"] === undefined ||
              Object.keys(current.components["taster"]).length === 0
                ? Option.some(true)
                : Option.none(),
            ),
          );
          // The count starts over: one more B is not a switch.
          yield* seedTrial("t10");
          yield* hostWrites("taster/trial.picked", "taster", { trialId: "t10", pick: "B" });
          yield* eventually(
            Effect.map(fs.readFileString(benchFile(root, "taster")), (text) =>
              text.trim().split("\n").length === 11 ? Option.some(true) : Option.none(),
            ),
          );
          yield* Effect.sleep("500 millis");
          expect(ofType(yield* bus.history, "taster/trial.switched")).toHaveLength(1);
        }).pipe(
          Effect.provide(
            Layer.mergeAll(Settings.layerWatch, layerTrials({ catalogEvery: "1 hour" })).pipe(
              Layer.provideMerge(Background.layer),
              Layer.provideMerge(stubCatalog(lists)),
              Layer.provideMerge(runtime(root, { code: [taster(true)] })),
            ),
          ),
        );
      }).pipe(Effect.scoped, Effect.runPromise),
    30_000,
  );

  test(
    "a model new in the provider catalog starts a fresh trial against the agent's model, with no ids in the code",
    () =>
      Effect.gen(function* () {
        const root = yield* tempHome;
        const lists = yield* Ref.make<ReadonlyArray<CatalogModel>>([
          cat(SONNET, "Claude Sonnet 5.5"),
          cat(OPUS, "Claude Opus 5.5"),
          cat(SOL, "GPT-6-Sol"),
        ]);
        yield* Effect.gen(function* () {
          const bus = yield* EventBus;
          const settings = yield* Settings;
          yield* settings.set({ components: { taster: { trial: false } } }, "test", "set");
          // The first read only remembers the catalog.
          expect(yield* checkCatalog).toEqual([]);
          expect(yield* checkCatalog).toEqual([]);
          yield* Ref.update(lists, (models) => [
            ...models,
            cat(`${SONNET}-20261117`, "Claude Sonnet 5.5"),
            cat("openai-codex/gpt-6.2-astra", "GPT-6.2-Astra"),
            cat("openai-codex/gpt-6.2-sol", "GPT-6.2-Sol"),
            cat("openai-codex/gpt-6.2-luna", "GPT-6.2-Luna"),
          ]);
          expect(yield* checkCatalog).toEqual([
            {
              agent: "taster",
              models: [
                "openai-codex/gpt-6.2-sol",
                "openai-codex/gpt-6.2-astra",
                "openai-codex/gpt-6.2-luna",
              ],
              arms: [SONNET, "openai-codex/gpt-6.2-sol", "openai-codex/gpt-6.2-astra"],
            },
          ]);
          expect((yield* settings.current).components?.["taster"]).toEqual({
            trial: true,
            trialModels: [SONNET, "openai-codex/gpt-6.2-sol", "openai-codex/gpt-6.2-astra"],
          });
          expect(ofType(yield* bus.history, "taster/trial.retrial")).toHaveLength(1);
          // Seen once, never again.
          expect(yield* checkCatalog).toEqual([]);
        }).pipe(
          Effect.provide(
            Layer.mergeAll(stubCatalog(lists), runtime(root, { code: [taster(true)] })),
          ),
        );
      }).pipe(Effect.scoped, Effect.runPromise),
    20_000,
  );

  test(
    "on the very first read, a model the providers list but omp's cache did not (GPT-6.2 today) already starts a trial",
    () =>
      Effect.gen(function* () {
        const root = yield* tempHome;
        const old = [
          cat(SONNET, "Claude Sonnet 5.5"),
          cat(OPUS, "Claude Opus 5.5"),
          cat(SOL, "GPT-6-Sol"),
        ];
        const cached = yield* Ref.make<ReadonlyArray<CatalogModel>>(old);
        const lists = yield* Ref.make<ReadonlyArray<CatalogModel>>([
          ...old,
          cat("openai-codex/gpt-6.2-sol", "GPT-6.2-Sol"),
        ]);
        const started = yield* checkCatalog.pipe(
          Effect.provide(
            Layer.mergeAll(stubCatalog(lists, cached), runtime(root, { code: [taster(true)] })),
          ),
        );
        expect(started).toEqual([
          {
            agent: "taster",
            models: ["openai-codex/gpt-6.2-sol"],
            arms: [SONNET, "openai-codex/gpt-6.2-sol", SOL],
          },
        ]);
      }).pipe(Effect.scoped, Effect.runPromise),
    20_000,
  );
});
