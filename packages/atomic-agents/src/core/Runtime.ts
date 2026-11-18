import {
  Cause,
  Clock,
  Context,
  Effect,
  Exit,
  FiberSet,
  FileSystem,
  Layer,
  Option,
  Random,
  Schedule,
  Schema,
  Semaphore,
  Stream,
  SynchronizedRef,
} from "effect";
import type { BunServices } from "@effect/platform-bun/BunServices";
import { Background } from "./Background.ts";
import { Agents } from "./Agent.ts";
import { type InlineTrial, type Registered, type ToolMode, Trigger } from "./Component.ts";
import {
  EventBus,
  Home,
  JobFailed,
  JobStarted,
  JobSucceeded,
  JournalError,
  Lifecycle,
  makeEvent,
} from "./Event.ts";
import { isObject } from "./Fields.ts";
import { runId, uuid } from "./Id.ts";
import type { ModelRunner } from "./Model.ts";
import { events as runtimeEvents, publishRuntime, RUNTIME } from "./RuntimeEvents.ts";
import { effective, Settings } from "./Settings.ts";
import {
  armInput,
  armsOf,
  decodeCatalog,
  modelLabel,
  previewOf,
  requestLine,
  type TrialEvent,
  trialEvents,
} from "./Trial.ts";

const RUN_REQUESTED = `${RUNTIME}/run.requested`;
const decodeRunRequested = Schema.decodeUnknownEffect(runtimeEvents["run.requested"]);

export class UnknownJob extends Schema.TaggedError<UnknownJob>()("UnknownJob", {
  message: Schema.String,
}) {}

export class ComponentDisabled extends Schema.TaggedError<ComponentDisabled>()(
  "ComponentDisabled",
  {
    message: Schema.String,
  },
) {}

/** A tool mode asked of an agent whose model calls no tools. */
export class NoToolMode extends Schema.TaggedError<NoToolMode>()("NoToolMode", {
  message: Schema.String,
}) {}

export interface RunOptions {
  /** Bake-off override; defaults to the model in config.json, else the component's `agent.model`. */
  readonly model?: string;
  /** Bake-off override; defaults to the tool mode in config.json, else the agent file's. Only for an agent with tools. */
  readonly toolMode?: ToolMode;
  /** The request this run answers (`atomic-agents/run.requested`); recorded on `job.started`. */
  readonly requestId?: string;
  /**
   * A trial's run (`Trial.ts`), recorded on `job.started`. `default` is the run on the agent's own model: it answers the
   * caller as usual. An `arm` runs on `model` beside it without waiting on the agent's lock, and its output never goes
   * on the journal (it would answer the caller or wake other agents): it only comes back in `RunResult.reply`.
   * `inline` hands an agent with `trialArms: "inline"` the other arms to run itself.
   */
  readonly trial?: {
    readonly id: string;
    readonly letter: string;
    readonly role: "default" | "arm";
    readonly inline?: InlineTrial;
  };
}

export interface RunResult {
  readonly run: string;
  readonly ok: boolean;
  /** The model the result came from (the fallback when the run fell back). */
  readonly model: string;
  readonly seconds: number;
  /** The job's answer: its ask pair's reply, else the last event it emitted. */
  readonly reply?: unknown;
  /** Why it failed. */
  readonly error?: string;
}

const encodeLifecycle = Schema.encodeEffect(Lifecycle);

/**
 * Runs agent jobs: one at a time per agent (a specialist is one worker), every run wrapped in the
 * `Lifecycle` events (`job.started` / `job.succeeded` / `job.failed`) so any subscriber can follow any
 * agent without knowing its schemas. Each run reads the agents and the config in force, so an agent file or
 * config.json edit applies to the next run without a restart.
 */
export class Runner extends Context.Service<
  Runner,
  {
    run(
      component: string,
      job: string,
      input: unknown,
      options?: RunOptions,
    ): Effect.Effect<RunResult, UnknownJob | ComponentDisabled | NoToolMode | JournalError>;
  }
>()("atomic-agents/Runner") {
  static readonly layer = Layer.effect(
    Runner,
    Effect.gen(function* () {
      const settings = yield* Settings;
      const bus = yield* EventBus;
      const home = yield* Home;
      const fs = yield* FileSystem.FileSystem;
      const agents = yield* Agents;
      const services = yield* Effect.context<ModelRunner | BunServices>();
      // By agent id, so a reloaded agent keeps its lock: a run in flight finishes before the new version's first.
      const locks = yield* SynchronizedRef.make<ReadonlyMap<string, Semaphore.Semaphore>>(
        new Map(),
      );
      const lockOf = (id: string) =>
        SynchronizedRef.modifyEffect(locks, (all) => {
          const found = all.get(id);
          return found !== undefined
            ? Effect.succeed([found, all] as const)
            : Effect.map(
                Semaphore.make(1),
                (made) => [made, new Map([...all, [id, made]])] as const,
              );
        });

      const run = Effect.fn("Runner.run")(function* (
        componentId: string,
        jobId: string,
        input: unknown,
        options: RunOptions = {},
      ) {
        const component = (yield* agents.current).find((candidate) => candidate.id === componentId);
        const job = component?.runnable.find((candidate) => candidate.id === jobId);
        if (component === undefined || job === undefined) {
          return yield* new UnknownJob({ message: `no job ${componentId}/${jobId}` });
        }
        const resolved = effective(component, yield* settings.current);
        if (!resolved.enabled)
          return yield* new ComponentDisabled({
            message: `${component.id} is disabled in ${settings.file}`,
          });
        const run = yield* runId;
        const runDir = home.runDir(component.id, run);
        const stateDir = home.stateDir(component.id);
        // A tiered agent's request field (depth) picks the model, thinking and budget; a bake-off or trial arm (`options.model`) keeps its own model inside the tier.
        const tier = resolved.tier(input);
        const model = options.model ?? tier?.model ?? resolved.agent.model;
        const agent =
          tier === undefined
            ? resolved.agent
            : {
                ...resolved.agent,
                model: tier.model,
                ...(tier.thinking === undefined ? {} : { thinking: tier.thinking }),
              };
        const budget = tier?.budget === undefined ? {} : { budget: tier.budget };
        const arm = options.trial?.role === "arm";
        // A trial arm waits on nothing: not the agent's lock, not other arms (nine Sol arms in a row took 4.5 minutes).
        const lock = arm ? undefined : yield* lockOf(component.id);
        if (options.toolMode !== undefined && resolved.agent.toolMode === undefined) {
          return yield* new NoToolMode({
            message: `${component.id} calls no tools, so it has no tool mode`,
          });
        }
        const toolMode =
          resolved.agent.toolMode === undefined
            ? undefined
            : (options.toolMode ?? resolved.agent.toolMode);
        const modes = toolMode === undefined ? {} : { toolMode };
        const thinking =
          resolved.agent.thinking === undefined ? {} : { thinking: resolved.agent.thinking };
        const envelope = { component: component.id, job: job.id, run };
        const publish = (name: string, data: unknown) =>
          makeEvent({ ...envelope, type: `${component.id}/${name}`, data }).pipe(
            Effect.flatMap(bus.publish),
          );
        // The job's answer, for the trial card: its ask pair's reply, else the last event it emitted. An arm's never goes on the journal.
        const answer: { value?: unknown } = {};
        const jobPublish = (name: string, data: unknown) => {
          if (component.asks === undefined || name === component.asks.reply) answer.value = data;
          return arm ? Effect.void : publish(name, data);
        };
        const lifecycle = (event: Lifecycle) =>
          encodeLifecycle(event).pipe(
            Effect.mapError(
              (cause) => new JournalError({ message: `encode ${event._tag}`, cause }),
            ),
            Effect.flatMap((data) => publish(event._tag, data)),
          );
        const body = Effect.gen(function* () {
          const started = yield* Clock.currentTimeMillis;
          const seconds = Effect.map(Clock.currentTimeMillis, (now) => (now - started) / 1000);
          yield* Effect.forEach(
            [runDir, stateDir],
            (dir) =>
              fs
                .makeDirectory(dir, { recursive: true })
                .pipe(
                  Effect.mapError((cause) => new JournalError({ message: `create ${dir}`, cause })),
                ),
            { discard: true },
          );
          const attempt = (model: string) =>
            job
              .start(input, {
                ...envelope,
                runDir,
                stateDir,
                model,
                ...modes,
                ...budget,
                agent,
                publish: jobPublish,
                ...(options.trial?.inline === undefined ? {} : { trial: options.trial.inline }),
              })
              .pipe(Effect.provideContext(services), Effect.exit);
          yield* lifecycle(
            JobStarted.make({
              input,
              model,
              ...modes,
              ...thinking,
              ...(options.requestId === undefined ? {} : { requestId: options.requestId }),
              ...(options.trial === undefined
                ? {}
                : { trial: { id: options.trial.id, letter: options.trial.letter } }),
            }),
          );
          let outcome = yield* attempt(model);
          let ranOn = model;
          // One retry on the backup model when the run failed on the main one. A bad input (SchemaError) or a defect would fail the same way, and a bake-off arm (`options.model`) must not be swapped.
          const backup = options.model === undefined ? resolved.fallbackModel : undefined;
          if (backup !== undefined && backup !== model && Exit.isFailure(outcome)) {
            const first = Cause.findErrorOption(outcome.cause);
            if (first._tag === "Some" && first.value._tag !== "SchemaError") {
              yield* lifecycle(
                JobStarted.make({
                  input,
                  model: backup,
                  ...modes,
                  ...thinking,
                  fellBackFrom: model,
                  reason: `${first.value._tag}: ${first.value.message}`.slice(0, 500),
                  ...(options.requestId === undefined ? {} : { requestId: options.requestId }),
                  ...(options.trial === undefined
                    ? {}
                    : { trial: { id: options.trial.id, letter: options.trial.letter } }),
                }),
              );
              outcome = yield* attempt(backup);
              ranOn = backup;
            }
          }
          const fellBack = ranOn !== model;
          if (Exit.isSuccess(outcome)) {
            const took = yield* seconds;
            yield* lifecycle(
              JobSucceeded.make({
                model: ranOn,
                seconds: took,
                ...(fellBack ? { fellBack } : {}),
              }),
            );
            return {
              run,
              ok: true,
              model: ranOn,
              seconds: took,
              ...("value" in answer ? { reply: answer.value } : {}),
            };
          }
          const failure = Cause.findErrorOption(outcome.cause);
          const took = yield* seconds;
          const message =
            failure._tag === "Some"
              ? failure.value.message
              : Cause.pretty(outcome.cause).slice(0, 2000);
          yield* lifecycle(
            JobFailed.make({
              model: ranOn,
              seconds: took,
              error: failure._tag === "Some" ? failure.value._tag : "Defect",
              message,
            }),
          );
          return { run, ok: false, model: ranOn, seconds: took, error: message };
        });
        return yield* lock === undefined ? body : lock.withPermits(1)(body);
      });

      return Runner.of({ run });
    }),
  );

  /**
   * Background layer: arms every OnEvent and Cron trigger of the agents in force, in the `Background` set.
   * One bus subscription serves every event trigger: each event looks up the agents and config in force,
   * so an agent loaded or edited later is armed without re-subscribing, and a disabled agent skips it. Crons
   * are re-armed whenever the agents, the enabled set or an expression changes. A trigger that cannot run
   * is logged; a `JournalError` ends serve.
   */
  static readonly layerTriggers = Layer.effectDiscard(
    Effect.gen(function* () {
      const runner = yield* Runner;
      const agents = yield* Agents;
      const settings = yield* Settings;
      const bus = yield* EventBus;
      const background = yield* Background;
      const home = yield* Home;
      const fs = yield* FileSystem.FileSystem;

      const publishTrial = <K extends TrialEvent>(
        agent: string,
        job: string,
        trialId: string,
        name: K,
        data: (typeof trialEvents)[K]["Type"],
        caller?: string,
      ) =>
        Schema.encodeUnknownEffect(trialEvents[name])(data).pipe(
          Effect.mapError(
            (cause) => new JournalError({ message: `encode ${agent}/${name}`, cause }),
          ),
          Effect.flatMap((encoded) =>
            makeEvent({
              type: `${agent}/${name}`,
              component: agent,
              job,
              run: `trial-${trialId.slice(0, 8)}`,
              ...(caller === undefined ? {} : { caller }),
              data: encoded,
            }),
          ),
          Effect.flatMap(bus.publish),
        );

      /** The provider catalog's names (`TrialService` keeps the file), for the labels revealed after a pick. */
      const catalogNames = fs.readFileString(`${home.stateDir("trials")}/catalog.json`).pipe(
        Effect.map((text) => decodeCatalog(text)),
        Effect.map((file) =>
          Option.match(file, {
            onNone: () => new Map<string, string>(),
            onSome: ({ models }) => new Map(models.map((m) => [m.selector, m.name])),
          }),
        ),
        Effect.orElseSucceed(() => new Map<string, string>()),
      );

      /**
       * A caller's request to a trial agent (`Trial.ts`): `trial.started`, every arm at once (the default arm is the
       * normal run, answering the caller), one `trial.result` per arm as it ends. Answers the default arm's run, so a
       * request that cannot start fails as before.
       */
      const runTrial = Effect.fnUntraced(function* (
        agent: Registered,
        jobId: string,
        input: unknown,
        request: { readonly requestId?: string; readonly caller: string },
        trial: { readonly arms: ReadonlyArray<string>; readonly model: string },
      ) {
        const trialId = yield* uuid;
        const draws = yield* Effect.all(trial.arms.map(() => Random.next));
        const names = yield* catalogNames;
        const arms = armsOf(
          trial.arms,
          trial.model,
          () => draws.pop() ?? 0,
          (model) => modelLabel(model, names.get(model)),
        );
        yield* publishTrial(
          agent.id,
          jobId,
          trialId,
          "trial.started",
          {
            trialId,
            ...(request.requestId === undefined ? {} : { requestId: request.requestId }),
            caller: request.caller,
            job: jobId,
            request: requestLine(input),
            arms,
          },
          request.caller,
        );
        const report = (letter: string, outcome: Parameters<InlineTrial["report"]>[1]) => {
          const arm = arms.find((candidate) => candidate.letter === letter);
          return arm === undefined
            ? Effect.logWarning(`trial ${trialId}: no arm ${letter}`)
            : publishTrial(agent.id, jobId, trialId, "trial.result", {
                trialId,
                letter: arm.letter,
                model: arm.model,
                ...outcome,
                ...(outcome.error === undefined ? {} : { error: outcome.error.slice(0, 1000) }),
              });
        };
        const reportRun = (letter: string) => (result: RunResult) => {
          const cost =
            isObject(result.reply) && typeof result.reply["cost"] === "number"
              ? result.reply["cost"]
              : undefined;
          return report(letter, {
            ok: result.ok,
            seconds: result.seconds,
            ...(result.ok
              ? { preview: previewOf(result.reply, agent.asks?.show) }
              : { error: result.error ?? "the run failed" }),
            ...(cost === undefined ? {} : { cost }),
          });
        };
        const own = arms.find((arm) => arm.default)!;
        const others = arms.filter((arm) => !arm.default);
        if (agent.trialArms !== "inline")
          for (const arm of others)
            yield* FiberSet.run(
              background,
              runner
                .run(agent.id, jobId, armInput(input, trialId, arm.letter), {
                  model: arm.model,
                  trial: { id: trialId, letter: arm.letter, role: "arm" },
                })
                .pipe(
                  Effect.flatMap(reportRun(arm.letter)),
                  Effect.catch((error) =>
                    error._tag === "JournalError"
                      ? Effect.fail(error)
                      : report(arm.letter, { ok: false, seconds: 0, error: error.message }),
                  ),
                ),
            );
        const inline: InlineTrial = {
          id: trialId,
          letter: own.letter,
          others: others.map(({ letter, model }) => ({ letter, model })),
          report,
        };
        return yield* runner
          .run(agent.id, jobId, input, {
            ...(request.requestId === undefined ? {} : { requestId: request.requestId }),
            trial: {
              id: trialId,
              letter: own.letter,
              role: "default",
              ...(agent.trialArms === "inline" ? { inline } : {}),
            },
          })
          .pipe(Effect.tap(reportRun(own.letter)));
      });

      /** The agent's trial when this request starts one: trial on, and a caller to show the card to. */
      const trialFor = (agentId: string, caller: string | undefined, input: unknown) =>
        Effect.gen(function* () {
          if (caller === undefined) return undefined;
          const agent = (yield* agents.current).find((candidate) => candidate.id === agentId);
          if (agent === undefined) return undefined;
          const resolved = effective(agent, yield* settings.current);
          const tier = resolved.tier(input);
          return resolved.enabled && resolved.trial.on
            ? {
                agent,
                caller,
                trial: {
                  arms: tier?.arms ?? resolved.trial.arms,
                  model: tier?.model ?? resolved.agent.model,
                },
              }
            : undefined;
        });
      const runLogged = (component: string, job: string, input: unknown, options?: RunOptions) =>
        runner.run(component, job, input, options).pipe(
          Effect.catchTags({
            UnknownJob: (error) => Effect.logWarning(error.message),
            ComponentDisabled: (error) => Effect.logInfo(error.message),
            NoToolMode: (error) => Effect.logWarning(error.message),
          }),
        );

      /** A caller's `run.requested`: the run carries its `requestId`; one that cannot start is a `run.rejected` the caller sees. */
      const runRequested = (data: unknown, caller: string | undefined) =>
        decodeRunRequested(data).pipe(
          Effect.flatMap((request) =>
            Effect.flatMap(trialFor(request.agent, caller, request.input), (trial) =>
              trial === undefined
                ? runner.run(request.agent, request.job, request.input, {
                    requestId: request.requestId,
                  })
                : runTrial(
                    trial.agent,
                    request.job,
                    request.input,
                    { requestId: request.requestId, caller: trial.caller },
                    trial.trial,
                  ),
            ).pipe(
              Effect.asVoid,
              // A journal failure ends serve like any other; anything else means the run never started.
              Effect.catch((error) =>
                error._tag === "JournalError"
                  ? Effect.fail(error)
                  : publishRuntime(
                      bus,
                      "run.rejected",
                      {
                        requestId: request.requestId,
                        agent: request.agent,
                        error: error.message,
                      },
                      "runner",
                    ),
              ),
            ),
          ),
          Effect.catchTag("SchemaError", (error) =>
            Effect.logWarning(`bad ${RUN_REQUESTED}: ${error.message}`),
          ),
        );

      // Subscribed before the layer is up: a request emitted right after serve starts is not missed.
      yield* FiberSet.run(
        background,
        (yield* bus.listen).pipe(
          Stream.runForEach((event) =>
            Effect.gen(function* () {
              if (event.type === RUN_REQUESTED)
                return yield* FiberSet.run(background, runRequested(event.data, event.caller));
              const current = yield* settings.current;
              for (const agent of yield* agents.current) {
                for (const job of agent.jobs) {
                  if (
                    !job.triggers.some(
                      (trigger) => Trigger.$is("OnEvent")(trigger) && trigger.type === event.type,
                    )
                  )
                    continue;
                  if (!effective(agent, current).enabled)
                    yield* Effect.logInfo(`${agent.id} is disabled, skipped ${event.type}`);
                  else {
                    // A caller's ask to a trial agent runs as a trial; anything else (crons, other agents' events) runs once.
                    const asked =
                      event.job === "ask" &&
                      agent.asks !== undefined &&
                      event.type === `${agent.id}/${agent.asks.request}`;
                    const trial = asked
                      ? yield* trialFor(agent.id, event.caller, event.data)
                      : undefined;
                    const data = event.data as { readonly requestId?: unknown } | null;
                    // Each run in its own fiber: a slow agent never holds up another agent's events (the runner's lock orders an agent's own).
                    yield* FiberSet.run(
                      background,
                      trial === undefined
                        ? runLogged(agent.id, job.id, event.data)
                        : runTrial(
                            trial.agent,
                            job.id,
                            event.data,
                            {
                              caller: trial.caller,
                              ...(typeof data?.requestId === "string"
                                ? { requestId: data.requestId }
                                : {}),
                            },
                            trial.trial,
                          ).pipe(
                            Effect.asVoid,
                            Effect.catchTags({
                              UnknownJob: (error) => Effect.logWarning(error.message),
                              ComponentDisabled: (error) => Effect.logInfo(error.message),
                              NoToolMode: (error) => Effect.logWarning(error.message),
                            }),
                          ),
                    );
                  }
                }
              }
            }),
          ),
        ),
      );
      yield* FiberSet.run(
        background,
        agents.changes.pipe(
          Stream.map((all) =>
            all.flatMap((agent) =>
              agent.jobs.flatMap((job) =>
                job.triggers.flatMap((trigger) =>
                  Trigger.$is("OnEvent")(trigger)
                    ? [`${agent.id}/${job.id} on ${trigger.type}`]
                    : [],
                ),
              ),
            ),
          ),
          Stream.changes,
          Stream.runForEach((armed) =>
            Effect.forEach(armed, (line) => Effect.logInfo(`armed ${line}`), { discard: true }),
          ),
        ),
      );

      yield* FiberSet.run(
        background,
        Stream.zipLatest(agents.changes, settings.changes).pipe(
          Stream.map(([all, current]) =>
            all.flatMap((agent) => {
              const resolved = effective(agent, current);
              if (!resolved.enabled) return [];
              return agent.jobs.flatMap((job) =>
                job.triggers.flatMap((trigger) =>
                  Trigger.$is("Cron")(trigger)
                    ? [
                        {
                          component: agent.id,
                          job: job.id,
                          cron: resolved.cron(job.id, trigger.cron),
                          input: trigger.input,
                        },
                      ]
                    : [],
                ),
              );
            }),
          ),
          // Plans are plain arrays of plain objects: `Equal.equals` compares them structurally (a reloaded agent's new input effect re-arms it).
          Stream.changes,
          Stream.switchMap((plan) =>
            Stream.fromEffectDrain(
              Effect.forEach(
                plan,
                (entry) =>
                  Effect.logInfo(`armed ${entry.component}/${entry.job} cron "${entry.cron}"`).pipe(
                    Effect.andThen(
                      entry.input.pipe(
                        Effect.flatMap((input) => runLogged(entry.component, entry.job, input)),
                        Effect.schedule(Schedule.cron(entry.cron)),
                        // config.json and agent file crons are validated before they apply; this catches a bad code default.
                        Effect.catchTag("CronParseError", (error) =>
                          Effect.logError(
                            `bad cron "${entry.cron}" for ${entry.component}/${entry.job}: ${error.message}`,
                          ),
                        ),
                      ),
                    ),
                  ),
                { concurrency: "unbounded", discard: true },
              ),
            ),
          ),
          Stream.runDrain,
        ),
      );
    }),
  );
}
