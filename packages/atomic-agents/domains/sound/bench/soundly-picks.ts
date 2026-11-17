#!/usr/bin/env bun
/**
 * Bake-off for soundly-picks' model step, offline: no Soundly sign-in, so Isaac's app is never touched.
 *
 *     bun domains/sound/bench/soundly-picks.ts [--models a,b] [--concurrency 4]
 *
 * Replays the searches real runs recorded in `<home>/state/sound/searches.json` (query, count, Soundly's candidates)
 * through the agent's own prompt and reply check (`SYSTEM`, `promptFor`, `readPicks`, one repair turn), once per model
 * (default: the agent's candidates). Per model: usable replies, exact count, varied sets (at most two takes of one
 * recording), mean Soundly rank of the picks (1 is Soundly's top hit), p50 seconds, $/case. Which picks sound right is
 * Isaac's call: the answers (with titles) go to `<home>/bench/soundly-picks/results-<stamp>.json` for him to compare.
 */
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Clock, Console, Effect, FileSystem, Layer, Path } from "effect";
import { Adapters } from "../../../src/core/Adapter.ts";
import { Agents } from "../../../src/core/Agent.ts";
import { EventBus, Home } from "../../../src/core/Event.ts";
import { ModelRunner } from "../../../src/core/Model.ts";
import { effective, Settings } from "../../../src/core/Settings.ts";
import { packs } from "../../../src/packs.ts";
import { readSearches, soundStateDir } from "../adapters/ledger.ts";
import { promptFor, readPicks, SYSTEM } from "../soundly-picks.ts";

/** One recording's takes share a name up to a trailing number, take letter or mic suffix. */
const recordingOf = (name: string) =>
  name
    .replace(/\.(wav|aiff?|flac|mp3|ogg|m4a|caf)$/i, "")
    .replace(/([\s_-]+(\d+|[A-Z]|take\s*\d+|mic\s*\w+))+$/i, "")
    .toLowerCase();

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* Home;
  const args = process.argv.slice(2);
  const flag = (name: string) => {
    const at = args.indexOf(`--${name}`);
    return at < 0 ? undefined : args[at + 1];
  };
  const agent = (yield* (yield* Agents).current).find(
    (candidate) => candidate.id === "soundly-picks",
  );
  if (agent === undefined) return yield* Console.error("soundly-picks is not loaded");
  const resolved = effective(agent, yield* (yield* Settings).current).agent;
  const models = flag("models")?.split(",") ?? resolved.candidates;
  const cases = yield* readSearches(soundStateDir(path, home.stateDir("soundly-picks")));
  if (cases.length === 0)
    return yield* Console.error(
      "no recorded searches yet: every soundly-picks run adds its search to <home>/state/sound/searches.json",
    );
  yield* Console.log(`soundly-picks: ${cases.length} recorded searches on ${models.join(", ")}\n`);
  const runner = yield* ModelRunner;

  const results = yield* Effect.forEach(
    models,
    (model) =>
      Effect.forEach(
        cases,
        (search) =>
          Effect.gen(function* () {
            const want = Math.min(search.count, search.candidates.length);
            const prompt = promptFor(search.query, want, search.candidates);
            const ask = (text: string) =>
              runner.generate({ model, system: SYSTEM, prompt: text, timeout: "90 seconds" });
            const first = yield* ask(prompt);
            let reply = readPicks(first.text, search.candidates, want);
            let cost = first.cost;
            let seconds = first.seconds;
            let attempts = 1;
            if (reply.problems.length > 0) {
              const second = yield* ask(
                `${prompt}\n\nYour reply was:\n${first.text}\n\nIt was rejected: ${reply.problems.join("; ")}. Reply again with the JSON object only.`,
              );
              reply = readPicks(second.text, search.candidates, want);
              cost += second.cost;
              seconds += second.seconds;
              attempts = 2;
            }
            const rank = new Map(search.candidates.map((match, index) => [match.id, index + 1]));
            const names = new Map(search.candidates.map((match) => [match.id, match.name]));
            const takes = new Map<string, number>();
            for (const id of reply.picks) {
              const recording = recordingOf(names.get(id) ?? id);
              takes.set(recording, (takes.get(recording) ?? 0) + 1);
            }
            return {
              model,
              query: search.query,
              usable: reply.problems.length === 0,
              exact: reply.picks.length === want,
              varied: Math.max(0, ...takes.values()) <= 2,
              meanRank:
                reply.picks.reduce(
                  (sum, id) => sum + (rank.get(id) ?? search.candidates.length),
                  0,
                ) / Math.max(1, reply.picks.length),
              attempts,
              seconds,
              cost,
              picks: reply.picks.map((id) => names.get(id) ?? id),
              error: undefined as string | undefined,
            };
          }).pipe(
            Effect.catch((error) =>
              Effect.succeed({
                model,
                query: search.query,
                usable: false,
                exact: false,
                varied: false,
                meanRank: Number.NaN,
                attempts: 0,
                seconds: 0,
                cost: 0,
                picks: [] as ReadonlyArray<string>,
                error: error.message as string | undefined,
              }),
            ),
          ),
        { concurrency: Number(flag("concurrency") ?? "4") },
      ),
    { concurrency: "unbounded" },
  );

  const p50 = (values: ReadonlyArray<number>) =>
    [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? Number.NaN;
  yield* Console.log(
    ["model".padEnd(36), "usable", "exact", "varied", "rank", "p50 s", "$/case", "errors"].join(
      "  ",
    ),
  );
  for (const rows of results) {
    const done = rows.filter((row) => row.error === undefined);
    const count = (pick: (row: (typeof rows)[number]) => boolean) =>
      `${rows.filter(pick).length}/${rows.length}`.padStart(6);
    yield* Console.log(
      [
        rows[0]!.model.padEnd(36),
        count((row) => row.usable),
        count((row) => row.exact).padStart(5),
        count((row) => row.varied),
        (done.reduce((sum, row) => sum + row.meanRank, 0) / Math.max(1, done.length))
          .toFixed(1)
          .padStart(4),
        p50(done.map((row) => row.seconds))
          .toFixed(1)
          .padStart(5),
        (done.reduce((sum, row) => sum + row.cost, 0) / Math.max(1, done.length))
          .toFixed(4)
          .padStart(6),
        String(rows.length - done.length).padStart(6),
      ].join("  "),
    );
  }
  const dir = path.join(home.root, "bench", "soundly-picks");
  yield* fs.makeDirectory(dir, { recursive: true });
  const stamp = new Date(yield* Clock.currentTimeMillis).toISOString().replace(/[:.]/g, "-");
  const out = path.join(dir, `results-${stamp}.json`);
  yield* fs.writeFileString(out, `${JSON.stringify(results.flat(), null, 1)}\n`);
  yield* Console.log(`\nanswers: ${out}`);
});

program.pipe(
  Effect.provide(
    ModelRunner.omp.pipe(
      Layer.provideMerge(Settings.layer),
      Layer.provideMerge(Agents.layer),
      Layer.provideMerge(Adapters.make(packs)),
      Layer.provideMerge(EventBus.layer),
      Layer.provideMerge(Home.layer),
      Layer.provideMerge(BunServices.layer),
    ),
  ),
  BunRuntime.runMain,
);
