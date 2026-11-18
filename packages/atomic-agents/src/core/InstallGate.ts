import { Effect, Schema } from "effect";
import { exec } from "./exec.ts";
import { Mode } from "./RuntimeEvents.ts";

/**
 * What `service install` checks before it replaces the running copy. Each check answers reasons; any reason refuses
 * the install unless `--force`, which prints the same reasons and goes on. Two gates:
 * - the source: a clean git checkout whose HEAD is on `base` (ancestor-or-equal of `origin/main` by default) and
 *   contains the installed commit, so a stale or unmerged worktree cannot replace newer code;
 * - the roster: the new copy loads every agent the installed copy loads, and every agent config.json sets to
 *   `live` or `shadow`, so a reinstall cannot drop coverage.
 */

/** Where the source stands against the installed commit (`<home>/app/source.json`). */
export type InstalledRelation = "none" | "contains" | "behind" | "diverged" | "unknown";

export interface SourceFacts {
  /** HEAD of the source checkout; undefined when it is not a git checkout. */
  readonly commit: string | undefined;
  /** Changed or untracked paths (git status --porcelain lines) in what the install copies. */
  readonly dirty: ReadonlyArray<string>;
  readonly base: string;
  /** HEAD is an ancestor-or-equal of `base`; undefined when git cannot resolve `base`. */
  readonly onBase: boolean | undefined;
  readonly installed: string | undefined;
  readonly relation: InstalledRelation;
}

const short = (commit: string) => commit.slice(0, 8);

export const sourceRefusals = (facts: SourceFacts): ReadonlyArray<string> => {
  if (facts.commit === undefined)
    return [`the source is not a git checkout, so it cannot be checked against ${facts.base}`];
  const head = short(facts.commit);
  const reasons: string[] = [];
  if (facts.dirty.length > 0) {
    const shown = facts.dirty.slice(0, 10).join(", ");
    reasons.push(
      `the source has uncommitted changes (${facts.dirty.length}): ${shown}${facts.dirty.length > 10 ? ", ..." : ""}`,
    );
  }
  if (facts.onBase === undefined)
    reasons.push(`cannot resolve ${facts.base} to check the source against it`);
  else if (!facts.onBase)
    reasons.push(`the source ${head} is not on ${facts.base} (not an ancestor-or-equal of it)`);
  const installed = facts.installed === undefined ? "" : short(facts.installed);
  if (facts.relation === "behind")
    reasons.push(`the source ${head} is behind the installed ${installed}`);
  else if (facts.relation === "diverged")
    reasons.push(`the source ${head} does not contain the installed ${installed} (diverged)`);
  else if (facts.relation === "unknown")
    reasons.push(`the installed commit ${installed} is unknown to the source's repo`);
  return reasons;
};

/** The profile a service has no `--profile` for: personal. The caller's own OMP_PROFILE never decides it. */
export const DEFAULT_PROFILE = "personal";

/** `OMP_PROFILE` in a LaunchAgent plist's environment; undefined when the plist is unreadable or sets none. */
export const plistProfile = (plist: string | undefined): string | undefined =>
  plist === undefined
    ? undefined
    : /<key>OMP_PROFILE<\/key>\s*<string>([^<]*)<\/string>/.exec(plist)?.[1];

/** Replacing a service must not switch its profile silently: reasons when the installed plist's differs from `next`. */
export const profileRefusals = (
  installed: { readonly exists: boolean; readonly profile: string | undefined },
  next: string,
): ReadonlyArray<string> =>
  !installed.exists || installed.profile === next
    ? []
    : [
        `the installed service runs OMP_PROFILE=${installed.profile ?? "(unset)"} and this install would write OMP_PROFILE=${next}; ${installed.profile === undefined ? "" : `pass --profile ${installed.profile} to keep it, or `}--force to switch`,
      ];

export interface Loss {
  readonly id: string;
  readonly why: string;
}

/** The part of config.json the roster gate reads; every other key is ignored here (`Settings` validates the file). */
export const ConfigModes = Schema.Struct({
  components: Schema.optionalKey(
    Schema.Record(
      Schema.String,
      Schema.Struct({
        enabled: Schema.optionalKey(Schema.Boolean),
        mode: Schema.optionalKey(Mode),
      }),
    ),
  ),
});
export type ConfigModes = typeof ConfigModes.Type;

/** `list --json` rows, as far as the gate reads them; `error` is set on a file that does not load (no version in force). */
export const RosterRows = Schema.Array(
  Schema.Struct({ id: Schema.String, error: Schema.optionalKey(Schema.String) }),
);
export type RosterRow = (typeof RosterRows.Type)[number];

/** Modes that mean a consumer counts on the agent: its answers are logged (`shadow`) or used (`live`). */
const COVERED: ReadonlyArray<Mode> = ["live", "shadow"];

/** Every config.json `components.<id>` with mode live or shadow and not `enabled: false`: agents a consumer counts on. */
export const countedOn = (
  config: ConfigModes,
): ReadonlyArray<{ readonly id: string; readonly mode: Mode }> =>
  Object.entries(config.components ?? {}).flatMap(([id, own]) =>
    own.enabled === false || own.mode === undefined || !COVERED.includes(own.mode)
      ? []
      : [{ id, mode: own.mode }],
  );

/**
 * What the new roster would lose: each agent the installed copy loads (`loaded`, undefined on a first install) and
 * each agent config.json counts on (`countedOn`), that the new copy does not load.
 */
export const rosterLosses = (
  loaded: ReadonlyArray<RosterRow> | undefined,
  next: ReadonlyArray<RosterRow>,
  config: ConfigModes,
): ReadonlyArray<Loss> => {
  const nextLoads = new Map(next.map((row) => [row.id, row.error]));
  const missing = (id: string) => {
    if (!nextLoads.has(id)) return "not in the new roster";
    const error = nextLoads.get(id);
    return error === undefined ? undefined : `fails to load in the new copy: ${error}`;
  };
  const losses = new Map<string, string>();
  for (const row of loaded ?? []) {
    if (row.error !== undefined) continue;
    const why = missing(row.id);
    if (why !== undefined) losses.set(row.id, `loaded now, ${why}`);
  }
  for (const { id, mode } of countedOn(config)) {
    if (losses.has(id)) continue;
    const why = missing(id);
    if (why !== undefined) losses.set(id, `config.json mode ${mode}, ${why}`);
  }
  return [...losses].map(([id, why]) => ({ id, why }));
};

const git = (cwd: string, ...args: ReadonlyArray<string>) =>
  exec("git", args, { cwd }).pipe(
    Effect.orElseSucceed(() => ({ stdout: "", stderr: "git did not run", exitCode: -1 })),
  );

/** `git merge-base --is-ancestor a b`: true, false, or undefined when git cannot tell (an unknown ref). */
const isAncestor = (cwd: string, a: string, b: string) =>
  Effect.map(git(cwd, "merge-base", "--is-ancestor", a, b), (result) =>
    result.exitCode === 0 ? true : result.exitCode === 1 ? false : undefined,
  );

/**
 * The facts `sourceRefusals` judges, read from the checkout at `dir` (`paths` are what the install copies, relative to
 * `dir`). `base` (`<remote>/<branch>`) is fetched first; a failed fetch leaves the local ref and is reported in `warning`.
 */
export const probeSource = (
  dir: string,
  paths: ReadonlyArray<string>,
  base: string,
  installed: string | undefined,
) =>
  Effect.gen(function* () {
    const head = yield* git(dir, "rev-parse", "HEAD");
    const commit = head.exitCode === 0 ? head.stdout.trim() : undefined;
    if (commit === undefined)
      return {
        facts: {
          commit,
          dirty: [],
          base,
          onBase: undefined,
          installed,
          relation: "unknown",
        } satisfies SourceFacts,
        warning: undefined,
      };
    const status = yield* git(dir, "status", "--porcelain", "--", ...paths);
    const dirty = status.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const slash = base.indexOf("/");
    const fetched =
      slash > 0
        ? yield* git(dir, "fetch", "--quiet", base.slice(0, slash), base.slice(slash + 1))
        : undefined;
    const warning =
      fetched !== undefined && fetched.exitCode !== 0
        ? `could not fetch ${base} (${fetched.stderr.trim()}); checked against the local ref`
        : undefined;
    const onBase = yield* isAncestor(dir, commit, base);
    let relation: InstalledRelation = "none";
    if (installed !== undefined) {
      const known = (yield* git(dir, "cat-file", "-e", `${installed}^{commit}`)).exitCode === 0;
      if (!known) relation = "unknown";
      else if ((yield* isAncestor(dir, installed, commit)) === true) relation = "contains";
      else relation = (yield* isAncestor(dir, commit, installed)) === true ? "behind" : "diverged";
    }
    return {
      facts: { commit, dirty, base, onBase, installed, relation } satisfies SourceFacts,
      warning,
    };
  });
