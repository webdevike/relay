import { describe, expect, test } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { Effect } from "effect";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  probeSource,
  rosterLosses,
  sourceRefusals,
  type SourceFacts,
} from "../src/core/InstallGate.ts";

const facts = (over: Partial<SourceFacts>): SourceFacts => ({
  commit: "a".repeat(40),
  dirty: [],
  base: "origin/main",
  onBase: true,
  installed: "b".repeat(40),
  relation: "contains",
  ...over,
});

describe("source gate", () => {
  test("a clean checkout on base that contains the installed commit passes", () => {
    expect(sourceRefusals(facts({}))).toEqual([]);
    expect(sourceRefusals(facts({ installed: undefined, relation: "none" }))).toEqual([]);
  });

  test("a stale or unmerged worktree is refused with each reason", () => {
    expect(sourceRefusals(facts({ onBase: false, relation: "behind" }))).toEqual([
      "the source aaaaaaaa is not on origin/main (not an ancestor-or-equal of it)",
      "the source aaaaaaaa is behind the installed bbbbbbbb",
    ]);
    expect(sourceRefusals(facts({ relation: "diverged" }))).toEqual([
      "the source aaaaaaaa does not contain the installed bbbbbbbb (diverged)",
    ]);
    expect(sourceRefusals(facts({ dirty: ["M src/cli.ts"] }))).toEqual([
      "the source has uncommitted changes (1): M src/cli.ts",
    ]);
    expect(sourceRefusals(facts({ onBase: undefined, relation: "unknown" }))).toHaveLength(2);
    expect(sourceRefusals(facts({ commit: undefined }))).toHaveLength(1);
  });
});

describe("roster gate", () => {
  test("the 2026-11-18 drop: an agent loaded now and set live in config.json, missing from the new copy", () => {
    const loaded = [{ id: "widget" }, { id: "ecard-main-watch" }, { id: "gmail" }];
    const next = [{ id: "widget" }, { id: "gmail" }];
    expect(
      rosterLosses(loaded, next, { components: { "ecard-main-watch": { mode: "live" } } }),
    ).toEqual([{ id: "ecard-main-watch", why: "loaded now, not in the new roster" }]);
  });

  test("an agent config.json counts on (live or shadow) is a loss even when nothing loads it now", () => {
    expect(
      rosterLosses([{ id: "widget" }], [{ id: "widget" }], {
        components: {
          "ecard-main-watch": { mode: "live" },
          "ecard-slack-triage": { mode: "shadow" },
          retired: { mode: "off" },
          parked: { enabled: false, mode: "shadow" },
          widget: { mode: "live" },
          tuned: {},
        },
      }),
    ).toEqual([
      { id: "ecard-main-watch", why: "config.json mode live, not in the new roster" },
      { id: "ecard-slack-triage", why: "config.json mode shadow, not in the new roster" },
    ]);
  });

  test("a file that no longer loads in the new copy is a loss; one already broken now is not", () => {
    expect(
      rosterLosses(
        [{ id: "a" }, { id: "b", error: "bad yaml" }],
        [
          { id: "a", error: "unknown event" },
          { id: "b", error: "bad yaml" },
        ],
        {},
      ),
    ).toEqual([{ id: "a", why: "loaded now, fails to load in the new copy: unknown event" }]);
  });

  test("a first install only answers to config.json", () => {
    expect(rosterLosses(undefined, [{ id: "a" }], { components: { a: { mode: "live" } } })).toEqual(
      [],
    );
  });
});

/** A repo with main at A then B, a branch `side` off A with C, and the given working-tree change. */
const repo = () => {
  const dir = mkdtempSync(join(tmpdir(), "install-gate-"));
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], {
      cwd: dir,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@t",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@t",
      },
    });
    if (result.exitCode !== 0)
      throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
    return result.stdout.toString().trim();
  };
  git("init", "-q", "-b", "main");
  const commit = (name: string) => {
    writeFileSync(join(dir, `${name}.txt`), name);
    git("add", ".");
    git("commit", "-q", "-m", name);
    return git("rev-parse", "HEAD");
  };
  const a = commit("a");
  const b = commit("b");
  git("checkout", "-q", "-b", "side", a);
  const c = commit("c");
  return { dir, git, a, b, c };
};

const probe = (dir: string, installed: string | undefined) =>
  Effect.runPromise(
    probeSource(dir, ["."], "main", installed).pipe(Effect.provide(BunServices.layer)),
  );

describe("probeSource", () => {
  test("reads where a checkout stands against main and the installed commit", async () => {
    const { dir, git, a, b, c } = repo();
    try {
      // On `side` (C, off A): not on main, and it does not contain the installed B.
      expect((await probe(dir, b)).facts).toMatchObject({
        commit: c,
        onBase: false,
        relation: "diverged",
        dirty: [],
      });
      git("checkout", "-q", a);
      expect((await probe(dir, b)).facts).toMatchObject({
        commit: a,
        onBase: true,
        relation: "behind",
      });
      git("checkout", "-q", "main");
      expect((await probe(dir, a)).facts).toMatchObject({
        commit: b,
        onBase: true,
        relation: "contains",
      });
      expect((await probe(dir, "f".repeat(40))).facts.relation).toBe("unknown");
      writeFileSync(join(dir, "b.txt"), "edited");
      writeFileSync(join(dir, "new.txt"), "untracked");
      expect((await probe(dir, undefined)).facts).toMatchObject({
        relation: "none",
        dirty: ["M b.txt", "?? new.txt"],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
