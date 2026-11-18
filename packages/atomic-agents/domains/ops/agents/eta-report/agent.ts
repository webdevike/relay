import { Clock, Context, Effect, FileSystem, Layer, Path, Schema } from "effect";
import { ChildProcessSpawner } from "effect/process";
import { EvaRoot } from "../../../../src/core/adapters/eva.ts";
import { type Component, define, job, Trigger } from "../../../../src/core/Component.ts";
import { exec } from "../../../../src/core/exec.ts";
import {
  BaselineJson,
  baselineOf,
  Change,
  compare,
  EstimatesJson,
  message,
  type Report,
  Saved,
  section,
  summarize,
  Week,
  withSection,
} from "./compute.ts";

/**
 * `kind: "code"` agent (`../eta-report.json`): Nova's weekly estimate-vs-actual report as a packaged job, no model.
 * The agent exists for its packaged instructions (`INSTRUCTIONS.md`) and observability (traces, health, missed-tick
 * checks), not for judgment: every Wednesday 09:00 (host local time, America/New_York; `config.json`
 * `components.eta-report.cron.report` overrides it) the runtime runs `report`, which reads Eva's `agent-session.ts
 * estimates`, computes the numbers (`compute.ts`), tells Nova's thread, rewrites the `Last week` section of
 * `estimates.md`, keeps the numbers for next week and emits `ops.eta-report`.
 */

export class EtaReportError extends Schema.TaggedError<EtaReportError>()("EtaReportError", {
  message: Schema.String,
}) {}

/** The window the report covers, and the longer one `--baseline` context comes from. */
export const SINCE = "7d";
const BASELINE_SINCE = "30d";
/** Whose runs are reported, and whose thread gets the message. */
export const OWNER = "nova";

/** Eva's tools the report calls: the estimates reader and the thread line, so a test fakes both. */
export class EtaSources extends Context.Service<
  EtaSources,
  {
    /** stdout of `agent-session.ts estimates <args>`. */
    estimates(args: ReadonlyArray<string>): Effect.Effect<string, EtaReportError>;
    /** `<EVA_ROOT>/work/eva/agents/<owner>/estimates.md`, the notes whose `Last week` section the report rewrites. */
    notesFile(owner: string): string;
    /** `eva-thread.ts --agent <owner> <message>`. */
    tell(owner: string, text: string): Effect.Effect<void, EtaReportError>;
  }
>()("atomic-agents/ops/EtaSources") {
  static readonly layer = Layer.effect(
    EtaSources,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const root = yield* EvaRoot;
      const path = yield* Path.Path;
      const bun = (script: string, args: ReadonlyArray<string>) => {
        const file = path.join(root, ".omp/tools", script);
        return exec(process.execPath, [file, ...args]).pipe(
          Effect.timeoutOrElse({
            duration: "120 seconds",
            orElse: () =>
              Effect.fail(new EtaReportError({ message: `${script} ${args[0] ?? ""} timed out` })),
          }),
          Effect.catchTag("PlatformError", (error) =>
            Effect.fail(new EtaReportError({ message: error.message })),
          ),
          Effect.flatMap((result) =>
            result.exitCode === 0
              ? Effect.succeed(result.stdout)
              : Effect.fail(
                  new EtaReportError({
                    message: `${script} ${args[0] ?? ""} exited ${result.exitCode}: ${(result.stderr || result.stdout).trim().slice(-300)}`,
                  }),
                ),
          ),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        );
      };
      return EtaSources.of({
        estimates: (args) => bun("agent-session.ts", ["estimates", ...args]),
        notesFile: (owner) => path.join(root, "work/eva/agents", owner, "estimates.md"),
        tell: (owner, text) => bun("eva-thread.ts", ["--agent", owner, text]).pipe(Effect.asVoid),
      });
    }),
  );
}

const events = {
  /** The week's numbers, once per run; Eva and Relay read them from the journal. */
  "ops.eta-report": Schema.Struct({
    owner: Schema.String,
    /** The window, as the `--since` it was read with. */
    since: Schema.String,
    /** ISO time the report ran. */
    at: Schema.String,
    /** Finished runs with an estimate in the window. */
    n: Schema.Int,
    /** Median actual / estimate; absent when `n` is 0. */
    medianRatio: Schema.optionalKey(Schema.Finite),
    /** Share (0-1) of runs within 1 +- 0.5 of their estimate; absent when `n` is 0. */
    within50: Schema.optionalKey(Schema.Finite),
    /** The job kind whose median ratio is furthest from 1. */
    worstKind: Schema.optionalKey(Week.fields.worstKind),
    /** Against the saved week; absent on the first report or when either week had no estimates. */
    change: Schema.optionalKey(Change),
    /** `--baseline` context: the owner's finished runs over 30 days and their median wall time. */
    baseline: Schema.optionalKey(Schema.Struct({ n: Schema.Int, medianMinutes: Schema.Finite })),
    /** The thread message sent (without its `[eta-report] ` prefix). */
    summary: Schema.String,
  }),
};

const decode = <S extends Schema.Decoder<unknown>>(schema: S, text: string, what: string) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(text).pipe(
    Effect.mapError((error) => new EtaReportError({ message: `${what}: ${error.message}` })),
  );

const report = job(events, {
  id: "report",
  description:
    "Weekly: read Nova's estimate-vs-actual runs of the last 7 days (`agent-session.ts estimates --owner nova --since 7d --json`, plus `--baseline`), compute the median ratio, the share within ±50% and the worst job kind, compare with last week's saved numbers, tell Nova's thread, rewrite estimates.md's `Last week` section and emit `ops.eta-report`. No model.",
  input: Schema.Struct({}),
  triggers: [Trigger.Manual(), Trigger.Cron({ cron: "0 9 * * 3", input: Effect.succeed({}) })],
  run: Effect.fnUntraced(function* (_, ctx) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const sources = yield* EtaSources;
    const failed = (file: string) => (error: { readonly message: string }) =>
      new EtaReportError({ message: `${file}: ${error.message}` });

    const estimates = yield* decode(
      EstimatesJson,
      yield* sources.estimates(["--owner", OWNER, "--since", SINCE, "--json"]),
      "estimates --json",
    );
    const baseline = baselineOf(
      yield* decode(
        BaselineJson,
        yield* sources.estimates([
          "--owner",
          OWNER,
          "--since",
          BASELINE_SINCE,
          "--baseline",
          "--json",
        ]),
        "estimates --baseline --json",
      ),
      OWNER,
    );

    const savedFile = path.join(ctx.stateDir, "last-week.json");
    const saved = (yield* fs.exists(savedFile).pipe(Effect.mapError(failed(savedFile))))
      ? yield* fs.readFileString(savedFile).pipe(
          Effect.mapError(failed(savedFile)),
          Effect.flatMap((text) => decode(Saved, text, savedFile)),
        )
      : undefined;

    const now = yield* Clock.currentTimeMillis;
    const at = new Date(now).toISOString();
    const week = summarize(estimates.runs);
    const change = compare(week, saved?.week);
    const view: Report = {
      week,
      change,
      baseline,
      date: at.slice(0, 10),
      since: SINCE,
      owner: OWNER,
    };
    const text = message(view);

    const notes = sources.notesFile(OWNER);
    const current = yield* fs.readFileString(notes).pipe(Effect.mapError(failed(notes)));
    yield* fs
      .writeFileString(notes, withSection(current, section(view)))
      .pipe(Effect.mapError(failed(notes)));

    yield* sources.tell(OWNER, `[eta-report] ${text}`);

    // Kept only once the report went out, so a failed run is not compared against next week.
    yield* fs
      .writeFileString(savedFile, `${JSON.stringify({ at, week } satisfies Saved, null, 2)}\n`)
      .pipe(Effect.mapError(failed(savedFile)));
    yield* ctx.emit("ops.eta-report", {
      owner: OWNER,
      since: SINCE,
      at,
      n: week.n,
      ...(week.medianRatio === undefined ? {} : { medianRatio: week.medianRatio }),
      ...(week.within50 === undefined ? {} : { within50: week.within50 }),
      ...(week.worstKind === undefined ? {} : { worstKind: week.worstKind }),
      ...(change === undefined ? {} : { change }),
      ...(baseline === undefined ? {} : { baseline }),
      summary: text,
    });
  }),
});

export const spec = {
  id: "eta-report",
  events,
  purpose:
    "Every Wednesday morning, report how Nova's delegated-work estimates compared with actual run times, to Nova's thread and estimates.md.",
  agent: {
    // No model calls: the report is a fixed read and a computation. Kept for the Component shape.
    model: "anthropic/claude-haiku-5-5",
    candidates: ["anthropic/claude-haiku-5-5"],
    system: "",
  },
  jobs: [report],
  tools: EtaSources.layer,
} satisfies Component<EtaSources>;

export default define(spec);
