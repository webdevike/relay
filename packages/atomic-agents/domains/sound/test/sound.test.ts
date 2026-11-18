import { describe, expect, test } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { Effect, FileSystem, Layer, Path } from "effect";
import { createActor, fromCallback, fromPromise, SimulatedClock, waitFor } from "xstate";
import { define } from "../../../src/core/Component.ts";
import { EventBus } from "../../../src/core/Event.ts";
import { ModelRunner } from "../../../src/core/Model.ts";
import { Runner } from "../../../src/core/Runtime.ts";
import { runtime, tempHome } from "../../../test/harness.ts";
import { readLedger, readSearches, writeLedger } from "../adapters/ledger.ts";
import { narrow, toMatches } from "../adapters/soundly/api.ts";
import {
  type Collection,
  type Match,
  Soundly,
  SoundlyError,
  type SoundlyApi,
} from "../adapters/soundly.ts";
import type { Check, Desktop } from "../adapters/soundly/desktop.ts";
import { type Probe, sessionMachine } from "../adapters/soundly/session.machine.ts";
import { spec as cleanupSpec } from "../soundly-cleanup.ts";
import { collectionName, readPicks, spec as picksSpec } from "../soundly-picks.ts";

const free: Probe = { running: true, inUse: undefined };
const busy: Probe = { running: true, inUse: "in front, last input 3 s ago" };
const closed: Probe = { running: false, inUse: undefined };

/** The machine with stub actors that log what ran; `probes` answers each look in turn (the last one repeats). */
const stubbed = (options: {
  probes: ReadonlyArray<Probe>;
  quit?: () => Promise<void>;
  work?: () => Promise<unknown>;
  signsIn?: boolean;
}) => {
  const calls: Array<string> = [];
  let looks = 0;
  const machine = sessionMachine.provide({
    actors: {
      probe: fromPromise(async () => options.probes[Math.min(looks++, options.probes.length - 1)]!),
      quit: fromPromise(async () => {
        calls.push("quit");
        await options.quit?.();
      }),
      work: fromPromise(async () => {
        calls.push("work");
        return options.work === undefined ? "picked" : options.work();
      }),
      relaunch: fromPromise(async () => {
        calls.push("relaunch");
      }),
      watch: fromCallback(({ sendBack }) => {
        calls.push("watch");
        if (options.signsIn !== false) sendBack({ type: "app.signedIn", verifiedBy: ["log"] });
      }),
    },
  });
  return { machine, calls };
};

describe("soundly session machine", () => {
  test("a closed Soundly stays closed: sign in and work, no quit, no relaunch", async () => {
    const { machine, calls } = stubbed({ probes: [closed] });
    const actor = createActor(machine, { input: { maxWaits: 4 } }).start();
    const done = await waitFor(actor, (snapshot) => snapshot.status === "done");
    expect(done.value).toBe("done");
    expect(done.output).toEqual({ wasOpen: false, work: { value: "picked" } });
    expect(calls).toEqual(["work"]);
  });

  test("an open Soundly is quit before the sign-in and seen signed in after the relaunch", async () => {
    const { machine, calls } = stubbed({ probes: [free] });
    const actor = createActor(machine, { input: { maxWaits: 4 } }).start();
    const done = await waitFor(actor, (snapshot) => snapshot.status === "done");
    expect(done.output).toEqual({ wasOpen: true, work: { value: "picked" }, verifiedBy: ["log"] });
    expect(calls).toEqual(["quit", "work", "relaunch", "watch"]);
  });

  test("while Isaac uses Soundly it waits, then goes once he leaves it", async () => {
    const clock = new SimulatedClock();
    const { machine, calls } = stubbed({ probes: [busy, busy, free] });
    const actor = createActor(machine, { input: { maxWaits: 4 }, clock }).start();
    for (const waits of [0, 1]) {
      await waitFor(
        actor,
        (snapshot) => snapshot.matches({ gating: "waiting" }) && snapshot.context.waits === waits,
      );
      expect(calls).toEqual([]);
      clock.increment(15_000);
    }
    const done = await waitFor(actor, (snapshot) => snapshot.status === "done");
    expect(done.output?.verifiedBy).toEqual(["log"]);
    expect(calls).toEqual(["quit", "work", "relaunch", "watch"]);
  });

  test("Isaac using Soundly through the whole wait: busy, and the app is never touched", async () => {
    const clock = new SimulatedClock();
    const { machine, calls } = stubbed({ probes: [busy] });
    const actor = createActor(machine, { input: { maxWaits: 1 }, clock }).start();
    await waitFor(actor, (snapshot) => snapshot.matches({ gating: "waiting" }));
    clock.increment(15_000);
    const done = await waitFor(actor, (snapshot) => snapshot.status === "done");
    expect(done.value).toBe("failed");
    expect(done.output?.failure?.kind).toBe("busy");
    expect(done.output?.work).toBeUndefined();
    expect(calls).toEqual([]);
  });

  test("no patience (the hourly cleanup): busy at the first look", async () => {
    const { machine, calls } = stubbed({ probes: [busy] });
    const done = await waitFor(
      createActor(machine, { input: { maxWaits: 0 } }).start(),
      (snapshot) => snapshot.status === "done",
    );
    expect(done.output?.failure?.kind).toBe("busy");
    expect(calls).toEqual([]);
  });

  test("a quit that fails ends before the sign-in", async () => {
    const { machine, calls } = stubbed({
      probes: [free],
      quit: async () => {
        throw new SoundlyError({ message: "Soundly did not quit within 30 s" });
      },
    });
    const done = await waitFor(
      createActor(machine, { input: { maxWaits: 4 } }).start(),
      (snapshot) => snapshot.status === "done",
    );
    expect(done.output).toEqual({
      wasOpen: true,
      failure: { kind: "unavailable", message: "Soundly did not quit within 30 s" },
    });
    expect(calls).toEqual(["quit"]);
  });

  test("work that crashes still relaunches the app it signed out", async () => {
    const { machine, calls } = stubbed({
      probes: [free],
      work: async () => {
        throw new Error("network down");
      },
    });
    const done = await waitFor(
      createActor(machine, { input: { maxWaits: 4 } }).start(),
      (snapshot) => snapshot.status === "done",
    );
    expect(done.output?.failure).toEqual({ kind: "work_failed", message: "network down" });
    expect(done.output?.verifiedBy).toEqual(["log"]);
    expect(calls).toEqual(["quit", "work", "relaunch", "watch"]);
  });

  test("a relaunched app never seen signed in fails as not signed in", async () => {
    const clock = new SimulatedClock();
    const { machine } = stubbed({ probes: [free], signsIn: false });
    const actor = createActor(machine, { input: { maxWaits: 4 }, clock }).start();
    await waitFor(actor, (snapshot) => snapshot.matches({ restoring: "watching" }));
    clock.increment(120_000);
    const done = await waitFor(actor, (snapshot) => snapshot.status === "done");
    expect(done.output?.failure?.kind).toBe("not_signed_in");
    expect(done.output?.work).toEqual({ value: "picked" });
  });

  test("cancel stops a wait for Isaac, never a session under way", async () => {
    const waiting = stubbed({ probes: [busy] });
    const actor = createActor(waiting.machine, { input: { maxWaits: 4 } }).start();
    await waitFor(actor, (snapshot) => snapshot.matches({ gating: "waiting" }));
    actor.send({ type: "session.cancel" });
    expect(actor.getSnapshot().value).toBe("cancelled");

    const { promise, resolve } = Promise.withResolvers<unknown>();
    const working = stubbed({ probes: [free], work: () => promise });
    const busyActor = createActor(working.machine, { input: { maxWaits: 4 } }).start();
    const inWork = await waitFor(busyActor, (snapshot) => snapshot.matches("working"));
    expect(inWork.can({ type: "session.cancel" })).toBe(false);
    resolve("picked");
    expect(
      (await waitFor(busyActor, (snapshot) => snapshot.status === "done")).output?.verifiedBy,
    ).toEqual(["log"]);
  });
});

describe("Pro sounds", () => {
  const row = (id: string, flag?: unknown) => ({
    FileID: id,
    Name: `${id}.wav`,
    Length: "2.5",
    LibraryID: "L1",
    ...(flag === undefined ? {} : { IsForFreeAccount: flag }),
  });

  test("only a row with IsForFreeAccount 1 is included without Pro, as the app shows it to a Free account", () => {
    const matches = toMatches([
      row("SND1", 1),
      row("SND2"),
      row("SND3", 0),
      row("SND4", true),
      row("SND5", "1"),
    ]);
    expect(matches.map((match) => [match.id, match.pro])).toEqual([
      ["SND1", false],
      ["SND2", true],
      ["SND3", true],
      ["SND4", false],
      ["SND5", true],
    ]);
  });

  test("Pro rows are dropped before the cut, so the count is still filled from further down the hits", () => {
    const found = toMatches([
      row("SND1"),
      row("SND2"),
      row("SND3", 1),
      row("SND4"),
      row("SND5", 1),
      row("SND6", 1),
    ]);
    const open = narrow(found, 2, false);
    expect(open.matches.map((match) => match.id)).toEqual(["SND3", "SND5"]);
    expect(open.proLeftOut).toBe(3);
    expect(narrow(found, 2, true).matches.map((match) => match.id)).toEqual(["SND1", "SND2"]);
  });
});

describe("soundly-picks model reply", () => {
  const candidates: ReadonlyArray<Match> = [
    {
      id: "SND1",
      name: "Door Slam 01.wav",
      description: "",
      seconds: 2,
      libraryId: "L1",
      pro: false,
    },
    {
      id: "SND2",
      name: "Door Slam 02.wav",
      description: "",
      seconds: 2,
      libraryId: "L1",
      pro: false,
    },
  ];

  test("ids outside the list, repeats and too many picks are rejected", () => {
    expect(readPicks('{"picks": ["SND1", "SND2"], "why": "x"}', candidates, 2)).toEqual({
      picks: ["SND1", "SND2"],
      problems: [],
    });
    expect(readPicks('{"picks": ["SND9", "SND1", "SND1"]}', candidates, 2).problems).toEqual([
      "SND9 is not a candidate id",
      "an id is picked twice",
      "3 picks, at most 2",
    ]);
    expect(readPicks("no json here", candidates, 2).problems).toHaveLength(1);
  });

  test("a taken collection name gets the time added", () => {
    const now = new Date(2026, 10, 17, 15, 4);
    expect(collectionName("door slam", new Set(), now)).toBe("Eva picks: door slam");
    expect(collectionName("door slam", new Set(["Eva picks: door slam"]), now)).toBe(
      "Eva picks: door slam 15:04",
    );
  });
});

/** Matches Soundly would return, best first. */
const MATCHES: ReadonlyArray<Match> = Array.from({ length: 12 }, (_, index) => ({
  id: `SND${100 + index}`,
  name: `DOOR_Wood Slam Hall ${index}.wav`,
  description: "Heavy wooden door slams in a large hall",
  seconds: 2 + index / 10,
  libraryId: "LIB1",
  pro: false,
}));

/** An account with Isaac's own collection, Soundly's curated folder and whatever Eva picks are passed in. */
const account = (evaPicks: ReadonlyArray<Collection>, matches: ReadonlyArray<Match> = MATCHES) => {
  const log: Array<string> = [];
  let collections: Array<Collection> = [
    { key: "K-solstice", name: "Solstice", permissions: "Admin" },
    { key: "K-curated", name: "Soundly Collections", permissions: "Read" },
    { key: "K-renamed", name: "Eva picks: Isaac's own copy", permissions: "Read" },
    ...evaPicks,
  ];
  const files = new Map<string, ReadonlyArray<string>>();
  let made = 0;
  const api: SoundlyApi = {
    libraries: [{ id: "LIB1", name: "Soundly Free" }],
    search: (query, wanted, includePro) =>
      Effect.sync(() => {
        log.push(`search ${query} ${wanted} ${includePro ? "with" : "without"} pro`);
        return { mode: "semantic" as const, ...narrow(matches, wanted, includePro) };
      }),
    collections: Effect.sync(() => [...collections]),
    create: (name) =>
      Effect.sync(() => {
        const collection = { key: `K-new-${++made}`, name, permissions: "Admin" };
        collections = [...collections, collection];
        log.push(`create ${name}`);
        return collection;
      }),
    add: (key, sounds) =>
      Effect.sync(() => {
        files.set(
          key,
          sounds.map((sound) => sound.id),
        );
      }),
    fileIds: (key) => Effect.sync(() => files.get(key) ?? []),
    remove: (key) =>
      Effect.sync(() => {
        log.push(`remove ${collections.find((collection) => collection.key === key)?.name ?? key}`);
        collections = collections.filter((collection) => collection.key !== key);
      }),
    download: (fileId) =>
      Effect.fail(new SoundlyError({ message: `the fake account has no file ${fileId}` })),
  };
  return { api, log, names: () => collections.map((collection) => collection.name), files };
};

/** Soundly.app as the session sees it: open, idle, signing back in after the relaunch unless told otherwise. */
const fakeDesktop = (options: { probe?: Probe; check?: Check } = {}) => {
  const log: Array<string> = [];
  const desktop: Desktop = {
    probe: Effect.succeed(options.probe ?? free),
    quit: Effect.sync(() => void log.push("quit")),
    relaunch: Effect.sync(() => void log.push("relaunch")),
    restorePrompt: Effect.sync(() => void log.push("restorePrompt")),
    check: Effect.succeed(
      options.check ?? { signedIn: true, verifiedBy: ["log", "accessibility"] },
    ),
  };
  return { desktop, log };
};

const soundlyLayer = (desktop: Desktop, api: SoundlyApi, signIns: { count: number }) =>
  Layer.effect(
    Soundly,
    Effect.gen(function* () {
      return Soundly.make({
        desktop,
        signIn: Effect.sync(() => {
          signIns.count++;
          return api;
        }),
        fs: yield* FileSystem.FileSystem,
        path: yield* Path.Path,
        timing: { pollMs: 5, signInTimeoutMs: 300, checkEveryMs: 5 },
      });
    }),
  );

/** A model that picks the given ids. */
const picking = (ids: ReadonlyArray<string>) =>
  ModelRunner.of({
    generate: (request) =>
      Effect.succeed({
        text: JSON.stringify({ picks: ids, why: "slams with hall reverb" }),
        model: request.model,
        provider: "test",
        seconds: 0,
        cost: 0.001,
      }),
  });

describe("soundly-picks", () => {
  test(
    "one session: old Eva picks swept, the picks collected, Isaac's collections untouched, the app handed back",
    () =>
      Effect.gen(function* () {
        const root = yield* tempHome;
        const dir = `${root}/state/sound`;
        const stale = {
          key: "K-stale",
          name: "Eva picks: rain on a tin roof",
          permissions: "Admin",
        };
        const fresh = { key: "K-fresh", name: "Eva picks: thunder", permissions: "Admin" };
        const orphan = {
          key: "K-orphan",
          name: "Eva picks: heavy wooden door slam in a large hall",
          permissions: "Admin",
        };
        yield* writeLedger(dir, [
          {
            key: stale.key,
            name: stale.name,
            query: "rain on a tin roof",
            createdAt: "2026-11-15T10:00:00.000Z",
          },
          {
            key: fresh.key,
            name: fresh.name,
            query: "thunder",
            createdAt: new Date().toISOString(),
          },
        ]).pipe(Effect.provide(BunServices.layer));
        const cloud = account([stale, fresh, orphan]);
        const app = fakeDesktop();
        const signIns = { count: 0 };
        const tools = soundlyLayer(app.desktop, cloud.api, signIns);
        yield* Effect.gen(function* () {
          const runner = yield* Runner;
          const bus = yield* EventBus;
          const result = yield* runner.run("soundly-picks", "pick", {
            query: "heavy wooden door slam in a large hall",
            count: 3,
          });
          expect(result.ok).toBe(true);
          const reply = (yield* bus.history).find(
            (event) => event.type === "soundly-picks/sound.collected",
          )?.data;
          expect(reply).toMatchObject({
            collection: "Eva picks: heavy wooden door slam in a large hall",
            sounds: [
              {
                title: "DOOR_Wood Slam Hall 3",
                library: "Soundly Free",
                duration: 2.3,
                id: "SND103",
              },
              {
                title: "DOOR_Wood Slam Hall 0",
                library: "Soundly Free",
                duration: 2,
                id: "SND100",
              },
              {
                title: "DOOR_Wood Slam Hall 7",
                library: "Soundly Free",
                duration: 2.7,
                id: "SND107",
              },
            ],
            search: "semantic",
            soundly: { wasOpen: true, signedInAgain: true, verifiedBy: ["log", "accessibility"] },
          });
          const swept = (yield* bus.history).find(
            (event) => event.type === "soundly-picks/expired.removed",
          )?.data;
          expect(swept).toEqual({ names: [stale.name, orphan.name] });
        }).pipe(
          Effect.provide(
            runtime(
              root,
              { code: [define({ ...picksSpec, tools })] },
              picking(["SND103", "SND100", "SND107"]),
            ),
          ),
        );

        expect(signIns.count).toBe(1);
        expect(app.log).toEqual(["quit", "relaunch", "restorePrompt"]);
        expect(cloud.names()).toEqual([
          "Solstice",
          "Soundly Collections",
          "Eva picks: Isaac's own copy",
          fresh.name,
          "Eva picks: heavy wooden door slam in a large hall",
        ]);
        expect(cloud.files.get("K-new-1")).toEqual(["SND103", "SND100", "SND107"]);
        const ledger = yield* readLedger(dir).pipe(Effect.provide(BunServices.layer));
        expect(ledger.map((entry) => entry.key)).toEqual(["K-fresh", "K-new-1"]);
        const searches = yield* readSearches(dir).pipe(Effect.provide(BunServices.layer));
        expect(searches.map((search) => [search.query, search.candidates.length])).toEqual([
          ["heavy wooden door slam in a large hall", 12],
        ]);
      }).pipe(Effect.scoped, Effect.runPromise),
    20_000,
  );

  test(
    "the collection is made but Soundly is not signed in again: the reply says so and the run fails",
    () =>
      Effect.gen(function* () {
        const root = yield* tempHome;
        const cloud = account([]);
        const app = fakeDesktop({ check: { signedIn: false, verifiedBy: [] } });
        const tools = soundlyLayer(app.desktop, cloud.api, { count: 0 });
        yield* Effect.gen(function* () {
          const result = yield* (yield* Runner).run("soundly-picks", "pick", {
            query: "door creak",
            count: 1,
          });
          expect(result.ok).toBe(false);
          const reply = (yield* (yield* EventBus).history).find(
            (event) => event.type === "soundly-picks/sound.collected",
          )?.data;
          expect(reply).toMatchObject({
            collection: "Eva picks: door creak",
            soundly: {
              wasOpen: true,
              signedInAgain: false,
              problem:
                "Soundly is not signed in again: Soundly relaunched but was not seen signed in within 2 minutes",
            },
          });
        }).pipe(
          Effect.provide(
            runtime(root, { code: [define({ ...picksSpec, tools })] }, picking(["SND100"])),
          ),
        );
        expect(app.log).toEqual(["quit", "relaunch", "restorePrompt"]);
      }).pipe(Effect.scoped, Effect.runPromise),
    20_000,
  );

  test(
    "a failed search still hands the app back, and the run fails with the search's error",
    () =>
      Effect.gen(function* () {
        const root = yield* tempHome;
        const cloud = account([]);
        const api: SoundlyApi = {
          ...cloud.api,
          search: () => Effect.fail(new SoundlyError({ message: "HybridSearch: HTTP 503" })),
        };
        const app = fakeDesktop();
        const tools = soundlyLayer(app.desktop, api, { count: 0 });
        yield* Effect.gen(function* () {
          const result = yield* (yield* Runner).run("soundly-picks", "pick", {
            query: "door creak",
          });
          expect(result.ok).toBe(false);
          const failed = (yield* (yield* EventBus).history).find(
            (event) => event.type === "soundly-picks/job.failed",
          );
          expect(JSON.stringify(failed?.data)).toContain("HybridSearch: HTTP 503");
        }).pipe(
          Effect.provide(runtime(root, { code: [define({ ...picksSpec, tools })] }, picking([]))),
        );
        expect(app.log).toEqual(["quit", "relaunch", "restorePrompt"]);
        expect(cloud.names()).not.toContain("Eva picks: door creak");
      }).pipe(Effect.scoped, Effect.runPromise),
    20_000,
  );

  test(
    "searches without Pro by default, and a result with only Pro sounds fails saying so",
    () =>
      Effect.gen(function* () {
        const root = yield* tempHome;
        const cloud = account(
          [],
          MATCHES.slice(0, 3).map((match) => ({ ...match, pro: true })),
        );
        const app = fakeDesktop();
        const tools = soundlyLayer(app.desktop, cloud.api, { count: 0 });
        yield* Effect.gen(function* () {
          const bus = yield* EventBus;
          const runner = yield* Runner;
          expect((yield* runner.run("soundly-picks", "pick", { query: "door creak" })).ok).toBe(
            false,
          );
          const failed = (yield* bus.history).find(
            (event) => event.type === "soundly-picks/job.failed",
          );
          expect(JSON.stringify(failed?.data)).toContain("only Pro sounds");
          const withPro = yield* runner.run("soundly-picks", "pick", {
            query: "door creak",
            count: 2,
            includePro: true,
          });
          expect(withPro.ok).toBe(true);
        }).pipe(
          Effect.provide(
            runtime(
              root,
              { code: [define({ ...picksSpec, tools })] },
              picking(["SND100", "SND101"]),
            ),
          ),
        );
        expect(cloud.log.filter((line) => line.startsWith("search"))).toEqual([
          "search door creak 32 without pro",
          "search door creak 30 with pro",
        ]);
      }).pipe(Effect.scoped, Effect.runPromise),
    20_000,
  );
});

describe("soundly-cleanup", () => {
  test(
    "the hourly run with nothing due never signs in; a manual run deletes only Eva picks",
    () =>
      Effect.gen(function* () {
        const root = yield* tempHome;
        const dir = `${root}/state/sound`;
        const fresh = { key: "K-fresh", name: "Eva picks: thunder", permissions: "Admin" };
        const orphan = {
          key: "K-orphan",
          name: "Eva picks: heavy wooden door slam in a large hall",
          permissions: "Admin",
        };
        yield* writeLedger(dir, [
          {
            key: fresh.key,
            name: fresh.name,
            query: "thunder",
            createdAt: new Date().toISOString(),
          },
        ]).pipe(Effect.provide(BunServices.layer));
        const cloud = account([fresh, orphan]);
        const app = fakeDesktop({ probe: closed });
        const signIns = { count: 0 };
        const tools = soundlyLayer(app.desktop, cloud.api, signIns);
        yield* Effect.gen(function* () {
          const runner = yield* Runner;
          expect((yield* runner.run("soundly-cleanup", "sweep", { scheduled: true })).ok).toBe(
            true,
          );
          expect(signIns.count).toBe(0);
          expect((yield* runner.run("soundly-cleanup", "sweep", {})).ok).toBe(true);
          expect(signIns.count).toBe(1);
          expect(cloud.names()).toEqual([
            "Solstice",
            "Soundly Collections",
            "Eva picks: Isaac's own copy",
            fresh.name,
          ]);
          expect((yield* runner.run("soundly-cleanup", "sweep", { all: true })).ok).toBe(true);
          expect(cloud.names()).toEqual([
            "Solstice",
            "Soundly Collections",
            "Eva picks: Isaac's own copy",
          ]);
          const swept = (yield* (yield* EventBus).history)
            .filter((event) => event.type === "soundly-cleanup/collections.swept")
            .map((event) => event.data);
          expect(swept).toEqual([
            { removed: [] },
            {
              removed: [orphan.name],
              soundly: { wasOpen: false, signedInAgain: false, verifiedBy: [] },
            },
            {
              removed: [fresh.name],
              soundly: { wasOpen: false, signedInAgain: false, verifiedBy: [] },
            },
          ]);
        }).pipe(Effect.provide(runtime(root, { code: [define({ ...cleanupSpec, tools })] })));
        // Soundly was closed: never quit, never relaunched.
        expect(app.log).toEqual(["restorePrompt", "restorePrompt"]);
        expect(yield* readLedger(dir).pipe(Effect.provide(BunServices.layer))).toEqual([]);
      }).pipe(Effect.scoped, Effect.runPromise),
    20_000,
  );

  test(
    "the hourly run gives up at once while Isaac uses Soundly",
    () =>
      Effect.gen(function* () {
        const root = yield* tempHome;
        const dir = `${root}/state/sound`;
        yield* writeLedger(dir, [
          {
            key: "K-old",
            name: "Eva picks: old",
            query: "old",
            createdAt: "2026-11-01T00:00:00.000Z",
          },
        ]).pipe(Effect.provide(BunServices.layer));
        const app = fakeDesktop({ probe: busy });
        const signIns = { count: 0 };
        const tools = soundlyLayer(
          app.desktop,
          account([{ key: "K-old", name: "Eva picks: old", permissions: "Admin" }]).api,
          signIns,
        );
        yield* Effect.gen(function* () {
          expect(
            (yield* (yield* Runner).run("soundly-cleanup", "sweep", { scheduled: true })).ok,
          ).toBe(true);
          const swept = (yield* (yield* EventBus).history).find(
            (event) => event.type === "soundly-cleanup/collections.swept",
          );
          expect(swept?.data).toEqual({
            removed: [],
            deferred: "Isaac is using Soundly (in front, last input 3 s ago); left it alone",
          });
        }).pipe(Effect.provide(runtime(root, { code: [define({ ...cleanupSpec, tools })] })));
        expect(signIns.count).toBe(0);
        expect(app.log).toEqual(["restorePrompt"]);
      }).pipe(Effect.scoped, Effect.runPromise),
    20_000,
  );
});
