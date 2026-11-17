import { describe, expect, test } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { Effect, FileSystem } from "effect";
import { makeDesktop } from "../adapters/soundly/desktop.ts";
import { BUNDLE_ID, type Run } from "../adapters/soundly/run.ts";

const TERMINAL = "com.apple.Terminal";
const MAIL = "com.apple.mail";

/**
 * A Mac with Soundly on it: which app is in front, whether Soundly runs, what was hidden or activated. Like the real
 * app, a launched Soundly takes the focus once its window exists, and hiding the app in front hands the focus back to
 * the one it took it from.
 */
const fakeMac = (start: { front: string; soundlyRunning: boolean }) => {
  const mac = {
    front: start.front,
    running: start.soundlyRunning,
    behind: TERMINAL,
    opened: [] as Array<ReadonlyArray<string>>,
    hid: false,
    activated: [] as Array<string>,
    /** Runs once, when the launched Soundly first shows its window. */
    onWindow: (() => {}) as () => void,
    /** Soundly answers the standard quit request. */
    acceptsTerminate: true,
    /** Its menu bar is not reachable (the app is hidden): pressing Quit is refused. */
    hiddenMenu: false,
    terminateRequests: 0,
    menuPresses: 0,
  };
  const done = (stdout = "", exitCode = 0) => Effect.succeed({ stdout, stderr: "", exitCode });
  const run: Run = (command, args) =>
    Effect.suspend(() => {
      const joined = args.join(" ");
      if (command === "pgrep") return done("4242\n", mac.running ? 0 : 1);
      if (command === "lsappinfo" && args[0] === "front") return done("ASN:0x0-1\n");
      if (command === "lsappinfo") return done(`"CFBundleIdentifier"="${mac.front}"\n`);
      if (command === "plutil") return done("<plist></plist>");
      if (command === "cua-driver" && args[1] === "list_windows") {
        if (mac.running && mac.front !== BUNDLE_ID && mac.opened.length > 0 && !mac.hid) {
          mac.behind = mac.front;
          mac.front = BUNDLE_ID;
          mac.onWindow();
        }
        return done(JSON.stringify({ windows: [{ window_id: 1, title: "Soundly" }] }));
      }
      if (command === "cua-driver" && args[1] === "invoke_menu") {
        mac.menuPresses += 1;
        if (mac.hiddenMenu) return done('{"refusal":{"code":"menu_path_unavailable"}}', 1);
        mac.running = false;
        if (mac.front === BUNDLE_ID) mac.front = mac.behind;
        return done();
      }
      if (command === "open") {
        mac.opened.push(args);
        mac.running = true;
        return done();
      }
      if (command === "osascript") {
        const script = args[args.length - 1]!;
        if (script.includes(`"${BUNDLE_ID}"`) && script.includes(".terminate;")) {
          mac.terminateRequests += 1;
          if (mac.acceptsTerminate) mac.running = false;
        } else if (script.includes(`"${BUNDLE_ID}"`) && script.includes(".hide;")) {
          mac.hid = true;
          if (mac.front === BUNDLE_ID) mac.front = mac.behind;
        } else if (script.includes("activateWithOptions")) {
          mac.activated.push(script.includes(TERMINAL) ? TERMINAL : MAIL);
          mac.front = script.includes(TERMINAL) ? TERMINAL : MAIL;
        }
        return done();
      }
      return done(joined);
    });
  return { mac, run };
};

const relaunched = (start: { front: string; soundlyRunning: boolean }) =>
  Effect.gen(function* () {
    const { mac, run } = fakeMac(start);
    const desktop = makeDesktop(run, yield* FileSystem.FileSystem);
    yield* desktop.quit;
    yield* desktop.relaunch;
    return mac;
  }).pipe(Effect.provide(BunServices.layer), Effect.runPromise);

describe("soundly relaunch leaves the screen as it was", () => {
  test("Soundly was behind Terminal: relaunched hidden, Terminal still in front, nothing activated", async () => {
    const mac = await relaunched({ front: TERMINAL, soundlyRunning: true });
    expect(mac.opened[0]).toContain("-j");
    expect(mac.opened[0]).toContain("-g");
    expect(mac.hid).toBe(true);
    expect(mac.front).toBe(TERMINAL);
    expect(mac.activated).toEqual([]);
  });

  test("Isaac switched to Mail while it launched: hidden, and Mail keeps the focus", async () => {
    const { mac, run } = fakeMac({ front: TERMINAL, soundlyRunning: true });
    mac.onWindow = () => {
      mac.front = MAIL;
    };
    await Effect.gen(function* () {
      const desktop = makeDesktop(run, yield* FileSystem.FileSystem);
      yield* desktop.quit;
      yield* desktop.relaunch;
    }).pipe(Effect.provide(BunServices.layer), Effect.runPromise);
    expect(mac.hid).toBe(true);
    expect(mac.front).toBe(MAIL);
    expect(mac.activated).toEqual([]);
  });

  test("Soundly was in front: relaunched visible, not hidden, no one else activated", async () => {
    const mac = await relaunched({ front: BUNDLE_ID, soundlyRunning: true });
    expect(mac.opened[0]).not.toContain("-j");
    expect(mac.opened[0]).toContain("-g");
    expect(mac.hid).toBe(false);
    expect(mac.activated).toEqual([]);
  });
});

describe("soundly quit works while Soundly is hidden", () => {
  const quit = (options: { acceptsTerminate?: boolean; hiddenMenu?: boolean }) => {
    const { mac, run } = fakeMac({ front: TERMINAL, soundlyRunning: true });
    Object.assign(mac, options);
    return Effect.gen(function* () {
      yield* makeDesktop(run, yield* FileSystem.FileSystem).quit;
      return mac;
    }).pipe(Effect.provide(BunServices.layer), Effect.runPromise);
  };

  test("a hidden Soundly quits on the terminate request; its menu is never pressed", async () => {
    const mac = await quit({ hiddenMenu: true });
    expect(mac.running).toBe(false);
    expect(mac.terminateRequests).toBe(1);
    expect(mac.menuPresses).toBe(0);
    expect(mac.front).toBe(TERMINAL);
  });

  test("a terminate request the app ignores falls back to the menu", async () => {
    const mac = await quit({ acceptsTerminate: false });
    expect(mac.running).toBe(false);
    expect(mac.terminateRequests).toBe(1);
    expect(mac.menuPresses).toBe(1);
  }, 30_000);
});
