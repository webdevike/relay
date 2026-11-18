import { Clock, Effect, FiberSet, Layer, Schedule, Schema, Stream, Tracer } from "effect";
import { Background } from "../Background.ts";
import { EventBus, Home } from "../Event.ts";
import { Runner, type RunSpan } from "../Runtime.ts";
import { events, RUNTIME } from "../RuntimeEvents.ts";
import { SPAN } from "./Spans.ts";
import * as Traces from "./Traces.ts";

/**
 * Outcomes: a consumer that asked an agent (Relay Host's widget pass, any caller of `atomic-agents outcome`) appends
 * `atomic-agents/outcome.reported` with the request id it sent and what it did with the answer. The service records
 * it as an `outcome.reported` span under that run's root, so the run's trace says whether its answer was used.
 * `Traces.outcomeOf` reads it back (`pending` / `unknown` for a run nobody reported on).
 */
const OUTCOME = `${RUNTIME}/outcome.reported`;
const decodeOutcome = Schema.decodeUnknownEffect(events["outcome.reported"]);
type Reported = (typeof events)["outcome.reported"]["Type"];

/** How far back an outcome looks for its run on disk (the runner remembers only the runs this process started). */
const LOOKBACK_MS = 24 * 3_600_000;

/** The span recorded on the run's trace, its parent the run's root. */
export const recordOutcome = (run: RunSpan, reported: Reported) =>
  Effect.void.pipe(
    Effect.withSpan(SPAN.outcome, {
      parent: Tracer.externalSpan({ traceId: run.traceId, spanId: run.spanId, sampled: true }),
      attributes: {
        "agent.id": run.agent,
        "agent.run": run.run,
        "agent.request": reported.requestId,
        "outcome.value": reported.outcome,
        "outcome.consumer": reported.consumer,
        ...(reported.latencyMs === undefined ? {} : { "outcome.latency_ms": reported.latencyMs }),
        ...(reported.detail === undefined ? {} : { "outcome.detail": reported.detail }),
      },
    }),
  );

/**
 * Background layer: every `outcome.reported` on the bus lands on its run's trace. The run is found in the runner's
 * memory, else (the service restarted since) in the trace files once its root is flushed (every 2 s; retried for
 * 15 s). An outcome whose run is in neither is logged and dropped.
 */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const runner = yield* Runner;
    const bus = yield* EventBus;
    const home = yield* Home;
    const background = yield* Background;

    const onDisk = (requestId: string) =>
      Effect.gen(function* () {
        const since = (yield* Clock.currentTimeMillis) - LOOKBACK_MS;
        const found = (yield* Traces.query(home.root, { run: requestId, since, limit: 50 })).find(
          (trace) => !trace.open && trace.root.attributes["agent.request"] === requestId,
        );
        if (found === undefined)
          return yield* Effect.fail(`no closed run for request ${requestId}`);
        return {
          traceId: found.traceId,
          spanId: found.root.spanId,
          agent: String(found.root.attributes["agent.id"]),
          run: String(found.root.attributes["agent.run"]),
        } satisfies RunSpan;
      }).pipe(Effect.retry({ schedule: Schedule.spaced("3 seconds"), times: 5 }));

    const handle = (data: unknown) =>
      decodeOutcome(data).pipe(
        Effect.flatMap((reported) =>
          runner.spanOf(reported.requestId).pipe(
            Effect.flatMap((remembered) =>
              remembered._tag === "Some"
                ? Effect.succeed(remembered.value)
                : onDisk(reported.requestId),
            ),
            Effect.flatMap((run) => recordOutcome(run, reported)),
            Effect.catch((error) =>
              Effect.logWarning(
                `outcome ${reported.outcome} by ${reported.consumer} dropped: ${typeof error === "string" ? error : error.message}`,
              ),
            ),
          ),
        ),
        Effect.catchTag("SchemaError", (error) =>
          Effect.logWarning(`bad ${OUTCOME}: ${error.message}`),
        ),
      );

    yield* FiberSet.run(
      background,
      (yield* bus.listen).pipe(
        Stream.filter((event) => event.type === OUTCOME),
        Stream.runForEach((event) => FiberSet.run(background, handle(event.data))),
      ),
    );
  }),
);
