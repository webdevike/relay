import {
  Clock,
  Cron,
  Duration,
  Effect,
  FiberSet,
  FileSystem,
  Option,
  Path,
  Ref,
  Result,
  Schema,
} from "effect";
import { Background } from "./Background.ts";
import { Home, type JournalError } from "./Event.ts";
import type { ComponentDisabled, NoToolMode, RunOptions, UnknownJob } from "./Runtime.ts";
import { SPAN } from "./observability/Spans.ts";

/**
 * Cron triggers with every expected tick accounted for (`Runner.layerTriggers` arms one per cron job of an enabled
 * agent). Each tick due starts one run, which carries `run.trigger: cron` and the tick (`schedule.expected`) on its
 * span. A tick that starts no run is a `schedule.missed` trace (`schedule.reason`):
 * - `down`: it fell while no service had the job armed (found at the next start from the last tick handled, kept in
 *   `<home>/state/schedule/<agent>.<job>.json`; forgotten when the job is disarmed, so a disabled agent owes nothing);
 * - `late`: the service woke past it and a later tick was already due (the Mac slept, the process stalled): only the
 *   latest one runs;
 * - `busy`: the previous tick's run has not ended;
 * - `not-started`: the run was refused (unknown job, disabled, bad tool mode) or its input failed;
 * - `hung`: the run has not ended `RUN_DEADLINE_MS` after its tick. It is recorded, not interrupted.
 */

/** A tick missed while the service was down counts once it is this far past. */
export const GRACE_MS = 60_000;
/** A cron run with no end this long after its tick is hung (still running, or queued behind another run of the agent). */
export const RUN_DEADLINE_MS = 30 * 60_000;
/** How far back a gap in the service is counted. */
const LOOKBACK_MS = 7 * 24 * 3_600_000;
const MAX_TICKS = 100_000;

export type MissedReason = "down" | "late" | "busy" | "not-started" | "hung";

/** The ticks of `cron` after `from` up to and including `to`, oldest first. */
export const ticksBetween = (cron: Cron.Cron, from: number, to: number): ReadonlyArray<number> => {
  const ticks: Array<number> = [];
  for (
    let at = Cron.next(cron, from).getTime();
    at <= to && ticks.length < MAX_TICKS;
    at = Cron.next(cron, at).getTime()
  )
    ticks.push(at);
  return ticks;
};

export interface CronEntry {
  readonly component: string;
  readonly job: string;
  readonly cron: string;
  readonly input: Effect.Effect<unknown>;
}

/** Starts the job's run for one tick: `Runner.run` with `schedule` set. */
export type StartRun = (
  input: unknown,
  schedule: NonNullable<RunOptions["schedule"]>,
) => Effect.Effect<unknown, UnknownJob | ComponentDisabled | NoToolMode | JournalError>;

const State = Schema.Struct({ cron: Schema.String, expected: Schema.Number });
const decodeState = Schema.decodeUnknownOption(Schema.fromJsonString(State));

const iso = (millis: number) => new Date(millis).toISOString();
const minutes = (millis: number) => `${Math.round(millis / 60_000)} min`;
const stateDir = Effect.gen(function* () {
  return (yield* Home).stateDir("schedule");
});

/** `ticks` of `entry` that started no run, as one `schedule.missed` trace (and a warning in the service log). */
const missed = (
  entry: CronEntry,
  reason: MissedReason,
  ticks: ReadonlyArray<number>,
  detail: string,
) =>
  Effect.logWarning(
    `${entry.component}/${entry.job} cron "${entry.cron}": ${ticks.length} tick(s) missed (${reason}): ${detail}`,
  ).pipe(
    Effect.withSpan(SPAN.missed, {
      root: true,
      attributes: {
        "agent.id": entry.component,
        "agent.job": entry.job,
        "schedule.cron": entry.cron,
        "schedule.reason": reason,
        "schedule.count": ticks.length,
        "schedule.expected": ticks[0],
        "schedule.last": ticks[ticks.length - 1],
        "schedule.detail": detail,
      },
    }),
  );

/** Drop the saved ticks of every job not in `armed`: a job armed again later starts with no gap to account for. */
export const forget = (armed: ReadonlyArray<Pick<CronEntry, "component" | "job">>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* stateDir;
    const keep = new Set(armed.map((entry) => `${entry.component}.${entry.job}.json`));
    const names = yield* fs.readDirectory(dir).pipe(Effect.orElseSucceed(() => []));
    yield* Effect.forEach(
      names.filter((name) => !keep.has(name)),
      (name) => fs.remove(path.join(dir, name), { force: true }).pipe(Effect.ignore),
      { discard: true },
    );
  });

/**
 * Run `entry` on its cron until interrupted (a re-arm), accounting for every tick (see the module doc). A run outlives
 * the arm that started it: it runs in the `Background` set, so only a `JournalError` from it ends the service.
 */
export const arm = (entry: CronEntry, start: StartRun, deadlineMs = RUN_DEADLINE_MS) =>
  Effect.gen(function* () {
    const parsed = Cron.parse(entry.cron);
    // config.json and agent file crons are validated before they apply; this catches a bad code default.
    if (Result.isFailure(parsed))
      return yield* Effect.logError(
        `bad cron "${entry.cron}" for ${entry.component}/${entry.job}: ${parsed.failure.message}`,
      );
    const cron = parsed.success;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const background = yield* Background;
    const dir = yield* stateDir;
    const file = path.join(dir, `${entry.component}.${entry.job}.json`);
    const save = (expected: number) =>
      fs.makeDirectory(dir, { recursive: true }).pipe(
        Effect.andThen(fs.writeFileString(file, JSON.stringify({ cron: entry.cron, expected }))),
        Effect.catch((error) =>
          Effect.logWarning(`schedule: cannot save ${file}: ${error.message}`),
        ),
      );

    const armedAt = yield* Clock.currentTimeMillis;
    const saved = Option.flatMap(yield* Effect.option(fs.readFileString(file)), decodeState);
    if (Option.isSome(saved) && saved.value.cron === entry.cron) {
      const lost = ticksBetween(
        cron,
        Math.max(saved.value.expected, armedAt - LOOKBACK_MS),
        armedAt - GRACE_MS,
      );
      if (lost.length > 0)
        yield* missed(
          entry,
          "down",
          lost,
          `no service had it armed (last tick handled ${iso(saved.value.expected)})`,
        );
    }

    /** The tick whose run has not ended yet. */
    const running = yield* Ref.make(Option.none<number>());
    const notStarted = (expected: number) => (error: { readonly message: string }) =>
      missed(entry, "not-started", [expected], error.message);
    const runTick = (expected: number) =>
      Effect.raceFirst(
        entry.input.pipe(
          Effect.flatMap((input) => start(input, { cron: entry.cron, expected })),
          Effect.asVoid,
          Effect.catchTags({
            UnknownJob: notStarted(expected),
            ComponentDisabled: notStarted(expected),
            NoToolMode: notStarted(expected),
          }),
          Effect.catchDefect((defect) => notStarted(expected)({ message: String(defect) })),
        ),
        // The watchdog never wins: it records the hang and waits for the run.
        Effect.sleep(Duration.millis(deadlineMs)).pipe(
          Effect.andThen(
            missed(
              entry,
              "hung",
              [expected],
              `no end ${minutes(deadlineMs)} after the tick (still running, or queued behind another run of ${entry.component})`,
            ),
          ),
          Effect.andThen(Effect.never),
        ),
      ).pipe(Effect.ensuring(Ref.set(running, Option.none())));

    let last = armedAt;
    for (;;) {
      const next = Cron.next(cron, last).getTime();
      yield* Effect.sleep(Duration.millis(Math.max(0, next - (yield* Clock.currentTimeMillis))));
      const woke = yield* Clock.currentTimeMillis;
      const later = ticksBetween(cron, next, woke);
      const expected = later[later.length - 1] ?? next;
      last = expected;
      if (later.length > 0)
        yield* missed(
          entry,
          "late",
          [next, ...later.slice(0, -1)],
          `the service woke ${minutes(woke - next)} after ${iso(next)} (the Mac slept or the process stalled); only ${iso(expected)} ran`,
        );
      yield* save(expected);
      const busy = yield* Ref.get(running);
      if (Option.isSome(busy)) {
        yield* missed(entry, "busy", [expected], `the run for ${iso(busy.value)} has not ended`);
        continue;
      }
      yield* Ref.set(running, Option.some(expected));
      yield* FiberSet.run(background, runTick(expected));
    }
  });
