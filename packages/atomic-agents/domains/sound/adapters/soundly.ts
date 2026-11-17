import { Cause, Context, Effect, Exit, FileSystem, Layer, Path, Schema } from "effect";
import { ChildProcessSpawner } from "effect/process";
import { createActor, fromCallback, fromPromise, toPromise } from "xstate";
import { moduleFile } from "../../../src/core/Component.ts";
import { cloud, type SoundlyApi } from "./soundly/api.ts";
import { type Desktop, makeDesktop } from "./soundly/desktop.ts";
import { makeRun, SoundlyBusy, SoundlyError } from "./soundly/run.ts";
import { sessionMachine, type SessionOutput } from "./soundly/session.machine.ts";

export type { Collection, Library, Match, SoundlyApi } from "./soundly/api.ts";
export { SoundlyBusy, SoundlyError } from "./soundly/run.ts";

/**
 * Soundly, through the cloud API its desktop app speaks (`soundly/api.ts`), without leaving Isaac's app signed out.
 * Soundly allows one signed-in session per account, so every API sign-in signs the app out; `session` therefore runs
 * the work inside `soundly/session.machine.ts`: wait while Isaac uses Soundly, quit an open app, sign in, work,
 * relaunch it hidden and see it signed in again. One session at a time across processes (a lock dir), since a second
 * sign-in would end the first.
 */

/** Eva's collections are named with this prefix; cleanup deletes nothing without it. */
export const PREFIX = "Eva picks: ";
/** A lock older than this belongs to a run that died; the next run takes it over. */
const STALE_LOCK_MS = 10 * 60_000;
const LOCK_WAIT_MS = 4 * 60_000;

/** What happened to Isaac's Soundly app around a session. */
export const AppState = Schema.Struct({
  /** It was open, so it was quit before the sign-in and relaunched hidden after it. */
  wasOpen: Schema.Boolean,
  /** It was seen signed in again after the relaunch. */
  signedInAgain: Schema.Boolean,
  /** How that was seen. */
  verifiedBy: Schema.Array(Schema.String),
  /** Why it was not, when it was open and is not signed in again. */
  problem: Schema.optionalKey(Schema.String),
});
export type AppState = typeof AppState.Type;

export interface SessionOptions {
  /** How long to wait while Isaac is using Soundly before giving up without touching it (default 15 minutes). */
  readonly patienceMs?: number;
}

/** Machine delays (tests shorten them). */
export interface Timing {
  readonly pollMs: number;
  readonly signInTimeoutMs: number;
  readonly checkEveryMs: number;
}
const TIMING: Timing = { pollMs: 15_000, signInTimeoutMs: 120_000, checkEveryMs: 2_000 };

export class Soundly extends Context.Service<
  Soundly,
  {
    /**
     * Wait for Isaac to leave Soundly, quit it if open, sign in, run `use`, relaunch it so it signs back in. `lockDir`
     * holds the cross-process lock. Fails without touching the app when Isaac kept using it (`patienceMs`) or it
     * could not be quit; `use`'s failure comes back after the app was handed back.
     */
    session<A, E, R>(
      lockDir: string,
      use: (api: SoundlyApi) => Effect.Effect<A, E, R>,
      options?: SessionOptions,
    ): Effect.Effect<
      { readonly value: A; readonly app: AppState },
      E | SoundlyError | SoundlyBusy,
      R
    >;
  }
>()("atomic-agents/sound/Soundly") {
  /** The service over its two halves: the desktop app and the cloud sign-in. */
  static make(parts: {
    readonly desktop: Desktop;
    readonly signIn: Effect.Effect<SoundlyApi, SoundlyError>;
    readonly fs: FileSystem.FileSystem;
    readonly path: Path.Path;
    readonly timing?: Timing;
  }) {
    const { desktop, signIn, fs, path } = parts;
    const timing = parts.timing ?? TIMING;

    const lock = (dir: string) => {
      const held = path.join(dir, "soundly.lock");
      const take = Effect.gen(function* () {
        yield* fs.makeDirectory(dir, { recursive: true });
        const until = Date.now() + LOCK_WAIT_MS;
        while (true) {
          const made = yield* fs.makeDirectory(held).pipe(
            Effect.as(true),
            Effect.catchTag("PlatformError", () => Effect.succeed(false)),
          );
          if (made) return;
          const info = yield* fs.stat(held).pipe(Effect.option);
          const mtime = info._tag === "Some" ? info.value.mtime : undefined;
          const age =
            mtime !== undefined && mtime._tag === "Some" ? Date.now() - mtime.value.getTime() : 0;
          if (age > STALE_LOCK_MS) yield* fs.remove(held, { recursive: true }).pipe(Effect.ignore);
          else if (Date.now() > until)
            return yield* new SoundlyError({ message: "another Soundly run still holds the lock" });
          else yield* Effect.sleep("1 second");
        }
      }).pipe(
        Effect.catchTag("PlatformError", (error) =>
          Effect.fail(new SoundlyError({ message: `lock: ${error.message}` })),
        ),
      );
      return { take, release: fs.remove(held, { recursive: true }).pipe(Effect.ignore) };
    };

    /** The machine run to its end; interrupting it only cancels a wait for Isaac, never a session under way. */
    const drive = <A, E, R>(use: (api: SoundlyApi) => Effect.Effect<A, E, R>, maxWaits: number) =>
      Effect.gen(function* () {
        const context = yield* Effect.context<R>();
        const machine = sessionMachine.provide({
          actors: {
            probe: fromPromise(() => Effect.runPromise(desktop.probe)),
            quit: fromPromise(() => Effect.runPromise(desktop.quit)),
            // Resolves with the work's Exit, failure included: its typed error goes back to the caller as it was.
            work: fromPromise<unknown>(() =>
              Effect.runPromiseExitWith(context)(Effect.flatMap(signIn, use)),
            ),
            relaunch: fromPromise(() => Effect.runPromise(desktop.relaunch)),
            watch: fromCallback(({ sendBack }) => {
              let stopped = false;
              void (async () => {
                while (!stopped) {
                  const exit = await Effect.runPromiseExit(desktop.check);
                  if (stopped) return;
                  if (Exit.isSuccess(exit) && exit.value.signedIn) {
                    sendBack({ type: "app.signedIn", verifiedBy: exit.value.verifiedBy });
                    return;
                  }
                  await Bun.sleep(timing.checkEveryMs);
                }
              })();
              return () => {
                stopped = true;
              };
            }),
          },
          delays: { poll: timing.pollMs, signInTimeout: timing.signInTimeoutMs },
        });
        return yield* Effect.callback<SessionOutput>((resume) => {
          const actor = createActor(machine, { input: { maxWaits } });
          actor.subscribe((snapshot) => {
            if (snapshot.status === "done") resume(Effect.succeed(snapshot.output));
          });
          actor.start();
          return Effect.promise(() => {
            actor.send({ type: "session.cancel" });
            return toPromise(actor);
          }).pipe(Effect.asVoid);
        });
      });

    return Soundly.of({
      session: <A, E, R>(
        lockDir: string,
        use: (api: SoundlyApi) => Effect.Effect<A, E, R>,
        options: SessionOptions = {},
      ) => {
        const { take, release } = lock(lockDir);
        const maxWaits = Math.floor((options.patienceMs ?? 15 * 60_000) / timing.pollMs);
        return Effect.acquireUseRelease(
          take,
          () =>
            Effect.gen(function* () {
              const output = yield* Effect.ensuring(drive(use, maxWaits), desktop.restorePrompt);
              // Never signed in: the app was not touched, the failure says why.
              if (output.work === undefined) {
                const message =
                  output.failure?.message ?? "the Soundly session ended before signing in";
                return yield* output.failure?.kind === "busy" ||
                output.failure?.kind === "cancelled"
                  ? new SoundlyBusy({ message })
                  : new SoundlyError({ message });
              }
              const handedBack = output.verifiedBy !== undefined;
              const problem =
                output.wasOpen && !handedBack
                  ? `Soundly is not signed in again: ${output.failure?.message ?? "unknown"}`
                  : undefined;
              const app: AppState = {
                wasOpen: output.wasOpen,
                signedInAgain: handedBack,
                verifiedBy: output.verifiedBy ?? [],
                ...(problem === undefined ? {} : { problem }),
              };
              // The machine only ever holds `use`'s Exit here (`work` resolves with nothing else).
              const exit = output.work.value as Exit.Exit<A, E>;
              if (Exit.isSuccess(exit)) return { value: exit.value, app };
              if (problem === undefined) return yield* Effect.failCause(exit.cause);
              return yield* new SoundlyError({
                message: `${String(Cause.squash(exit.cause))}; and ${problem}`,
              });
            }),
          () => release,
        );
      },
    });
  }

  static readonly layer = Layer.effect(
    Soundly,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const run = makeRun(yield* ChildProcessSpawner.ChildProcessSpawner);
      const script = yield* moduleFile(import.meta.url, "./soundly/app_constants.py");
      return Soundly.make({
        desktop: makeDesktop(run, fs),
        signIn: cloud(run, script).signIn,
        fs,
        path,
      });
    }),
  );
}
