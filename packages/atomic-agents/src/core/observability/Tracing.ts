import { Clock, Effect, FileSystem, Layer, Path, Tracer } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { OtlpExporter, OtlpSerialization, OtlpTracer } from "effect/observability";
import { Home } from "../Event.ts";
import { SPAN } from "./Spans.ts";
import { fileOf, prune, RETENTION, type Retention, TRACES_DIR } from "./Traces.ts";

/**
 * Root spans that start a trace: a run, a missed cron tick, a roster check. Any other root (a config reload, a CLI
 * publish, a bench call) is not sampled, nor is anything under it. An `outcome.reported` has its run as parent.
 */
const ROOTS: ReadonlySet<string> = new Set([SPAN.run, SPAN.missed, SPAN.roster]);

const PRUNE_EVERY = 10 * 60_000;

/**
 * Local tracing: Effect's own OTLP tracer (`effect/observability`: batching, OTLP/JSON, flush when the process ends)
 * with a file transport. Each batch the exporter would POST to a collector is appended as one line to
 * `<home>/traces/<UTC hour>.jsonl` instead, so no collector or daemon runs; `Traces.ts` reads the files back and
 * prunes them (`retention`) at start and every 10 minutes while batches come in.
 */
export const layer = (retention: Retention = RETENTION) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = path.join((yield* Home).root, TRACES_DIR);
      yield* fs.makeDirectory(dir, { recursive: true });
      let pruned = 0;
      const append = (text: string) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          if (now - pruned >= PRUNE_EVERY) {
            pruned = now;
            yield* prune(dir, now, retention).pipe(
              Effect.provideService(FileSystem.FileSystem, fs),
              Effect.provideService(Path.Path, path),
            );
          }
          const file = path.join(dir, fileOf(now));
          const size = yield* fs.stat(file).pipe(
            Effect.map((info) => Number(info.size)),
            Effect.orElseSucceed(() => 0),
          );
          if (size >= retention.maxHourBytes)
            return yield* Effect.logWarning(`traces: ${file} is full, batch dropped`);
          // One append per batch: the service and CLI runs share the hour's file.
          yield* fs.writeFileString(file, `${text}\n`, { flag: "a" });
        }).pipe(Effect.catch((error) => Effect.logWarning(`traces: ${error.message}`)));
      const toFile = HttpClient.make((request) =>
        Effect.as(
          request.body._tag === "Uint8Array"
            ? append(request.body.text ?? new TextDecoder().decode(request.body.body))
            : Effect.void,
          HttpClientResponse.fromWeb(request, new Response(null, { status: 204 })),
        ),
      );
      return Layer.effect(
        Tracer.Tracer,
        Effect.gen(function* () {
          const otlp = yield* OtlpTracer.make({
            url: `file://${dir}`,
            resource: { serviceName: "atomic-agents" },
            exportInterval: "2 seconds",
          });
          return Tracer.make({
            span: (options) =>
              otlp.span(
                options.parent._tag === "None" && !ROOTS.has(options.name)
                  ? { ...options, sampled: false }
                  : options,
              ),
            context: otlp.context,
          });
        }),
      ).pipe(
        Layer.provide(OtlpExporter.layerFlusher),
        Layer.provide(OtlpSerialization.layerJson),
        Layer.provide(Layer.succeed(HttpClient.HttpClient, toFile)),
      );
    }),
  );
