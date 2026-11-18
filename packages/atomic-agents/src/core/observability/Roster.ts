import { Effect, FiberSet, Layer, Ref, Schedule } from "effect";
import { Agents } from "../Agent.ts";
import { Background } from "../Background.ts";
import { type ConfigModes, countedOn } from "../InstallGate.ts";
import { Settings } from "../Settings.ts";
import { SPAN } from "./Spans.ts";

/**
 * The roster check: every agent config.json counts on (`countedOn`: mode live or shadow, not `enabled: false`) against
 * the agents this service loaded. A consumer asking an agent the service never loaded hears nothing back, so it stays
 * silent (ecard-main-watch, 2026-11-18: live in config.json, absent from the installed copy). Checked at start and every
 * `CHECK_EVERY`; each absent agent is a warning in the service log on every check, and a `roster.check` trace (a
 * `roster.missing` child per absent agent) is recorded at start and whenever the result changes.
 */
export const CHECK_EVERY = "10 minutes";

export interface Missing {
  readonly id: string;
  readonly why: string;
}

const AGENT_FILE_ENDINGS = [".json", ".yaml", ".yml", "/AGENT.md"];

/** The agents `config` counts on that are not `loaded`, and why: a file that fails to load, or no file at all. */
export const missingAgents = (
  loaded: ReadonlyArray<string>,
  rejected: ReadonlyArray<{ readonly file: string; readonly message: string }>,
  config: ConfigModes,
): ReadonlyArray<Missing> =>
  countedOn(config)
    .filter(({ id }) => !loaded.includes(id))
    .map(({ id, mode }) => {
      const failed = rejected.find(({ file }) =>
        AGENT_FILE_ENDINGS.some((ending) => file.endsWith(`/${id}${ending}`)),
      );
      return {
        id,
        why: `config.json mode ${mode}, not loaded: ${failed === undefined ? "no agent file with this id in the agent dirs" : `its file fails to load (${failed.message})`}`,
      };
    });

/** Background layer: the check at start, then every `CHECK_EVERY`. */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const agents = yield* Agents;
    const settings = yield* Settings;
    const background = yield* Background;
    const recorded = yield* Ref.make<string | undefined>(undefined);
    const check = Effect.gen(function* () {
      const config = yield* settings.current;
      const loaded = (yield* agents.current).map((agent) => agent.id);
      const missing = missingAgents(loaded, yield* agents.rejected, config);
      yield* Effect.forEach(
        missing,
        ({ id, why }) => Effect.logWarning(`roster: ${id} is missing: ${why}`),
        { discard: true },
      );
      const result = JSON.stringify(missing);
      if ((yield* Ref.getAndSet(recorded, result)) === result) return;
      yield* Effect.forEach(
        missing,
        ({ id, why }) =>
          Effect.void.pipe(
            Effect.withSpan(SPAN.rosterMissing, {
              attributes: { "roster.agent": id, "roster.why": why },
            }),
          ),
        { discard: true },
      ).pipe(
        Effect.withSpan(SPAN.roster, {
          root: true,
          attributes: {
            "roster.loaded": loaded.length,
            "roster.loaded_ids": loaded.join(","),
            "roster.counted": countedOn(config).length,
            "roster.missing": missing.map(({ id }) => id).join(","),
          },
        }),
      );
    });
    yield* FiberSet.run(background, check.pipe(Effect.repeat(Schedule.spaced(CHECK_EVERY))));
  }),
);
