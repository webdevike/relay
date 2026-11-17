import { Context, Effect, Layer, Schema } from "effect";
import { ChildProcessSpawner } from "effect/process";
import { exec } from "./exec.ts";
import type { CatalogModel } from "./Trial.ts";

export class CatalogError extends Schema.TaggedError<CatalogError>()("CatalogError", {
  message: Schema.String,
}) {}

const OmpModels = Schema.Struct({
  models: Schema.Array(
    Schema.Struct({
      provider: Schema.String,
      kind: Schema.optionalKey(Schema.String),
      selector: Schema.String,
      name: Schema.String,
    }),
  ),
});
const decodeOmpModels = Schema.decodeUnknownEffect(Schema.fromJsonString(OmpModels));

/** Providers that run on this Mac: never a release to try. */
const LOCAL = /(^apple$|-local$)/;

/**
 * The chat models the providers offer now, as omp lists them (`omp models --json`, after `omp models refresh` fetched
 * the providers' own lists), so a model released today shows up without a code change. `TrialService` diffs it against
 * the last list it saw to start a fresh trial with each new one.
 */
export class ModelCatalog extends Context.Service<
  ModelCatalog,
  {
    /** What omp lists from its own cache, without asking the providers. */
    readonly cached: Effect.Effect<ReadonlyArray<CatalogModel>, CatalogError>;
    /** The providers' lists now: `omp models refresh` first (a failed refresh lists the cache). */
    readonly list: Effect.Effect<ReadonlyArray<CatalogModel>, CatalogError>;
  }
>()("atomic-agents/ModelCatalog") {
  static readonly omp = Layer.effect(
    ModelCatalog,
    Effect.gen(function* () {
      const services = yield* Effect.context<ChildProcessSpawner.ChildProcessSpawner>();
      const run = (args: ReadonlyArray<string>) =>
        exec("omp", args).pipe(
          Effect.provideContext(services),
          Effect.mapError(
            (error) => new CatalogError({ message: `omp ${args.join(" ")}: ${error.message}` }),
          ),
        );
      const cached = Effect.gen(function* () {
        const listed = yield* run(["models", "--json"]);
        if (listed.exitCode !== 0)
          return yield* new CatalogError({
            message: `omp models --json exited ${listed.exitCode}: ${listed.stderr.slice(0, 500)}`,
          });
        const { models } = yield* decodeOmpModels(listed.stdout).pipe(
          Effect.mapError(
            (error) => new CatalogError({ message: `omp models --json: ${error.message}` }),
          ),
        );
        return models
          .filter((model) => (model.kind ?? "chat") === "chat" && !LOCAL.test(model.provider))
          .map(({ selector, name, provider }) => ({ selector, name, provider }));
      });
      return ModelCatalog.of({
        cached,
        list: Effect.gen(function* () {
          const refreshed = yield* run(["models", "refresh"]).pipe(
            Effect.timeout("2 minutes"),
            Effect.result,
          );
          if (refreshed._tag === "Failure")
            yield* Effect.logWarning(`omp models refresh: ${String(refreshed.failure)}`);
          return yield* cached;
        }),
      });
    }),
  );
}
