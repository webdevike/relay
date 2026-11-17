import { Effect, FileSystem, Schema } from "effect";
import { homedir } from "node:os";
import type { Probe } from "./session.machine.ts";
import { PREFS } from "./api.ts";
import { BUNDLE_ID, type Run, SoundlyError } from "./run.ts";

/**
 * Soundly.app on this Mac, never brought to the front: whether it runs and Isaac is using it, quitting it, relaunching
 * it hidden so it signs back in, and checking that it did. Accessibility goes through cua-driver (`cua-driver call`,
 * its daemon holds the Accessibility grant), which presses in the background. Quitting is its Soundly > Quit Soundly
 * menu item pressed that way: a normal quit (the app saves its tabs), and no Apple Event, so no Automation prompt.
 */

/** Input this recent while Soundly is in front means Isaac is using it. */
export const IN_USE_IDLE_SECONDS = 120;
const LOG = `${homedir()}/Library/Logs/soundly_log.txt`;
/** What Soundly logs once a signed-in session loaded the account's tab groups from the cloud. */
const SIGNED_IN_LINE = "Tab groups: cloud answered";
const SIGN_IN_BUTTON = "Sign In";
const RESTORE_TABS = "Restore tabs";

export interface Check {
  readonly signedIn: boolean;
  /** What showed it (or what was done on the way, such as answering the Restore tabs prompt). */
  readonly verifiedBy: ReadonlyArray<string>;
}

/** The app side of a session; the runtime binds it to the session machine, tests fake it. */
export interface Desktop {
  readonly probe: Effect.Effect<Probe, SoundlyError>;
  /** Quits Soundly the normal way (answering a Restore tabs prompt left open first) and waits until it is gone. */
  readonly quit: Effect.Effect<void, SoundlyError>;
  /**
   * Opens Soundly hidden and not activated, with "Restore tabs" set to always for this launch (so no modal waits for
   * Isaac); resolves once it runs. Its saved login signs it in again.
   */
  readonly relaunch: Effect.Effect<void, SoundlyError>;
  /** Puts Isaac's "Restore tabs" choice back as `relaunch` found it. */
  readonly restorePrompt: Effect.Effect<void>;
  /** One look at the relaunched app: answers a Restore tabs prompt if one shows anyway, and whether it is signed in. */
  readonly check: Effect.Effect<Check, SoundlyError>;
}

const Window = Schema.Struct({
  window_id: Schema.Number,
  title: Schema.optionalKey(Schema.String),
});
const Element = Schema.Struct({
  role: Schema.optionalKey(Schema.String),
  label: Schema.optionalKey(Schema.String),
  element_token: Schema.optionalKey(Schema.String),
});
const decodeWindows = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ windows: Schema.Array(Window) })),
);
const decodeElements = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ elements: Schema.Array(Element) })),
);

export const makeDesktop = (run: Run, fs: FileSystem.FileSystem): Desktop => {
  /** The prompt settings `relaunch` overrode: each key and the value it had (undefined: unset). */
  let overridden: ReadonlyArray<{ readonly key: string; readonly before: string | undefined }> = [];
  /** Where the log ended before the relaunch: only lines after it count. */
  let logStart = 0;

  const pid = Effect.map(run("pgrep", ["-x", "Soundly"]), (result) =>
    result.exitCode === 0 ? Number(result.stdout.trim().split("\n")[0]) : undefined,
  );

  const waitFor = (running: boolean, millis: number) =>
    Effect.gen(function* () {
      const until = Date.now() + millis;
      while (Date.now() < until) {
        if (((yield* pid) !== undefined) === running) return true;
        yield* Effect.sleep("500 millis");
      }
      return false;
    });

  const cua = (tool: string, args: Readonly<Record<string, unknown>>) =>
    Effect.flatMap(run("cua-driver", ["call", tool, JSON.stringify(args)]), (result) =>
      result.exitCode === 0
        ? Effect.succeed(result.stdout)
        : Effect.fail(
            new SoundlyError({
              message: `cua-driver ${tool}: ${(result.stderr || result.stdout).trim().slice(0, 200)}`,
            }),
          ),
    );

  const windows = (app: number) =>
    cua("list_windows", { pid: app }).pipe(
      Effect.flatMap(decodeWindows),
      Effect.map((read) => read.windows),
      Effect.mapError((error) => new SoundlyError({ message: `list_windows: ${error.message}` })),
    );

  const elements = (app: number, window: number, query: string) =>
    cua("get_window_state", {
      pid: app,
      window_id: window,
      include_screenshot: false,
      query,
    }).pipe(
      Effect.flatMap(decodeElements),
      Effect.map((read) => read.elements),
      Effect.mapError(
        (error) => new SoundlyError({ message: `get_window_state: ${error.message}` }),
      ),
    );

  /** Presses Yes on a "Restore tabs" prompt when one is open; whether it did. */
  const answerRestoreTabs = (app: number) =>
    Effect.gen(function* () {
      const prompt = (yield* windows(app)).find((window) => window.title === RESTORE_TABS);
      if (prompt === undefined) return false;
      const yes = (yield* elements(app, prompt.window_id, "Yes")).find(
        (element) => element.role === "AXButton" && element.label === "Yes",
      );
      if (yes?.element_token === undefined)
        return yield* new SoundlyError({ message: "the Restore tabs prompt has no Yes button" });
      yield* cua("click", {
        pid: app,
        window_id: prompt.window_id,
        element_token: yes.element_token,
      });
      return true;
    });

  return {
    probe: Effect.gen(function* () {
      if ((yield* pid) === undefined) return { running: false, inUse: undefined };
      const front = yield* run("lsappinfo", ["front"]);
      const info = yield* run("lsappinfo", ["info", "-only", "bundleid", front.stdout.trim()]);
      const frontmost = /(?:bundleID|"CFBundleIdentifier")="([^"]+)"/.exec(info.stdout)?.[1];
      if (frontmost !== BUNDLE_ID) return { running: true, inUse: undefined };
      const hid = yield* run("ioreg", ["-c", "IOHIDSystem", "-d", "4", "-r", "-k", "HIDIdleTime"]);
      const nanos = /"HIDIdleTime" = (\d+)/.exec(hid.stdout)?.[1];
      // Unreadable idle time counts as recent input: when unsure, Isaac is using it.
      const idle = nanos === undefined ? 0 : Math.round(Number(nanos) / 1e9);
      return {
        running: true,
        inUse: idle < IN_USE_IDLE_SECONDS ? `in front, last input ${idle} s ago` : undefined,
      };
    }),

    quit: Effect.gen(function* () {
      const app = yield* pid;
      if (app === undefined) return;
      // A prompt left open blocks the quit; answering it is what Isaac's own click would do.
      yield* answerRestoreTabs(app).pipe(Effect.ignore);
      const main = (yield* windows(app)).find((window) => window.title === "Soundly");
      if (main === undefined)
        return yield* new SoundlyError({ message: "Soundly has no main window to quit it from" });
      yield* cua("invoke_menu", {
        pid: app,
        window_id: main.window_id,
        path: ["Soundly", "Quit Soundly"],
      });
      if (!(yield* waitFor(false, 30_000)))
        return yield* new SoundlyError({
          message: "Soundly did not quit within 30 s (a dialog open in it?); left it as it was",
        });
    }),

    relaunch: Effect.gen(function* () {
      // Isaac's "Restore tabs on startup" choice: absent or 0 asks in a modal, 1 always restores, 2 never does. It is
      // a per-user key named with the account email the app keeps (not the saved login's email); the prompt only
      // shows for a user with saved tabs, so those are the users whose choice matters.
      const prefs = yield* run("plutil", ["-convert", "xml1", "-o", "-", PREFS]);
      const emails = new Set(
        [...prefs.stdout.matchAll(/<key>savedTabsState1;([^<]+)<\/key>/g)].map(
          (match) => match[1]!,
        ),
      );
      // Recorded as written, so a failure halfway still puts back the ones already changed.
      const changed: Array<{ readonly key: string; readonly before: string | undefined }> = [];
      overridden = changed;
      for (const email of emails) {
        const key = `ShowRestoreTabsPromptOnStartup1;${email}`;
        const read = yield* run("defaults", ["read", BUNDLE_ID, key]);
        const before = read.exitCode === 0 ? read.stdout.trim() : undefined;
        // Only "ask" is overridden; always or never already shows no prompt.
        if (before !== undefined && before !== "0") continue;
        const wrote = yield* run("defaults", ["write", BUNDLE_ID, key, "-int", "1"]);
        if (wrote.exitCode !== 0)
          return yield* new SoundlyError({ message: `defaults write: ${wrote.stderr.trim()}` });
        changed.push({ key, before });
      }
      logStart = yield* fs.stat(LOG).pipe(
        Effect.map((info) => Number(info.size)),
        Effect.orElseSucceed(() => 0),
      );
      // Hidden (-j) and not activated (-g); EVA_AGENT tells the focus guard an agent launched it.
      const opened = yield* run("open", ["-g", "-j", "-b", BUNDLE_ID], { env: { EVA_AGENT: "1" } });
      if (opened.exitCode !== 0 || !(yield* waitFor(true, 30_000)))
        return yield* new SoundlyError({
          message: `Soundly did not relaunch: ${opened.stderr.trim() || "not running after 30 s"}`,
        });
    }),

    restorePrompt: Effect.suspend(() => {
      const settings = overridden;
      overridden = [];
      return Effect.forEach(
        settings,
        (setting) =>
          Effect.ignore(
            setting.before === undefined
              ? run("defaults", ["delete", BUNDLE_ID, setting.key])
              : run("defaults", ["write", BUNDLE_ID, setting.key, "-int", setting.before]),
          ),
        { discard: true },
      );
    }),

    check: Effect.gen(function* () {
      const app = yield* pid;
      if (app === undefined)
        return yield* new SoundlyError({ message: "Soundly quit after the relaunch" });
      const log = yield* fs.readFile(LOG).pipe(
        Effect.map((bytes) => new TextDecoder().decode(bytes.subarray(logStart))),
        Effect.orElseSucceed(() => ""),
      );
      const logged = log.includes(SIGNED_IN_LINE);
      const seen = yield* Effect.gen(function* () {
        if (yield* answerRestoreTabs(app)) return { answered: true, signInButton: false };
        const main = (yield* windows(app)).find((window) => window.title === "Soundly");
        if (main === undefined) return { answered: false, signInButton: undefined };
        const found = yield* elements(app, main.window_id, SIGN_IN_BUTTON);
        return {
          answered: false,
          signInButton: found.some(
            (element) => element.role === "AXButton" && element.label === SIGN_IN_BUTTON,
          ),
        };
      }).pipe(Effect.option);
      // Accessibility is the second witness; without it (cua-driver down) the log alone decides.
      if (seen._tag === "None")
        return { signedIn: logged, verifiedBy: logged ? [`log: "${SIGNED_IN_LINE}"`] : [] };
      const { answered, signInButton } = seen.value;
      const verifiedBy = [
        ...(answered ? ["answered the Restore tabs prompt (Yes)"] : []),
        ...(logged ? [`log: "${SIGNED_IN_LINE}"`] : []),
        ...(signInButton === false
          ? ["accessibility: no Sign In button in the Soundly window"]
          : []),
      ];
      return { signedIn: logged && signInButton === false, verifiedBy };
    }),
  };
};
