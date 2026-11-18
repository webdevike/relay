#!/usr/bin/env bun
import { BunRuntime, BunServices } from "@effect/platform-bun";
import {
  Clock,
  Console,
  Effect,
  FiberSet,
  FileSystem,
  Layer,
  Option,
  Path,
  Schema,
  Stream,
  SubscriptionRef,
} from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { Adapters } from "./core/Adapter.ts";
import { packs } from "./packs.ts";
import { ask } from "./core/Ask.ts";
import { Background } from "./core/Background.ts";
import { agentFiles, Agents, parseAgent } from "./core/Agent.ts";
import { type EventSchemas, ToolMode, Trigger } from "./core/Component.ts";
import { type AgentEvent, EventBus, Home, lifecycle, makeEvent } from "./core/Event.ts";
import { shortId } from "./core/Id.ts";
import { ModelRunner } from "./core/Model.ts";
import * as Health from "./core/observability/Health.ts";
import * as Outcomes from "./core/observability/Outcomes.ts";
import * as Roster from "./core/observability/Roster.ts";
import * as Tracing from "./core/observability/Tracing.ts";
import * as Traces from "./core/observability/Traces.ts";
import { Orchestrators, Reporter, Sessions } from "./core/Orchestrator.ts";
import { type RunOptions, Runner } from "./core/Runtime.ts";
import { Outcome, publishRuntime, RUNTIME, runtime } from "./core/RuntimeEvents.ts";
import * as Requests from "./core/Requests.ts";
import * as Service from "./core/Service.ts";
import { effective, Settings } from "./core/Settings.ts";
import { ModelCatalog } from "./core/Catalog.ts";
import { clearWinner, LETTERS, PickValue, trialAllowance, trialEvents } from "./core/Trial.ts";
import { benchFile, BenchLine, checkCatalog, layerTrials } from "./core/TrialService.ts";

const parseJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

const show = (event: AgentEvent) =>
  Console.log(
    `${event.at.slice(11, 19)}  ${event.type.padEnd(30)} ${event.run.padEnd(24)} ${JSON.stringify(event.data).slice(0, 220)}`,
  );

/** A bake-off arm as people read it: the model, with its tool mode for an agent with tools. */
const arm = (model: string, toolMode: ToolMode | undefined) =>
  toolMode === undefined ? model : `${model} [${toolMode}]`;

/** Run one job and stream its events until the runtime reports it finished. */
const runAndFollow = Effect.fnUntraced(function* (
  component: string,
  job: string,
  input: unknown,
  options: RunOptions,
) {
  const bus = yield* EventBus;
  const runner = yield* Runner;
  // Runs whose job.succeeded / job.failed has arrived; the event can land before or after `run` returns.
  const finished = yield* SubscriptionRef.make<ReadonlySet<string>>(new Set());
  yield* bus.subscribe.pipe(
    Stream.runForEach((event) =>
      show(event).pipe(
        Effect.andThen(
          Option.match(lifecycle(event), {
            onNone: () => Effect.void,
            onSome: ({ _tag }) =>
              _tag === "job.started"
                ? Effect.void
                : SubscriptionRef.update(finished, (runs) => new Set([...runs, event.run])),
          }),
        ),
      ),
    ),
    Effect.forkScoped,
  );
  const result = yield* runner.run(component, job, input, options);
  yield* SubscriptionRef.changes(finished).pipe(
    Stream.filter((runs) => runs.has(result.run)),
    Stream.runHead,
    Effect.timeout("10 seconds"),
    Effect.ignore,
  );
  return result;
}, Effect.scoped);

const modelFlag = Flag.String("model").pipe(
  Flag.withDescription("omp model id overriding the component default"),
  Flag.optional,
);
const toolModeFlag = Flag.Literals("tool-mode", ToolMode.literals).pipe(
  Flag.withDescription(
    "tools (native tool calls, several per model turn) or code (one sandboxed script per turn); only for an agent with tools, see docs/code-mode.md",
  ),
  Flag.optional,
);
const inputFlag = Flag.String("input").pipe(
  Flag.withDescription("job input as JSON"),
  Flag.withDefault("{}"),
);
const byFlag = Flag.String("by").pipe(
  Flag.withDescription("who is changing it (recorded on config.changed)"),
  Flag.withDefault(Bun.env["USER"] ?? "cli"),
);

/** Every agent and how it is set; with --json, the roster the Relay Agents page shows (disabled agents and files that failed to load too, with run stats). */
const list = Command.make(
  "list",
  {
    json: Flag.Boolean("json").pipe(
      Flag.withDescription(
        "one JSON line: every agent in load order (disabled ones and files that failed to load too) with its file, knowledge, settings and run stats",
      ),
      Flag.withDefault(false),
    ),
  },
  Effect.fnUntraced(function* ({ json }) {
    if (json) return yield* printJson(Requests.roster);
    const settings = yield* Settings;
    const current = yield* settings.current;
    yield* Console.log(`config ${settings.file}`);
    for (const component of yield* (yield* Agents).current) {
      const resolved = effective(component, current);
      yield* Console.log(
        `${component.id}${resolved.enabled ? "" : " (disabled)"}: ${component.purpose}`,
      );
      yield* Console.log(
        `  file    ${component.file ?? "(code, passed in by the host)"} [${component.kind}]`,
      );
      yield* Console.log(
        `  agent   ${resolved.agent.model}${resolved.agent.thinking ? ` thinking ${resolved.agent.thinking}` : ""}${resolved.agent.toolMode ? ` tool mode ${resolved.agent.toolMode}` : ""} (candidates: ${resolved.agent.candidates.join(", ")})`,
      );
      for (const job of component.jobs) {
        const triggers = job.triggers.map(
          Trigger.$match({
            Manual: () => "manual",
            Cron: ({ cron }) => `cron "${resolved.cron(job.id, cron)}"`,
            OnEvent: ({ type }) => `on ${type}`,
          }),
        );
        yield* Console.log(`  job     ${job.id} [${triggers.join(", ")}]: ${job.description}`);
      }
      yield* Console.log(
        `  events  ${Object.keys(component.events)
          .map((name) => `${component.id}/${name}`)
          .join(", ")}`,
      );
    }
  }),
);

const run = Command.make(
  "run",
  {
    component: Argument.String("component"),
    job: Argument.String("job"),
    input: inputFlag,
    model: modelFlag,
    toolMode: toolModeFlag,
  },
  Effect.fnUntraced(function* ({ component, job, input, model, toolMode }) {
    const options = {
      ...Option.match(model, { onNone: () => ({}), onSome: (value) => ({ model: value }) }),
      ...Option.match(toolMode, { onNone: () => ({}), onSome: (value) => ({ toolMode: value }) }),
    };
    const result = yield* runAndFollow(component, job, yield* parseJson(input), options);
    if (!result.ok) return yield* Effect.fail(new Error(`run ${result.run} failed`));
  }),
);

/** One input across arms, each a model (by default the candidates) times a tool mode (`--tool-modes tools,code`, for an agent with tools). */
const bench = Command.make(
  "bench",
  {
    component: Argument.String("component"),
    job: Argument.String("job"),
    input: inputFlag,
    models: Flag.String("models").pipe(
      Flag.withDescription("comma-separated omp model ids; default: the component's candidates"),
      Flag.optional,
    ),
    toolModes: Flag.String("tool-modes").pipe(
      Flag.withDescription(
        "comma-separated tool modes to cross with the models (tools,code); default: the one in force",
      ),
      Flag.optional,
    ),
  },
  Effect.fnUntraced(function* ({ component, job, input, models, toolModes }) {
    const spec = (yield* (yield* Agents).current).find((candidate) => candidate.id === component);
    const candidates =
      spec === undefined ? [] : effective(spec, yield* (yield* Settings).current).agent.candidates;
    const modelArms = Option.match(models, {
      onNone: () => candidates,
      onSome: (list) => list.split(","),
    });
    const modeArms = yield* Option.match(toolModes, {
      onNone: () => Effect.succeed([undefined]),
      onSome: (list) => Schema.decodeUnknownEffect(Schema.Array(ToolMode))(list.split(",")),
    });
    const decoded = yield* parseJson(input);
    const arms = modelArms.flatMap((model) =>
      modeArms.map((toolMode) => ({ model, ...(toolMode === undefined ? {} : { toolMode }) })),
    );
    const results = yield* Effect.forEach(arms, (options) =>
      runAndFollow(component, job, decoded, options).pipe(
        Effect.map((result) => ({ ...options, ...result })),
      ),
    );
    yield* Console.log("\nbake-off (pick with: atomic-agents rate <run-a> <run-b> a|b|tie)");
    for (const result of results)
      yield* Console.log(
        `  ${result.ok ? "ok  " : "FAIL"} ${arm(result.model, result.toolMode).padEnd(40)} ${result.run}`,
      );
  }),
);

/** Pairwise A-vs-B pick between two runs of the same job; `wins` turns the picks into a win rate per arm (model, and tool mode for an agent with tools). */
const rate = Command.make(
  "rate",
  {
    a: Argument.String("run-a"),
    b: Argument.String("run-b"),
    winner: Argument.Literals("winner", ["a", "b", "tie"]),
    note: Flag.String("note").pipe(Flag.withDefault("")),
  },
  Effect.fnUntraced(function* ({ a, b, winner, note }) {
    const bus = yield* EventBus;
    const history = yield* bus.history;
    const [left, right] = [a, b].map(
      (run) =>
        history.flatMap((event) => {
          const started = lifecycle(event);
          return event.run === run && Option.isSome(started) && started.value._tag === "job.started"
            ? [
                {
                  event,
                  side: {
                    run,
                    model: started.value.model,
                    ...(started.value.toolMode === undefined
                      ? {}
                      : { toolMode: started.value.toolMode }),
                  },
                },
              ]
            : [];
        })[0],
    );
    if (left === undefined || right === undefined) {
      // Bench arms run under a scratch ATOMIC_AGENTS_HOME are not in this journal (the design-critic blind pair was).
      return yield* Effect.fail(
        new Error(
          `no run ${left === undefined ? a : b} in the journal ${(yield* Home).journal}; blind arms must run in this home (atomic-agents bench <agent> <job> --models a,b)`,
        ),
      );
    }
    if (left.event.component !== right.event.component || left.event.job !== right.event.job)
      return yield* Effect.fail(new Error("both runs must come from the same job"));
    yield* bus.publish(
      yield* makeEvent({
        type: `${left.event.component}/pair.picked`,
        component: left.event.component,
        job: left.event.job,
        run: `pick-${yield* shortId}`,
        data: { a: left.side, b: right.side, winner, note },
      }),
    );
    const picked = winner === "a" ? left.side : right.side;
    yield* Console.log(
      `picked ${winner === "tie" ? "tie" : `${winner}: ${arm(picked.model, picked.toolMode)}`}`,
    );
  }),
);

/** A side of a pick; picks written before tool modes have no `toolMode`. */
const Side = Schema.Struct({ model: Schema.String, toolMode: Schema.optionalKey(ToolMode) });
const Pick = Schema.Struct({ a: Side, b: Side, winner: Schema.Literals(["a", "b", "tie"]) });

const wins = Command.make(
  "wins",
  {
    component: Flag.String("component").pipe(Flag.withDefault("")),
  },
  Effect.fnUntraced(function* ({ component }) {
    const tally = new Map<
      string,
      {
        component: string;
        model: string;
        toolMode: ToolMode | undefined;
        won: number;
        lost: number;
        tied: number;
      }
    >();
    for (const event of yield* (yield* EventBus).history) {
      if (
        !event.type.endsWith("/pair.picked") ||
        (component !== "" && event.component !== component)
      )
        continue;
      const pick = Schema.decodeUnknownOption(Pick)(event.data);
      if (Option.isNone(pick)) continue;
      const { a, b } = pick.value;
      if (a.model === b.model && a.toolMode === b.toolMode) continue;
      for (const side of ["a", "b"] as const) {
        const { model, toolMode } = pick.value[side];
        const key = `${event.component}  ${arm(model, toolMode)}`;
        const row = tally.get(key) ?? {
          component: event.component,
          model,
          toolMode,
          won: 0,
          lost: 0,
          tied: 0,
        };
        if (pick.value.winner === "tie") row.tied++;
        else if (pick.value.winner === side) row.won++;
        else row.lost++;
        tally.set(key, row);
      }
    }
    const rows = [...tally.values()].map((row) => ({
      ...row,
      rate: (row.won + row.tied / 2) / (row.won + row.lost + row.tied),
    }));
    if (rows.length === 0) return yield* Console.log("no pairwise picks yet");
    rows.sort((x, y) => y.rate - x.rate);
    for (const row of rows) {
      yield* Console.log(
        `${`${row.component}  ${arm(row.model, row.toolMode)}`.padEnd(56)} ${(row.rate * 100).toFixed(0).padStart(3)}%  ${row.won}W ${row.lost}L ${row.tied}T`,
      );
    }
    // The winner goes into config.json, never into code.
    const current = yield* (yield* Settings).current;
    for (const spec of yield* (yield* Agents).current) {
      const best = rows.find((row) => row.component === spec.id);
      if (best === undefined) continue;
      const inForce = effective(spec, current).agent;
      // A pick without a tool mode says nothing about it: keep the mode in force.
      const sameMode = best.toolMode === undefined || best.toolMode === inForce.toolMode;
      yield* Console.log(
        inForce.model === best.model && sameMode
          ? `\n${spec.id} already uses its winner ${arm(best.model, best.toolMode)}`
          : `\n${spec.id} uses ${arm(inForce.model, inForce.toolMode)}; promote the winner with: atomic-agents use ${spec.id} ${best.model}${sameMode ? "" : ` --tool-mode ${best.toolMode}`}`,
      );
    }
  }),
);

/** Set a component's model, backup model and/or tool mode in config.json (the bake-off winner); a running service applies it to the next run. */
const use = Command.make(
  "use",
  {
    component: Argument.String("component"),
    model: Argument.String("model").pipe(
      Argument.withDescription("omp model id; omit to change only the backup or tool mode"),
      Argument.optional,
    ),
    fallback: Flag.String("fallback").pipe(
      Flag.withDescription(
        "backup omp model id: a run that fails on the main model is retried once on it",
      ),
      Flag.optional,
    ),
    toolMode: toolModeFlag,
    by: byFlag,
  },
  Effect.fnUntraced(function* ({ component, model, fallback, toolMode, by }) {
    if (Option.isNone(model) && Option.isNone(fallback) && Option.isNone(toolMode))
      return yield* Effect.fail(
        new Error("name a model, --fallback <model>, --tool-mode tools|code, or any of them"),
      );
    const settings = yield* Settings;
    const own = {
      ...Option.match(model, { onNone: () => ({}), onSome: (value) => ({ model: value }) }),
      ...Option.match(fallback, {
        onNone: () => ({}),
        onSome: (value) => ({ fallbackModel: value }),
      }),
      ...Option.match(toolMode, { onNone: () => ({}), onSome: (value) => ({ toolMode: value }) }),
    };
    const changes = yield* settings.set({ components: { [component]: own } }, by, "use");
    if (changes.length === 0)
      return yield* Console.log(`${component} already uses ${JSON.stringify(own)}`);
    for (const change of changes)
      yield* Console.log(
        `${change.path.join(".")}: ${JSON.stringify(change.old)} -> ${JSON.stringify(change.new)}`,
      );
    yield* Console.log(
      `written to ${settings.file}; a running service applies it from the next run (undo: the config.changed event's undo patch)`,
    );
  }),
);

/**
 * Trial mode (`core/Trial.ts`): where each taste agent's blind trial stands, turn one on or off, record a pick as Relay
 * Host does (`trial.picked`), or read the provider catalog now (a new model starts a fresh trial).
 */
const trial = Command.make("trial").pipe(
  Command.withSubcommands([
    Command.make(
      "status",
      { component: Argument.String("component").pipe(Argument.optional) },
      Effect.fnUntraced(function* ({ component }) {
        const current = yield* (yield* Settings).current;
        const home = yield* Home;
        const fs = yield* FileSystem.FileSystem;
        const history = yield* (yield* EventBus).history;
        const now = Date.now();
        for (const agent of yield* (yield* Agents).current) {
          if (Option.isSome(component) && agent.id !== component.value) continue;
          const resolved = effective(agent, current);
          if (agent.agent.trial !== true && !resolved.trial.on) continue;
          const lines = (yield* fs
            .readFileString(benchFile(home.root, agent.id))
            .pipe(Effect.orElseSucceed(() => "")))
            .split("\n")
            .flatMap((line) =>
              Option.toArray(Schema.decodeUnknownOption(Schema.fromJsonString(BenchLine))(line)),
            );
          const decided = clearWinner(
            lines.map((line) => ({ at: Date.parse(line.at), winner: line.winner })),
          );
          const allowance = trialAllowance(history, agent.id, resolved.trial, now);
          yield* Console.log(
            `${agent.id}  trial ${resolved.trial.on ? "on" : "off"}${allowance.idle ? ` (idle-off: no pick in ${resolved.trial.idleDays} days)` : ""}  model ${resolved.agent.model}  arms ${resolved.trial.arms.join(", ")}  budget ${allowance.today} of ${allowance.perDay} today  picks on the bench ${lines.length}${decided === undefined ? "" : `  (all-time leader ${decided.winner}: ${decided.wins} of ${decided.of})`}`,
          );
        }
      }),
    ),
    Command.make(
      "on",
      {
        component: Argument.String("component"),
        models: Flag.String("models").pipe(
          Flag.withDescription(
            "comma-separated omp model ids (2 or 3; the agent's model is always one)",
          ),
          Flag.optional,
        ),
        by: byFlag,
      },
      Effect.fnUntraced(function* ({ component, models, by }) {
        const own = {
          trial: true,
          ...Option.match(models, {
            onNone: () => ({}),
            onSome: (value) => ({ trialModels: value.split(",").map((model) => model.trim()) }),
          }),
        };
        const changes = yield* (yield* Settings).set(
          { components: { [component]: own } },
          by,
          "set",
        );
        yield* Console.log(
          changes.length === 0 ? `${component}: trial already on` : `${component}: trial on`,
        );
      }),
    ),
    Command.make(
      "off",
      { component: Argument.String("component"), by: byFlag },
      Effect.fnUntraced(function* ({ component, by }) {
        const changes = yield* (yield* Settings).set(
          { components: { [component]: { trial: false } } },
          by,
          "set",
        );
        yield* Console.log(
          changes.length === 0 ? `${component}: trial already off` : `${component}: trial off`,
        );
      }),
    ),
    Command.make(
      "pick",
      {
        trialId: Argument.String("trial"),
        pick: Argument.Literals("pick", [...LETTERS, "unsure"]),
        surface: Flag.String("surface").pipe(Flag.withDefault("desktop")),
        by: byFlag,
      },
      Effect.fnUntraced(function* ({ trialId, pick, surface, by }) {
        const bus = yield* EventBus;
        const started = (yield* bus.history).find(
          (event) =>
            event.type.endsWith("/trial.started") &&
            Option.isSome(
              Option.filter(
                Schema.decodeUnknownOption(trialEvents["trial.started"])(event.data),
                (data) => data.trialId === trialId,
              ),
            ),
        );
        if (started === undefined) return yield* Effect.fail(new Error(`no trial ${trialId}`));
        const data = yield* Schema.encodeUnknownEffect(trialEvents["trial.picked"])({
          trialId,
          pick: yield* Schema.decodeUnknownEffect(PickValue)(pick),
          surface,
          by,
        });
        yield* bus.publish(
          yield* makeEvent({
            type: `${started.component}/trial.picked`,
            component: started.component,
            job: "trial",
            run: `pick-${yield* shortId}`,
            data,
          }),
        );
        yield* Console.log(`${started.component}: picked ${pick} on ${trialId}`);
      }),
    ),
    Command.make("catalog", {}, () =>
      checkCatalog.pipe(
        Effect.flatMap((started) =>
          started.length === 0
            ? Console.log("no new model fits a trial agent (the catalog is remembered)")
            : Effect.forEach(
                started,
                ({ agent, models, arms }) =>
                  Console.log(
                    `${agent}: fresh trial with ${models.join(", ")} (models ${arms.join(", ")})`,
                  ),
                { discard: true },
              ),
        ),
      ),
    ),
  ]),
);

/** Set how a consumer uses a component's answers (widget: Relay Host under assistants' replies); it reads config.json on every request. */
const mode = Command.make(
  "mode",
  {
    component: Argument.String("component"),
    mode: Argument.Literals("mode", ["shadow", "live", "off"]),
    by: byFlag,
  },
  Effect.fnUntraced(function* ({ component, mode, by }) {
    const settings = yield* Settings;
    const changes = yield* settings.set({ components: { [component]: { mode } } }, by, "set");
    if (changes.length === 0) return yield* Console.log(`${component} is already ${mode}`);
    for (const change of changes)
      yield* Console.log(
        `${change.path.join(".")}: ${JSON.stringify(change.old)} -> ${JSON.stringify(change.new)}`,
      );
    yield* Console.log(`written to ${settings.file}; Relay Host applies it from the next reply`);
  }),
);

const emit = Command.make(
  "emit",
  {
    type: Argument.String("type"),
    data: Flag.String("data").pipe(Flag.withDefault("{}")),
  },
  Effect.fnUntraced(function* ({ type, data }) {
    const [component = "", name = ""] = type.split("/");
    const declared: EventSchemas | undefined =
      component === RUNTIME
        ? runtime.events
        : (yield* (yield* Agents).current).find((candidate) => candidate.id === component)?.events;
    const schema = declared?.[name];
    if (schema === undefined)
      return yield* Effect.fail(new Error(`${type} is not a declared event`));
    const encoded = yield* Schema.encodeUnknownEffect(schema)(yield* parseJson(data));
    const bus = yield* EventBus;
    yield* bus.publish(
      yield* makeEvent({
        type,
        component,
        job: "external",
        run: `external-${yield* shortId}`,
        data: encoded,
      }),
    );
  }),
);

const TIMEOUT = /^(\d+(?:\.\d+)?)(ms|s)$/;
const decodeRequest = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

/** `2s` or `1500ms` as milliseconds; `flag` names it in the error. */
const durationMillis = (flag: string, value: string) => {
  const [, amount = "", unit] = TIMEOUT.exec(value) ?? [];
  return unit === undefined
    ? Effect.fail(new Error(`${flag} ${value}: write it as 2s or 1500ms`))
    : Effect.succeed(Number(amount) * (unit === "s" ? 1000 : 1));
};

/** Request/response: emit the component's request and print its reply, or `none` (exit 1) when none comes in time. The service answers. */
const askCommand = Command.make(
  "ask",
  {
    component: Argument.String("component"),
    data: Argument.String("data").pipe(
      Argument.withDescription("the request as JSON, without requestId"),
    ),
    timeout: Flag.String("timeout").pipe(
      Flag.withDescription("how long to wait for the reply: 2s, 1500ms"),
      Flag.withDefault("5s"),
    ),
  },
  Effect.fnUntraced(function* ({ component, data, timeout }) {
    const agents = yield* (yield* Agents).current;
    const spec = agents.find((candidate) => candidate.id === component);
    if (spec?.asks === undefined)
      return yield* Effect.fail(
        new Error(
          `${component} answers no requests (have: ${agents
            .filter((c) => c.asks)
            .map((c) => c.id)
            .join(", ")})`,
        ),
      );
    const millis = yield* durationMillis("--timeout", timeout);
    const started = yield* Clock.currentTimeMillis;
    const reply = yield* ask(spec, spec.asks, yield* decodeRequest(data), millis).pipe(
      Effect.tapError((error) => (error._tag === "AskTimeout" ? Console.log("none") : Effect.void)),
    );
    const seconds = ((yield* Clock.currentTimeMillis) - started) / 1000;
    yield* Console.log(spec.asks.show(reply.data));
    yield* Console.error(
      `answered in ${seconds.toFixed(2)}s: ${JSON.stringify(reply.data).slice(0, 300)}`,
    );
  }),
);

/**
 * JSON on stdout for tools (the `relay` MCP server's agents_*), and nothing else there: a refused request prints
 * `{error, schema?}` and exits 2 instead of failing, which would log the error with its trace to stdout.
 */
const printJson = <A, E extends { readonly message: string; readonly schema?: unknown }, R>(
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.matchEffect({
      onSuccess: (value) => Console.log(JSON.stringify(value)),
      onFailure: (error) =>
        Console.log(
          JSON.stringify({
            error: error.message,
            ...(error.schema === undefined ? {} : { schema: error.schema }),
          }),
        ).pipe(
          Effect.andThen(
            Effect.sync(() => {
              process.exitCode = 2;
            }),
          ),
        ),
    }),
  );

/** Every agent that answers requests, as JSON: id, purpose, request and reply JSON Schema, model, typical seconds and cost. */
const catalogCommand = Command.make("catalog", {}, () => printJson(Requests.catalog));

const waitFlag = Flag.String("wait").pipe(
  Flag.withDescription("how long to wait for the answer before printing it as running: 40s, 0s"),
  Flag.withDefault("40s"),
);

/** Send a request to any agent (its ask pair, else its job) through the service; prints the run as JSON (`running` with its run id when it outlasts --wait). */
const requestCommand = Command.make(
  "request",
  {
    agent: Argument.String("agent"),
    data: Argument.String("data").pipe(Argument.withDescription("the request as JSON")),
    wait: waitFlag,
    caller: Flag.String("caller").pipe(
      Flag.withDescription("who asks, recorded on the request: agent:nova, an omp session file"),
      Flag.optional,
    ),
  },
  Effect.fnUntraced(function* ({ agent, data, wait, caller }) {
    const millis = yield* durationMillis("--wait", wait);
    yield* printJson(
      Effect.flatMap(
        decodeRequest(data).pipe(
          Effect.mapError(
            (error) =>
              new Requests.RequestError({
                message: `the request is not a JSON object: ${error.message}`,
              }),
          ),
        ),
        (request) => Requests.request(agent, request, millis, Option.getOrUndefined(caller)),
      ),
    );
  }),
);

/** A run as JSON: a request id from `request`, or the job run id of any job run (`runs --every`); waits up to --wait for it to finish. */
const resultCommand = Command.make(
  "result",
  {
    run: Argument.String("run"),
    wait: waitFlag,
  },
  Effect.fnUntraced(function* ({ run, wait }) {
    yield* printJson(Requests.result(run, yield* durationMillis("--wait", wait)));
  }),
);

/**
 * Who used which agent, as JSON: the newest runs sent with `request` (with --every, every other job run too: cron, onEvent, manual, bench;
 * no replies, `result` has them) and each agent's calls, cost and callers over --days.
 */
const runsCommand = Command.make(
  "runs",
  {
    days: Flag.Int("days").pipe(
      Flag.withDescription("the window the per-agent counts cover"),
      Flag.withDefault(7),
    ),
    limit: Flag.Int("limit").pipe(
      Flag.withDescription("how many runs to list, newest first"),
      Flag.withDefault(50),
    ),
    agent: Flag.String("agent").pipe(Flag.withDescription("only this agent's runs"), Flag.optional),
    every: Flag.Boolean("every").pipe(
      Flag.withDescription(
        "also list job runs no request started (cron, onEvent, manual, bench), by their job run id",
      ),
      Flag.withDefault(false),
    ),
  },
  ({ days, limit, agent, every }) =>
    printJson(
      Requests.runs({
        days,
        limit,
        every,
        ...Option.match(agent, { onNone: () => ({}), onSome: (id) => ({ agent: id }) }),
      }),
    ),
);

/**
 * Runs as span trees, from the trace files every process writes (`<home>/traces`, `core/observability/`): newest
 * first (slowest with --slow), one line per span with its model, tool, tokens, cost, duration and error tag.
 */
const tracesCommand = Command.make(
  "traces",
  {
    agent: Flag.String("agent").pipe(Flag.withDescription("only this agent's runs"), Flag.optional),
    run: Flag.String("run").pipe(
      Flag.withDescription("one run: its job run id or request id (a prefix works)"),
      Flag.optional,
    ),
    errors: Flag.Boolean("errors").pipe(
      Flag.withDescription("only runs with a failed span (a fallback that saved the run counts)"),
      Flag.withDefault(false),
    ),
    slow: Flag.Boolean("slow").pipe(
      Flag.withDescription("slowest runs first"),
      Flag.withDefault(false),
    ),
    since: Flag.String("since").pipe(
      Flag.withDescription("how far back: 30m, 1h, 2d (default 24h; with --run, all that is kept)"),
      Flag.optional,
    ),
    limit: Flag.Int("limit").pipe(Flag.withDescription("how many runs"), Flag.withDefault(5)),
    json: Flag.Boolean("json").pipe(
      Flag.withDescription("one JSON line, {traces: [...]}: each run's span tree"),
      Flag.withDefault(false),
    ),
  },
  Effect.fnUntraced(function* ({ agent, run, errors, slow, since, limit, json }) {
    const window = Option.isSome(since)
      ? Traces.parseSince(since.value)
      : Option.isSome(run)
        ? Number.POSITIVE_INFINITY
        : 24 * 3_600_000;
    if (window === undefined)
      return yield* Effect.fail(new Error("--since: write it as 30m, 1h or 2d"));
    const found = Traces.query((yield* Home).root, {
      ...Option.match(agent, { onNone: () => ({}), onSome: (id) => ({ agent: id }) }),
      ...Option.match(run, { onNone: () => ({}), onSome: (id) => ({ run: id }) }),
      errors,
      slow,
      since: (yield* Clock.currentTimeMillis) - window,
      limit,
    });
    if (json) return yield* printJson(Effect.map(found, (traces) => ({ traces })));
    const traces = yield* found;
    yield* Console.log(
      traces.length === 0
        ? `no traces match in ${(yield* Home).root}/${Traces.TRACES_DIR}`
        : traces.map(Traces.render).join("\n\n"),
    );
  }),
);

/**
 * Per agent over a window: last run, runs, failures, fallbacks, each cron job's expected vs actual ticks with the missed
 * ones by reason, what consumers did with requested runs, and whether the service's roster check found it missing.
 */
const healthCommand = Command.make(
  "health",
  {
    since: Flag.String("since").pipe(
      Flag.withDescription("the window: 30m, 1h, 2d"),
      Flag.withDefault("24h"),
    ),
    json: Flag.Boolean("json").pipe(
      Flag.withDescription(
        "one JSON line, {since, now, roster, agents: [{agent, mode, enabled, lastRun, runs, failures, fallbacks, crons, outcomes, missing}]}",
      ),
      Flag.withDefault(false),
    ),
  },
  Effect.fnUntraced(function* ({ since, json }) {
    const window = Traces.parseSince(since);
    if (window === undefined)
      return yield* Effect.fail(new Error("--since: write it as 30m, 1h or 2d"));
    if (json) return yield* printJson(Health.gather(window));
    yield* Console.log(Health.render(yield* Health.gather(window)));
  }),
);

/** A consumer's report of what it did with the answer to its request; the service records it on the run's trace. */
const outcomeCommand = Command.make(
  "outcome",
  {
    requestId: Argument.String("request-id"),
    outcome: Argument.Literals("outcome", Outcome.literals),
    consumer: Flag.String("consumer").pipe(Flag.withDescription("who used the answer")),
    latencyMs: Flag.Int("latency-ms").pipe(
      Flag.withDescription("from the request to the decision"),
      Flag.optional,
    ),
    detail: Flag.String("detail").pipe(Flag.withDescription("one line of context"), Flag.optional),
  },
  Effect.fnUntraced(function* ({ requestId, outcome, consumer, latencyMs, detail }) {
    yield* publishRuntime(
      yield* EventBus,
      "outcome.reported",
      {
        requestId,
        consumer,
        outcome,
        ...Option.match(latencyMs, { onNone: () => ({}), onSome: (ms) => ({ latencyMs: ms }) }),
        ...Option.match(detail, { onNone: () => ({}), onSome: (text) => ({ detail: text }) }),
      },
      "outcome",
    );
    yield* Console.log(`reported ${outcome} by ${consumer} for request ${requestId}`);
  }),
);

const events = Command.make(
  "events",
  {
    type: Flag.String("type").pipe(
      Flag.withDescription("type prefix filter"),
      Flag.withDefault(""),
    ),
    limit: Flag.Int("limit").pipe(Flag.withDefault(30)),
    follow: Flag.Boolean("follow").pipe(Flag.withDefault(false)),
  },
  Effect.fnUntraced(function* ({ type, limit, follow }) {
    const bus = yield* EventBus;
    const history = (yield* bus.history).filter((event) => event.type.startsWith(type));
    yield* Effect.forEach(history.slice(-limit), show);
    if (follow)
      yield* bus.subscribe.pipe(
        Stream.filter((event) => event.type.startsWith(type)),
        Stream.runForEach(show),
      );
  }),
);

/** A new agent file in `<home>/agents`: a working request/reply agent spec to edit, never an existing id. */
const scaffold = (id: string) => ({
  id,
  purpose: "One sentence: what this agent turns its request into.",
  agent: {
    model: "anthropic/claude-haiku-5-5",
    candidates: ["anthropic/claude-haiku-5-5", "anthropic/claude-sonnet-5-5"],
    thinking: "off",
    system: [
      "You are a narrow specialist. Say what you do, what good looks like, and what you never do.",
    ],
  },
  events: {
    [`${id}.requested`]: { requestId: "nonEmptyString", text: "string" },
    [`${id}.ready`]: { requestId: "string", answer: "string" },
  },
  job: {
    id: "answer",
    description: `Answer a ${id}.requested with ${id}.ready.`,
    input: `${id}.requested`,
    triggers: [{ onEvent: `${id}.requested` }, "manual"],
    prompt: "{{text}}",
    answer: { answer: "string" },
    output: `${id}.ready`,
  },
  asks: { request: `${id}.requested`, reply: `${id}.ready`, show: "answer" },
});

const agent = Command.make("agent").pipe(
  Command.withSubcommands([
    Command.make(
      "new",
      { id: Argument.String("id") },
      Effect.fnUntraced(function* ({ id }) {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const file = path.join((yield* Home).root, "agents", `${id}.json`);
        const taken = (yield* (yield* Agents).current).find((candidate) => candidate.id === id);
        if (taken !== undefined)
          return yield* Effect.fail(
            new Error(
              `an agent ${id} exists (${taken.file ?? "code"}); edit or copy that file instead`,
            ),
          );
        if (yield* fs.exists(file)) return yield* Effect.fail(new Error(`${file} exists`));
        const text = `${JSON.stringify(scaffold(id), null, 2)}\n`;
        yield* parseAgent(file, text);
        yield* fs.makeDirectory(path.dirname(file), { recursive: true });
        yield* fs.writeFileString(file, text);
        yield* Console.log(
          `wrote ${file}\nedit purpose, system, events and prompt; check it with: atomic-agents agent validate ${file}\na running service loads it within a second (agent.loaded)`,
        );
      }),
    ),
    Command.make(
      "validate",
      {
        files: Argument.String("file").pipe(
          Argument.withDescription(
            "agent files (an agent folder's AGENT.md); default: every agent in the agent dirs",
          ),
          Argument.variadic(),
        ),
      },
      Effect.fnUntraced(function* ({ files }) {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const agents = yield* Agents;
        const all =
          files.length > 0
            ? files.map((file) => path.resolve(file))
            : yield* agentFiles(agents.dirs);
        let failed = 0;
        for (const file of all) {
          const result = yield* Effect.result(
            fs.readFileString(file).pipe(Effect.flatMap((text) => parseAgent(file, text))),
          );
          if (result._tag === "Success")
            yield* Console.log(
              `ok    ${result.success.agent.id.padEnd(20)} ${result.success.kind.padEnd(6)} ${file}`,
            );
          else {
            failed++;
            yield* Console.log(`FAIL  ${result.failure.message}`);
          }
        }
        if (failed > 0)
          return yield* Effect.fail(new Error(`${failed} of ${all.length} agent file(s) failed`));
      }),
    ),
  ]),
);

/** Orchestrators: one per goal, files in `<home>/orchestrators`; they plan and dispatch, agents and sessions do the work. */
const orch = Command.make("orch").pipe(
  Command.withSubcommands([
    Command.make("list", {}, () =>
      Effect.gen(function* () {
        const orchestrators = yield* Orchestrators;
        const all = yield* orchestrators.current;
        if (all.length === 0) return yield* Console.log(`no orchestrators in ${orchestrators.dir}`);
        for (const orchestrator of all) {
          const { spec } = orchestrator;
          const state = yield* orchestrators.state(orchestrator.id);
          const status =
            state.paused !== null
              ? `paused (${state.paused.rule})`
              : spec.enabled === false
                ? "disabled"
                : "enabled";
          const cadence =
            spec.cadence === "loop"
              ? `loop ${spec.loopSeconds ?? 60}s`
              : `cron "${spec.cadence.cron}"`;
          yield* Console.log(
            `${orchestrator.id.padEnd(20)} ${status.padEnd(18)} ${cadence.padEnd(18)} ${spec.goal}\n${"".padEnd(21)}${orchestrator.file}`,
          );
        }
      }),
    ),
    Command.make(
      "dry-run",
      { id: Argument.String("id") },
      Effect.fnUntraced(function* ({ id }) {
        const orchestrators = yield* Orchestrators;
        const orchestrator = (yield* orchestrators.current).find(
          (candidate) => candidate.id === id,
        );
        const state = yield* orchestrators.state(id);
        const tick = yield* orchestrators.tick(id, "dry");
        const budget = orchestrator?.spec.budget;
        yield* Console.log(`${id}: dry run (nothing written, emitted or dispatched)`);
        yield* Console.log(
          `measure (target ${tick.measure.target}, ${tick.measure.met ? "met" : "not met"}):\n${tick.measure.series.map((point) => `  ${point.label} ${point.value}`).join("\n") || "  (no values)"}`,
        );
        yield* Console.log(
          `stop rules hit (a live tick would pause before planning):\n${tick.stops.map((stop) => `  ${stop.rule} -> ${stop.then}: ${stop.why}`).join("\n") || "  none"}`,
        );
        if (budget !== undefined) {
          yield* Console.log(
            `budget: ${state.runs}/${budget.maxRuns} runs, $${state.usd.toFixed(2)}/$${budget.maxUsd}, ${budget.maxHoursPerDay} session hours/day; paused: ${state.paused === null ? "no" : `${state.paused.rule}: ${state.paused.why}`}`,
          );
        }
        yield* Console.log(
          `pending:\n${tick.pending.map((entry) => `  ${entry.step} ${entry.session} ${entry.finished ? "finished" : "running"}`).join("\n") || "  none"}`,
        );
        yield* Console.log(
          `plan ($${tick.cost.toFixed(4)}):\n${JSON.stringify(tick.plan, null, 2)}`,
        );
        yield* Console.log(
          `would dispatch:\n${tick.dispatches.map((entry) => `  [${entry.step}] ${entry.kind}${entry.error ? ` (SKIPPED: ${entry.error})` : ""}\n    ${entry.what.replaceAll("\n", "\n    ")}`).join("\n") || "  nothing"}`,
        );
      }),
    ),
    Command.make(
      "pause",
      {
        id: Argument.String("id"),
        why: Flag.String("why").pipe(Flag.withDefault("paused by hand")),
      },
      Effect.fnUntraced(function* ({ id, why }) {
        yield* (yield* Orchestrators).pause(id, why);
        yield* Console.log(`${id} paused: ${why}`);
      }),
    ),
    Command.make(
      "resume",
      {
        id: Argument.String("id"),
        by: Flag.String("by").pipe(
          Flag.withDescription("who resumed it (recorded on orchestrator.resumed)"),
          Flag.withDefault(Bun.env["USER"] ?? "cli"),
        ),
      },
      Effect.fnUntraced(function* ({ id, by }) {
        yield* (yield* Orchestrators).resume(id, by);
        yield* Console.log(`${id} resumed by ${by}; runs and USD budget count from zero`);
      }),
    ),
  ]),
);

/** The service: config and agent file watch, triggers, trials, outcomes and the roster check, as background layers; the first fatal error (see `Background`) ends it. */
const Serve = Layer.mergeAll(
  Settings.layerWatch,
  Agents.layerWatch,
  Runner.layerTriggers,
  Orchestrators.layerSchedule,
  layerTrials({ catalogEvery: "1 hour" }),
  Outcomes.layer,
  Roster.layer,
).pipe(Layer.provideMerge(Background.layer));

const serve = Command.make("serve", {}, () =>
  Effect.gen(function* () {
    const home = yield* Home;
    const agents = yield* Agents;
    const orchestrators = yield* Orchestrators;
    yield* Console.log(
      `atomic-agents serving ${(yield* agents.current).length} agent(s) from ${agents.dirs.join(", ")} (live); ${(yield* orchestrators.current).length} orchestrator(s) from ${orchestrators.dir} (live); journal ${home.journal}; config ${(yield* Settings).file} (live)`,
    );
    return yield* FiberSet.join(yield* Background);
  }).pipe(Effect.provide(Serve)),
);

const service = Command.make("service").pipe(
  Command.withSubcommands([
    Command.make(
      "install",
      {
        force: Flag.Boolean("force").pipe(
          Flag.withDescription(
            "install even when the source is not on --base, is dirty or behind the installed commit, or the new copy would drop an agent (the reasons are still printed)",
          ),
          Flag.withDefault(false),
        ),
        base: Flag.String("base").pipe(
          Flag.withDescription("<remote>/<branch> the source checkout must be on (fetched first)"),
          Flag.withDefault("origin/main"),
        ),
        profile: Flag.String("profile").pipe(
          Flag.withDescription(
            "omp profile the service's model calls run under (OMP_PROFILE in the plist); default personal, never the OMP_PROFILE of the shell that installs. An agent's own `profile` overrides it for that agent",
          ),
          Flag.optional,
        ),
      },
      ({ profile, ...options }) =>
        Service.install({ ...options, profile: Option.getOrUndefined(profile) }).pipe(
          Effect.flatMap(
            ({ plist, log, app, commit, agents, overridden, notes, profile: written }) =>
              Console.log(
                [
                  ...notes.map((note) => `note: ${note}`),
                  ...overridden.map((reason) => `forced past: ${reason}`),
                  `installed ${Service.LABEL}${commit === undefined ? "" : ` from ${commit.slice(0, 8)}`}${agents === undefined ? "" : `, ${agents} agent(s) load`}`,
                  `  profile OMP_PROFILE=${written}`,
                  `  app   ${app}`,
                  `  plist ${plist}`,
                  `  log   ${log}`,
                ].join("\n"),
              ),
          ),
        ),
    ),
    Command.make("uninstall", {}, () =>
      Service.uninstall.pipe(
        Effect.flatMap(({ plist }) =>
          Console.log(`uninstalled ${Service.LABEL} (removed ${plist})`),
        ),
      ),
    ),
    Command.make("status", {}, () =>
      Effect.gen(function* () {
        const state = yield* Service.status;
        yield* Console.log(
          `${Service.LABEL}  ${state.state}${state.pid ? `  pid ${state.pid}` : ""}${state.lastExit ? `  last exit ${state.lastExit}` : ""}\n  runs  ${state.command ?? "-"}\n  plist ${state.plist}\n  log   ${state.log}`,
        );
        if (state.state !== "running")
          return yield* Effect.fail(new Error("service is not running"));
      }),
    ),
  ]),
);

const App = Runner.layer.pipe(
  Layer.provideMerge(Orchestrators.layer),
  Layer.provideMerge(Layer.mergeAll(Sessions.layer, Reporter.layer)),
  Layer.provideMerge(Layer.mergeAll(ModelRunner.omp, ModelCatalog.omp)),
  Layer.provideMerge(Settings.layer),
  Layer.provideMerge(Agents.layer),
  Layer.provideMerge(Adapters.make(packs)),
  Layer.provideMerge(EventBus.layer),
  Layer.provideMerge(Tracing.layer()),
  Layer.provideMerge(Home.layer),
  Layer.provideMerge(BunServices.layer),
);

Command.make("atomic-agents").pipe(
  Command.withSubcommands([
    list,
    run,
    bench,
    rate,
    wins,
    use,
    mode,
    trial,
    emit,
    askCommand,
    catalogCommand,
    requestCommand,
    resultCommand,
    runsCommand,
    tracesCommand,
    healthCommand,
    outcomeCommand,
    events,
    agent,
    orch,
    serve,
    service,
  ]),
  Command.run({ version: "0.1.0" }),
  Effect.provide(App),
  BunRuntime.runMain,
);
