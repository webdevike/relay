import { Effect, Schema } from "effect";
import { ChildProcessSpawner } from "effect/process";
import { exec, type ExecResult } from "../../../../src/core/exec.ts";

export class SoundlyError extends Schema.TaggedError<SoundlyError>()("SoundlyError", {
  message: Schema.String,
}) {}

/** Isaac kept using Soundly for the whole wait, so the session left it alone (nothing signed in or out). */
export class SoundlyBusy extends Schema.TaggedError<SoundlyBusy>()("SoundlyBusy", {
  message: Schema.String,
}) {}

export const APP = "/Applications/Soundly.app";
export const BUNDLE_ID = "com.soundly.Soundly";

/** A command to completion (60 s at most), its failures as SoundlyError; needs nothing from the caller's context. */
export type Run = (
  command: string,
  args: ReadonlyArray<string>,
  options?: Parameters<typeof exec>[2],
) => Effect.Effect<ExecResult, SoundlyError>;

export const makeRun =
  (spawner: ChildProcessSpawner.ChildProcessSpawner["Service"]): Run =>
  (command, args, options = {}) =>
    exec(command, args, options).pipe(
      Effect.timeoutOrElse({
        duration: "60 seconds",
        orElse: () => Effect.fail(new SoundlyError({ message: `${command} timed out` })),
      }),
      Effect.catchTag("PlatformError", (error) =>
        Effect.fail(new SoundlyError({ message: `${command}: ${error.message}` })),
      ),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );
