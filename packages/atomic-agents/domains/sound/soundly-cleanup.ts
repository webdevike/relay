import { Clock, Effect, Path, Schema } from "effect";
import { type Component, define, job, Trigger } from "../../src/core/Component.ts";
import { due, readLedger, soundStateDir, sweep, TTL_HOURS } from "./adapters/ledger.ts";
import { AppState, Soundly, SoundlyBusy, SoundlyError } from "./adapters/soundly.ts";

/**
 * `kind: "code"` agent (`soundly-cleanup.json`): deletes the temporary "Eva picks: " collections soundly-picks made,
 * never any other (`sweep`: the name prefix and the account's own collections only). No model. Same session rules as
 * soundly-picks: one sign-in, Soundly quit and relaunched hidden when open, never while Isaac is using it.
 * - Cron (hourly): signs in only when the ledger holds a collection older than the TTL, and gives up at once (until the
 *   next hour) while Isaac is using Soundly.
 * - Manual: always signs in (so it also finds Eva picks collections the ledger does not know), waiting up to 15 minutes
 *   for Isaac to leave Soundly; `all` deletes every Eva picks collection whatever its age.
 */

const events = {
  "collections.swept": Schema.Struct({
    /** Deleted collection names. */
    removed: Schema.Array(Schema.String),
    /** Isaac's Soundly app around the run; absent when no sign-in happened. */
    soundly: Schema.optionalKey(AppState),
    /** Why the hourly run left it for the next hour (Isaac was using Soundly). */
    deferred: Schema.optionalKey(Schema.String),
  }),
};

const sweepJob = job(events, {
  id: "sweep",
  description: `Delete Eva picks collections older than ${TTL_HOURS} h (or every one with \`all\`), plus any the ledger does not know. Never touches other collections; hands Soundly back signed in as soundly-picks does.`,
  input: Schema.Struct({
    all: Schema.optionalKey(
      Schema.Boolean.annotate({
        description: "Every Eva picks collection, whatever its age (Isaac has picked).",
      }),
    ),
    olderThanHours: Schema.optionalKey(Schema.Number.check(Schema.isGreaterThanOrEqualTo(0))),
    scheduled: Schema.optionalKey(
      Schema.Boolean.annotate({
        description: "The hourly run: only when something is due, and no waiting for Isaac.",
      }),
    ),
  }),
  triggers: [
    Trigger.Manual(),
    Trigger.Cron({ cron: "15 * * * *", input: Effect.succeed({ scheduled: true }) }),
  ],
  run: Effect.fnUntraced(function* (input, ctx) {
    const path = yield* Path.Path;
    const soundly = yield* Soundly;
    const dir = soundStateDir(path, ctx.stateDir);
    const now = yield* Clock.currentTimeMillis;
    const scheduled = input.scheduled === true;
    // Nothing due on the hourly run: no sign-in, so the app is never touched.
    if (scheduled && due(yield* readLedger(dir), now, input).length === 0)
      return yield* ctx.emit("collections.swept", { removed: [] });
    const session = soundly.session(dir, (api) => sweep(api, dir, { ...input, now }), {
      patienceMs: scheduled ? 0 : 15 * 60_000,
    });
    const swept = yield* scheduled
      ? Effect.catchTag(session, "SoundlyBusy", (busy) => Effect.succeed(busy))
      : session;
    if (swept instanceof SoundlyBusy)
      return yield* ctx.emit("collections.swept", { removed: [], deferred: swept.message });
    const { value, app } = swept;
    yield* ctx.emit("collections.swept", { removed: [...value], soundly: app });
    if (app.problem !== undefined) return yield* new SoundlyError({ message: app.problem });
  }),
});

export const spec = {
  id: "soundly-cleanup",
  events,
  purpose:
    "Delete the temporary Eva picks collections in Soundly once they are a day old (or all of them), never any other collection.",
  agent: {
    // No model calls: a fixed sweep. Kept for the Component shape.
    model: "anthropic/claude-haiku-5-5",
    candidates: ["anthropic/claude-haiku-5-5"],
    system: "",
  },
  jobs: [sweepJob],
  tools: Soundly.layer,
} satisfies Component<Soundly>;

export default define(spec);
