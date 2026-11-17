import { Effect, FiberSet, FileSystem, Layer, Option, Schedule, Schema, Stream } from "effect";
import { type Actor, createActor, fromPromise } from "xstate";
import { Background } from "./Background.ts";
import { Agents } from "./Agent.ts";
import { ModelCatalog } from "./Catalog.ts";
import type { Registered } from "./Component.ts";
import { type AgentEvent, EventBus, Home, JournalError, makeEvent } from "./Event.ts";
import { shortId, uuid } from "./Id.ts";
import type { SettingsFile } from "./RuntimeEvents.ts";
import { effective, Settings, undoPatch } from "./Settings.ts";
import {
  armsKey,
  type CatalogModel,
  type CountedPick,
  decodeCatalog,
  modelLabel,
  relevantModels,
  switchText,
  type TrialEvent,
  trialEvents,
  type TrialStarted,
} from "./Trial.ts";
import { type SwitchInput, trialMachine } from "./trial.machine.ts";

/**
 * The service side of trial mode (`Trial.ts`): every pick Isaac makes on a card goes on the agent's bench
 * (`<home>/bench/<agent>/trials.jsonl`) and into the agent's trial machine (`trial.machine.ts`), which switches the
 * agent's model in config.json on its own once one model clearly wins (`trial.switched`, with the undo patch Relay
 * sends back on Undo). It also watches the provider catalog: a new chat model starts a fresh trial of it against the
 * agent's current model for every taste agent (`trial: true` in its file) whose providers offer it.
 */

const decodeStarted = Schema.decodeUnknownOption(trialEvents["trial.started"]);
const decodeResult = Schema.decodeUnknownOption(trialEvents["trial.result"]);
const decodePicked = Schema.decodeUnknownOption(trialEvents["trial.picked"]);
const decodeUndone = Schema.decodeUnknownOption(trialEvents["trial.undone"]);

/** One bench line per pick. */
export const BenchLine = Schema.Struct({
  at: Schema.String,
  agent: Schema.String,
  trialId: Schema.String,
  requestId: Schema.optionalKey(Schema.String),
  caller: Schema.optionalKey(Schema.String),
  request: Schema.String,
  /** `armsKey` of the trial's models: picks count toward the trial in force only while it has the same models. */
  armsKey: Schema.String,
  arms: Schema.Array(
    Schema.Struct({
      letter: Schema.String,
      model: Schema.String,
      label: Schema.String,
      default: Schema.Boolean,
      ok: Schema.optionalKey(Schema.Boolean),
      seconds: Schema.optionalKey(Schema.Number),
      cost: Schema.optionalKey(Schema.Number),
      error: Schema.optionalKey(Schema.String),
    }),
  ),
  /** A letter, or `unsure` ("can't tell"). */
  pick: Schema.String,
  /** The model behind the picked letter; null for "can't tell". */
  winner: Schema.NullOr(Schema.String),
  surface: Schema.optionalKey(Schema.String),
});
export type BenchLine = typeof BenchLine.Type;
const decodeBenchLine = Schema.decodeUnknownOption(Schema.fromJsonString(BenchLine));

/** Where an agent's trial picks are kept. */
export const benchFile = (root: string, agent: string) => `${root}/bench/${agent}/trials.jsonl`;
const catalogFile = (home: Home["Service"]) => `${home.stateDir("trials")}/catalog.json`;

/** The bench line for Isaac's `pick` on trial `started`, with each arm's result. */
export const benchLine = (
  agent: string,
  started: TrialStarted,
  results: ReadonlyArray<(typeof trialEvents)["trial.result"]["Type"]>,
  pick: { readonly pick: string; readonly at: string; readonly surface?: string },
): BenchLine => ({
  at: pick.at,
  agent,
  trialId: started.trialId,
  ...(started.requestId === undefined ? {} : { requestId: started.requestId }),
  ...(started.caller === undefined ? {} : { caller: started.caller }),
  request: started.request,
  armsKey: armsKey(started.arms.map((arm) => arm.model)),
  arms: started.arms.map((arm) => {
    const result = results.find((candidate) => candidate.letter === arm.letter);
    return {
      ...arm,
      ...(result === undefined
        ? {}
        : {
            ok: result.ok,
            seconds: result.seconds,
            ...(result.cost === undefined ? {} : { cost: result.cost }),
            ...(result.error === undefined ? {} : { error: result.error }),
          }),
    };
  }),
  pick: pick.pick,
  winner: started.arms.find((arm) => arm.letter === pick.pick)?.model ?? null,
  ...(pick.surface === undefined ? {} : { surface: pick.surface }),
});

/** Models in `now` the last catalog (`before`) did not have: a new id under a new name (a dated alias of a known model is not new). */
export const freshModels = (
  before: ReadonlyArray<CatalogModel>,
  now: ReadonlyArray<CatalogModel>,
): CatalogModel[] => {
  const ids = new Set(before.map((model) => model.selector));
  const names = new Set(before.map((model) => model.name));
  return now.filter((model) => !ids.has(model.selector) && !names.has(model.name));
};

/**
 * The models of a fresh trial for `fresh` (new in the catalog): the agent's model, then up to two of them it should
 * try (`relevantModels`), then its earlier trial models to fill three. None when no new model fits the agent.
 */
export const retrialArms = (
  current: {
    readonly model: string;
    readonly arms: ReadonlyArray<string>;
    readonly candidates: ReadonlyArray<string>;
  },
  fresh: ReadonlyArray<string>,
): { readonly models: string[]; readonly arms: string[] } | undefined => {
  const known = [...new Set([current.model, ...current.arms, ...current.candidates])];
  const models = relevantModels(known, fresh);
  if (models.length === 0) return undefined;
  const arms = [
    ...new Set([current.model, ...models.slice(0, 2), ...current.arms, ...current.candidates]),
  ].slice(0, 3);
  return { models, arms };
};

const publishTrial = <K extends TrialEvent>(
  bus: EventBus["Service"],
  agent: string,
  name: K,
  data: (typeof trialEvents)[K]["Type"],
) =>
  Schema.encodeUnknownEffect(trialEvents[name])(data).pipe(
    Effect.mapError((cause) => new JournalError({ message: `encode ${agent}/${name}`, cause })),
    Effect.flatMap((encoded) =>
      Effect.flatMap(shortId, (id) =>
        makeEvent({
          type: `${agent}/${name}`,
          component: agent,
          job: "trial",
          run: `trial-${id}`,
          data: encoded,
        }),
      ),
    ),
    Effect.flatMap(bus.publish),
  );

const readCatalog = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const file = catalogFile(yield* Home);
  return yield* fs.readFileString(file).pipe(
    Effect.map((text) => Option.getOrUndefined(decodeCatalog(text))),
    Effect.orElseSucceed(() => undefined),
  );
});

/** The labels Isaac reads (`Sonnet 5.5`), from the catalog's names when it lists the model. */
const labeller = Effect.map(readCatalog, (file) => {
  const names = new Map(file?.models.map((model) => [model.selector, model.name]) ?? []);
  return (model: string) => modelLabel(model, names.get(model));
});

/**
 * Read the provider catalog once (refreshed from the providers): remember it, and start a fresh trial for every taste
 * agent a model new since the last read fits (config.json `trial: true` + `trialModels`, then `trial.retrial`). With no
 * earlier read, omp's cached list (before the refresh) is the baseline, so a model the refresh brings in on the very
 * first read is already new. Answers the trials it started.
 */
export const checkCatalog = Effect.gen(function* () {
  const catalog = yield* ModelCatalog;
  const settings = yield* Settings;
  const bus = yield* EventBus;
  const fs = yield* FileSystem.FileSystem;
  const home = yield* Home;
  const before = (yield* readCatalog)?.models ?? (yield* catalog.cached);
  const now = yield* catalog.list;
  yield* fs.makeDirectory(home.stateDir("trials"), { recursive: true });
  yield* fs.writeFileString(
    catalogFile(home),
    `${JSON.stringify({ checkedAt: new Date().toISOString(), models: now }, null, 2)}\n`,
  );
  const fresh = freshModels(before, now).map((model) => model.selector);
  if (fresh.length === 0) return [];
  const current = yield* settings.current;
  const started: Array<{ agent: string; models: string[]; arms: string[] }> = [];
  for (const agent of yield* (yield* Agents).current) {
    if (agent.agent.trial !== true) continue;
    const resolved = effective(agent, current);
    if (!resolved.enabled) continue;
    const plan = retrialArms(
      {
        model: resolved.agent.model,
        arms: resolved.trial.arms,
        candidates: resolved.agent.candidates,
      },
      fresh,
    );
    if (plan === undefined) continue;
    yield* settings.set(
      { components: { [agent.id]: { trial: true, trialModels: plan.arms } } },
      "trial",
      "trial",
    );
    yield* publishTrial(bus, agent.id, "trial.retrial", {
      models: plan.models,
      arms: plan.arms,
      reason: `new in the provider catalog: ${plan.models.join(", ")}`,
    });
    started.push({ agent: agent.id, ...plan });
  }
  return started;
});

const appendBench = (root: string, line: BenchLine) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const file = benchFile(root, line.agent);
    yield* fs.makeDirectory(file.slice(0, file.lastIndexOf("/")), { recursive: true });
    yield* fs.writeFileString(file, `${JSON.stringify(line)}\n`, { flag: "a" });
  });

const readBench = (root: string, agent: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const text = yield* fs
      .readFileString(benchFile(root, agent))
      .pipe(Effect.orElseSucceed(() => ""));
    return text.split("\n").flatMap((line) => Option.toArray(decodeBenchLine(line)));
  });

/** When this agent's count last started over: its last switch, undo or re-trial. */
const epochOf = (history: ReadonlyArray<AgentEvent>, agent: string) =>
  Math.max(
    0,
    ...history
      .filter((event) =>
        [`${agent}/trial.switched`, `${agent}/trial.undone`, `${agent}/trial.retrial`].includes(
          event.type,
        ),
      )
      .map((event) => Date.parse(event.at)),
  );

/**
 * Background layer: the trial machines and the catalog watch (every `catalogEvery`). Picks arrive as `trial.picked`
 * (Relay Host writes them); config.json turns each agent's trial on and off.
 */
export const layerTrials = (options: {
  readonly catalogEvery: Parameters<typeof Schedule.spaced>[0];
}) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const settings = yield* Settings;
      const agents = yield* Agents;
      const bus = yield* EventBus;
      const home = yield* Home;
      const background = yield* Background;
      const services = yield* Effect.context<
        Settings | Agents | EventBus | Home | FileSystem.FileSystem | ModelCatalog
      >();
      const actors = new Map<string, Actor<typeof trialMachine>>();
      /** Each agent's trial in force: its models' key, or `off`. */
      const shown = new Map<string, string>();
      const picked = new Set<string>();

      const switchModel = (input: SwitchInput) =>
        Effect.gen(function* () {
          const agent = (yield* agents.current).find((candidate) => candidate.id === input.agent);
          if (agent === undefined) return yield* Effect.fail(new Error(`no agent ${input.agent}`));
          const from = effective(agent, yield* settings.current).agent.model;
          const to = input.decision.winner;
          const kept = from === to;
          const changes = yield* settings.set(
            { components: { [agent.id]: kept ? { trial: false } : { model: to, trial: false } } },
            "trial",
            "trial",
          );
          const label = yield* labeller;
          const over = input.arms.filter((model) => model !== to);
          yield* publishTrial(bus, agent.id, "trial.switched", {
            switchId: yield* uuid,
            trialId: input.trialId,
            from,
            to,
            fromLabel: label(from),
            toLabel: label(to),
            kept,
            wins: input.decision.wins,
            of: input.decision.of,
            over,
            overLabels: over.map(label),
            text: switchText(agent.id, input.decision, label(to), over.map(label), kept),
            undo: undoPatch(changes),
          });
        }).pipe(Effect.provideContext(services));

      const actorOf = (agent: string) => {
        const found = actors.get(agent);
        if (found !== undefined) return found;
        const made = createActor(
          trialMachine.provide({
            actors: {
              switchModel: fromPromise<void, SwitchInput>(({ input }) =>
                Effect.runPromise(switchModel(input)),
              ),
            },
          }),
          { input: { agent } },
        ).start();
        actors.set(agent, made);
        return made;
      };

      // Picks already on the bench are not counted twice.
      const sync = (all: ReadonlyArray<Registered>, current: SettingsFile) =>
        Effect.gen(function* () {
          for (const agent of all) {
            const resolved = effective(agent, current);
            const state =
              resolved.enabled && resolved.trial.on ? armsKey(resolved.trial.arms) : "off";
            const before = shown.get(agent.id);
            if (state === before) continue;
            shown.set(agent.id, state);
            if (state === "off") {
              if (before !== undefined) actorOf(agent.id).send({ type: "trial.off" });
              continue;
            }
            // At start the count goes on from the bench; any later change of models starts it over.
            let picks: CountedPick[] = [];
            if (before === undefined) {
              const epoch = epochOf(yield* bus.history, agent.id);
              picks = (yield* readBench(home.root, agent.id))
                .filter((line) => line.armsKey === state && Date.parse(line.at) > epoch)
                .map((line) => ({ at: Date.parse(line.at), winner: line.winner }));
            }
            actorOf(agent.id).send({ type: "trial.on", arms: resolved.trial.arms, picks });
          }
        });

      const onPick = (event: AgentEvent) =>
        Effect.gen(function* () {
          const pick = Option.getOrUndefined(decodePicked(event.data));
          if (pick === undefined) return yield* Effect.logWarning(`bad ${event.type} ${event.id}`);
          const agent = event.component;
          if (picked.has(pick.trialId)) return;
          const history = yield* bus.history;
          const started = history
            .filter((candidate) => candidate.type === `${agent}/trial.started`)
            .flatMap((candidate) => Option.toArray(decodeStarted(candidate.data)))
            .find((candidate) => candidate.trialId === pick.trialId);
          if (started === undefined)
            return yield* Effect.logWarning(`pick for unknown trial ${pick.trialId}`);
          const results = history
            .filter((candidate) => candidate.type === `${agent}/trial.result`)
            .flatMap((candidate) => Option.toArray(decodeResult(candidate.data)))
            .filter((result) => result.trialId === pick.trialId);
          const line = benchLine(agent, started, results, {
            pick: pick.pick,
            at: event.at,
            ...(pick.surface === undefined ? {} : { surface: pick.surface }),
          });
          yield* appendBench(home.root, line);
          picked.add(pick.trialId);
          // Counts only toward the trial in force: a card from before a re-trial is on the bench, nothing more.
          if (shown.get(agent) !== line.armsKey) return;
          actorOf(agent).send({
            type: "pick.recorded",
            pick: { at: Date.parse(event.at), winner: line.winner },
            trialId: pick.trialId,
          });
        });

      for (const agent of yield* agents.current)
        for (const line of yield* readBench(home.root, agent.id)) picked.add(line.trialId);

      // The trials in force before any pick is read, and the picks subscribed before the layer is up: none is missed.
      yield* sync(yield* agents.current, yield* settings.current);
      const events = yield* bus.listen;
      yield* FiberSet.run(
        background,
        Stream.zipLatest(agents.changes, settings.changes).pipe(
          Stream.runForEach(([all, current]) => sync(all, current)),
        ),
      );
      yield* FiberSet.run(
        background,
        events.pipe(
          Stream.runForEach((event) => {
            if (event.type.endsWith("/trial.picked"))
              return onPick(event).pipe(
                Effect.catch((error) =>
                  Effect.logWarning(`trial pick ${event.id}: ${String(error)}`),
                ),
              );
            if (event.type.endsWith("/trial.undone") && Option.isSome(decodeUndone(event.data)))
              return Effect.sync(() => actorOf(event.component).send({ type: "switch.undone" }));
            return Effect.void;
          }),
        ),
      );
      yield* FiberSet.run(
        background,
        checkCatalog.pipe(
          Effect.provideContext(services),
          Effect.tap((started) =>
            Effect.forEach(
              started,
              ({ agent, models }) => Effect.logInfo(`trial: ${agent} tries ${models.join(", ")}`),
              {
                discard: true,
              },
            ),
          ),
          Effect.catch((error) => Effect.logWarning(`model catalog: ${String(error)}`)),
          Effect.repeat(Schedule.spaced(options.catalogEvery)),
        ),
      );
      yield* Effect.addFinalizer(() => Effect.sync(() => actors.forEach((actor) => actor.stop())));
    }),
  );
