# Native tooling: TypeScript 7, oxlint, oxfmt

Branch `eva/native-tooling` (worktree `work/relay-native-tooling`, off `origin/main` ae024fd9). Nothing was pushed to `main`; no e2e, Playwright, Electron or deploy was run.

## Summary

| Tool | Before | After | Status of the new tool |
|---|---|---|---|
| Type check | `tsc` 6.0.3 (5.9 in mobile) | **TypeScript 7.0.2 native `tsc`** (`@typescript/native` alias), `tsc6` kept as `typecheck:tsc6` | Stable (7.0 GA 2026-07-08) |
| Lint | ESLint 9 + typescript-eslint 8 (`strictTypeChecked` + `stylisticTypeChecked` in 8 packages, `recommended` for the desktop group) | **oxlint 1.91.0** + **tsgolint 7.0.2006** for type-aware rules. ESLint, typescript-eslint, `@eslint/js` and `@relay/eslint-config` are removed | oxlint stable; type-aware stable since tsgolint v7 (2026-07-22); JS plugins alpha (not used) |
| Format | Prettier 3 | **oxfmt 0.76.0** | **Beta** (since 2026-02-24, version 0.x), Prettier-3.9.9-compatible |
| CSS spacing | Stylelint 17 via `scripts/lint-spacing.ts` | unchanged | n/a |
| Em-dash lint | `scripts/lint-em-dash.ts` (uses the `typescript` JS API) | unchanged; `typescript` is now the `@typescript/typescript6` compat package, so it still works | n/a |
| Tests | Vitest | unchanged (Vitest 5.0.4 desktop, 3.2.x elsewhere); Playwright untouched | n/a |

Nothing we enforced is lost (rule-by-rule table below). The slim ESLint pass the brief allowed for is **not needed**: every ESLint and typescript-eslint rule we had turned on exists in oxlint or tsgolint, apart from `no-octal` (a parse error in strict mode anyway). The custom em-dash and spacing checks were never ESLint rules (standalone scripts), so they keep running as they were.

## 1. Research (what is stable, what is preview)

- **TypeScript 7.0 is out and stable.** Released 2026-07-08 ([announcement](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/)); `npm i typescript` now installs the Go-native `tsc` (npm `typescript@7.0.2`, `latest`). `@typescript/native-preview` (the old `tsgo` nightly package) is superseded: nightlies move to `typescript@next` (currently `7.1.0-dev`). Flags: `--checkers N` (default 4), `--builders N`, `--singleThreaded`; tried `--checkers 4` vs `8` on apps/desktop: no gain on this codebase. **Gap:** TS 7.0 ships **no JS compiler API** (a new one is expected in 7.1). Tools that `import "typescript"` need the side-by-side compat package `@typescript/typescript6` (provides `tsc6` and the TS 6 API). 7.0 also adopts 6.0 defaults (`strict`, `types: []`, `rootDir`), but our tsconfigs were already TS 6-clean, so no config change was needed.
- **oxlint 1.91.0** is stable. Built-in plugins: `eslint`, `typescript` (typescript-eslint rules), `unicorn`, `oxc`, `react` (eslint-plugin-react + react-hooks + react-refresh, plus experimental React Compiler rules), `import`, `jsx-a11y`, `jest`, `vitest`, `promise`, `node`, `jsdoc`, `nextjs`, `vue` ([plugin table](https://oxc.rs/docs/guide/usage/linter/plugins.html)). **Type-aware linting is stable** via tsgolint v7, which tracks TypeScript 7.0.2 and ports **59 of typescript-eslint's 61 type-aware rules** ([announcement](https://oxc.rs/blog/2026-07-22-type-aware-linting-stable.html)); enable with `oxlint --type-aware` (`--type-check` would also report compiler errors in the same pass). It needs the `oxlint-tsgolint` package. **JS plugins** (ESLint-API compatible) are **alpha** and cannot do type-aware rules ([docs](https://oxc.rs/docs/guide/usage/linter/js-plugins.html)). Nested `.oxlintrc.json` files and `extends` work; `// eslint-disable` comments are honoured, so the existing inline disables kept working.
- **oxfmt 0.76.0** is **beta** (announced 2026-02-24), Prettier-compatible (closest to Prettier v3.9.9), 30x faster than Prettier by its own benchmarks, formats JS/TS/JSX/TSX/JSON/YAML/MD/CSS etc. and has built-in import/Tailwind/package.json sorting (all off by default and left off here). `oxfmt --migrate=prettier` converted our `.prettierrc` overrides and `.prettierignore` directly. **Biome 2.6.5** is stable but its output diverges more: on the same desktop scope (TS/TSX/MJS/JSON only, hand-written config, no `biome migrate`) it would change **37 files** against oxfmt's **20 of 1253** (all 20 were `ts`/`tsx`, none md/json/yaml/css), so oxfmt won.

## 2. Timings

Machine: Apple Silicon Mac, load average 8 to 16 during every run (other sessions), so absolute numbers are noisy; both trees were measured back to back in the same session, 3 runs each. "Cold" = first run, "warm" = fastest of the next two. None of tsc/ESLint/oxlint/oxfmt keep a persistent cache, so cold vs warm only differs by the OS file cache. Every number includes `pnpm run` start-up (about 0.3s). "Before" = a clean `origin/main` worktree (`work/relay-nt-baseline`), "after" = this branch.

### Per-command timings

| Step | Before cold | Before warm | After cold | After warm | Speedup (warm) |
|---|---|---|---|---|---|
| typecheck apps/desktop (node+web) | 13.41s | 13.23s | 6.67s | 6.67s | 2.0x |
| typecheck browser-core | 0.43s | 0.39s | 0.40s | 0.29s | 1.3x |
| typecheck chat-core | 1.14s | 1.09s | 0.57s | 0.58s | 1.9x |
| typecheck contract | 1.17s | 1.13s | 0.78s | 0.96s | 1.2x |
| typecheck eva-core | 0.69s | 0.69s | 0.34s | 0.38s | 1.8x |
| typecheck shell-core | 0.48s | 0.46s | 0.30s | 0.32s | 1.4x |
| typecheck apps/linux | 6.33s | 4.62s | 2.28s | 2.35s | 2.0x |
| typecheck apps/mobile (14 pre-existing errors both) | 7.18s | 9.33s | 2.72s | 2.94s | 3.2x |
| typecheck ota-server | 1.28s | 1.14s | 0.37s | 0.36s | 3.2x |
| typecheck canvas-live | 1.68s | 1.62s | 0.38s | 0.37s | 4.4x |
| typecheck canvas-web (not installed here, 33 errors both) | 4.58s | 5.79s | 0.67s | 0.67s | 8.6x |
| typecheck portrait-motion | 3.39s | 2.03s | 0.37s | 0.33s | 6.2x |
| typecheck protocol | 6.40s | 6.93s | 1.00s | 1.16s | 6.0x |
| typecheck slack-emoji | 1.68s | 1.79s | 0.39s | 0.34s | 5.3x |
| typecheck widget-runtime | 7.54s | 2.34s | 0.51s | 0.45s | 5.2x |
| ESLint -> oxlint, desktop scope (1116 files) | 10.59s | 8.43s | 0.13s | 0.09s | 93.7x |
| Prettier --check -> oxfmt --check, desktop scope | 12.22s | 10.84s | 0.12s | 0.10s | 108.4x |
| em-dash script (unchanged) | 0.68s | 0.65s | 0.75s | 0.67s | 1.0x |
| spacing/stylelint script (unchanged) | 0.32s | 0.25s | 0.32s | 0.24s | 1.0x |
| pnpm lint, apps/desktop (all four steps) | 17.15s | 19.22s | 1.21s | 1.18s | 16.3x |
| lint apps/linux | 23.67s | 15.06s | 2.39s | 2.09s | 7.2x |
| lint apps/mobile | 11.81s | 13.09s | 4.68s | 3.75s | 3.5x |
| lint ota-server | 1.38s | 1.09s | 0.50s | 0.43s | 2.5x |
| lint canvas-live | 1.57s | 1.29s | 0.42s | 0.45s | 2.9x |
| lint portrait-motion | 1.34s | 1.30s | 0.46s | 0.46s | 2.8x |
| lint protocol | 2.78s | 2.78s | 1.06s | 1.23s | 2.3x |
| lint slack-emoji | 0.93s | 0.90s | 0.43s | 0.37s | 2.4x |
| lint widget-runtime | 2.16s | 2.04s | 0.47s | 0.38s | 5.4x |
| repo-wide format check (**/*.{ts,tsx,json,md,yaml}) | 13.65s | 15.46s | 0.30s | 0.25s | 61.8x |


Totals of the per-package warm numbers: **typecheck 52.6s to 18.2s**, **lint (desktop + 8 packages) 56.8s to 10.3s**; formatting check of the enforced desktop scope 10.8s to 0.1s.

Turbo (`turbo run <task> --filter=!@relay/mac --ui=stream --continue`; "cold" = `--force`; the Swift `apps/mac` is excluded). Turbo does not cache failed tasks, so any run that includes a red package re-runs it; the "green" rows leave out `@relay/mobile` (typecheck fails on both trees for a pre-existing reason, see below) and show a real cache hit:

| Task | Before cold | Before warm | After cold | After warm |
|---|---|---|---|---|
| `turbo run typecheck` (mobile red on both) | 7.79s | 5.35s | 3.45s | 2.39s |
| `turbo run typecheck --filter=!@relay/mobile` (all green) | 9.61s | 0.07s (cache hit) | 2.32s | 0.08s (cache hit) |
| `turbo run lint` (5 packages red on both) | 19.52s | 25.50s | 3.48s | 3.64s |

Notes on the table: the three unchanged scripts (em-dash 0.7s, spacing 0.25s) now dominate `pnpm lint` in apps/desktop (1.2s total). canvas-web is not installed in the worktree on the "before" side, so its 33 TS errors there are missing-dependency errors; after running `bun install` in it, TS 7 reports 0 errors (1.2s) and its 106 tests pass.

## 3. What changed

- **Typecheck.** Every package keeps `tsc --noEmit -p …` as its `typecheck` script; `tsc` now resolves to TS 7 because each install has `"@typescript/native": "npm:typescript@^7.0.2"` and `"typescript": "npm:@typescript/typescript6@~6.0.2"` (root, apps/desktop, apps/mobile, packages/widget-runtime, packages/canvas-web). Each package also has `typecheck:tsc6` (TS 6 fallback), plus root `pnpm typecheck:tsc6` and a `typecheck:tsc6` turbo task. canvas-web is installed by Bun, which links both packages' bins as `tsc`, so its scripts name the binary by path. mobile moved from TS 5.9.2 to the alias: it type-checks with the **same 14 errors** as before (see below); Expo's `expo/tsconfig.base` resolves fine under TS 7.
- **Errors that differ from tsc 5.x/6.x: none.** The error set (codes and files) of mobile (14) and canvas-web (33, uninstalled) is identical before and after; all other packages are clean on both.
- **Lint.** `.oxlintrc.json` at the root reproduces the old root ESLint config (desktop, desktop packages, `scripts/`). `tooling/oxlint-config/strict.json` replaces `tooling/eslint-config` (`strictTypeChecked` + `stylisticTypeChecked` + our extras) and is `extends`-ed by a small `.oxlintrc.json` in each of apps/linux, apps/ota-server, apps/mobile, canvas-live, portrait-motion, protocol, slack-emoji, widget-runtime, carrying that package's old per-package ignores and `no-console` overrides. Package `lint` scripts are `oxlint --type-aware <same dirs as before>`; apps/desktop `lint` is `oxlint` + `oxfmt --check` + the two scripts. `eslint`, `typescript-eslint`, `@eslint/js`, `prettier`, `@relay/eslint-config` and all `eslint.config.*` files are gone.
- **Format.** `.oxfmtrc.json` (migrated from `.prettierrc` + `.prettierignore`, same overrides: no-semi/single-quote for desktop, its packages and `scripts/`). Reformatting the enforced scope touched **20 files, +82/-26 lines** (mostly union types: oxfmt keeps the leading `|` that this Prettier dropped, plus one `if (!(` wrap). Root `pnpm format` / `pnpm format:check` now run oxfmt over the same `**/*.{ts,tsx,json,md,yaml}` glob as before; `pnpm -C apps/desktop format` writes the enforced scope. The repo-wide check already failed for 521 files under Prettier (non-desktop code is not enforced), and still reports unformatted files under oxfmt, as before.
- **CI / turbo / docs.** `.github/workflows/desktop.yml`: path filters (`.oxlintrc.json`, `.oxfmtrc.json`, `tooling/oxlint-config/**` instead of the ESLint/Prettier files), step name; its install, typecheck, lint, test, build commands are otherwise unchanged and still work (frozen-lockfile installs verified for the root, desktop and widget-runtime lockfiles). `turbo.json`: root configs added to `lint`/`typecheck` inputs, new `typecheck:tsc6` task. README, apps/desktop README, `scripts/gate.sh` text, and the TypeScript rows of apps/desktop `AGENTS.md`/`CLAUDE.md` (they said "do NOT take TS 7, typescript-eslint breaks") are updated.

## 4. Rule coverage: where every rule lives now

| What we enforced | Was in | Now in |
|---|---|---|
| ESLint core `recommended` (61 rules, e.g. `no-unused-vars` with `^_` ignores, `no-empty-pattern` with `allowObjectPatternsAsParameters`, `no-undef` for JS files) | root `eslint.config.mjs` (desktop group) | `.oxlintrc.json` (`eslint/*`). `scripts/**/*.mjs` globals kept as an override. `no-undef` is on for JS and off for TS, as typescript-eslint did |
| typescript-eslint `recommended` (17 rules) | root config | `.oxlintrc.json` (`typescript/*`) |
| ESLint `recommended` + typescript-eslint `strictTypeChecked` + `stylisticTypeChecked` (87 `typescript/*` rules incl. all type-aware ones, 64 core rules) | `@relay/eslint-config` in 8 packages | `tooling/oxlint-config/strict.json`, type-aware rules run by tsgolint under `--type-aware` |
| Extras: `consistent-type-imports` (inline), `no-unnecessary-condition`, `switch-exhaustiveness-check`, `restrict-template-expressions` (`allowNumber`), `no-console` (warn, allow warn/error) | `@relay/eslint-config` | same file; the per-package `no-console` offs in apps/linux and ota-server live in their `.oxlintrc.json` |
| Ignores (`out`, `release`, `fixtures`, vendored `openui/lang`, `dist`, mobile `ios/android/.expo`, widget-runtime `generated`, slack-emoji `build.ts`, …) | eslint configs | `ignorePatterns` in the matching `.oxlintrc.json` |
| Inline `// eslint-disable…` comments | source | still honoured by oxlint, unchanged |
| Em-dash in user-visible strings | `scripts/lint-em-dash.ts` (TS API) | unchanged, runs from `pnpm lint` in apps/desktop |
| Spacing scale for `padding/margin/gap` in renderer CSS | Stylelint via `scripts/lint-spacing.ts` + `stylelint.config.mjs` | unchanged |
| Prettier style (`semi`, `singleQuote`, width 100, trailing commas, per-directory overrides) | `.prettierrc` | `.oxfmtrc.json` |

Checked by diffing the effective ESLint config (`eslint --print-config`) against the oxlint config: the only enabled ESLint rules with no oxlint counterpart are `no-octal` (and `no-dupe-args`, same reason: superseded by strict mode, a syntax error in modules). `no-unnecessary-condition` and `prefer-optional-chain` are listed as "nursery" by `@oxlint/migrate` 1.90 but run fine in oxlint 1.91 and are enabled.

**Behaviour differences found by running both linters over the same files** (ESLint vs oxlint findings by file, line and rule, before removing ESLint):
- oxlint is slightly **stricter** in a few places: `no-unsafe-optional-chaining` flags `(a?.b as T).c` (9 hits in apps/linux tests, ESLint did not report them), and `prefer-optional-chain` found 4 more. These are real findings, not regressions.
- oxlint's `no-unused-vars` ignores `_`-prefixed names by default, which typescript-eslint never did. `strict.json` passes an options object, which turns that off, so `_x` is still reported in the strict packages (6 hits, same as ESLint), and the root config keeps its explicit `^_` patterns.
- Counts per package, ESLint then oxlint: linux 25 to 37, mobile 48 to 157, canvas-live 1 to 1, portrait-motion 13 to 13, protocol 9 to 9, ota-server 0 to 0, slack-emoji 0 to 0, widget-runtime 2 warnings to 2. The desktop group is 0 to 0. The mobile jump is almost entirely one pre-existing bug (next section).

## 5. Pre-existing problems found (not caused by this change, not fixed)

- **apps/mobile has `src/agents/Widget.tsx` and `src/agents/widget.ts`** (case-only name clash on macOS). `import … from "./widget"` is ambiguous: tsc reports TS1149 and TS2305 (in the 14 errors on both tsc versions), ESLint reported a parse error for it, and tsgolint types the imports as `error`, which is where about 98 `no-unsafe-*` findings in `Widget.tsx` come from. Renaming one of the files would clear them.
- Lint was already red before this change in apps/linux (25 ESLint errors), apps/mobile (49), canvas-live (1), portrait-motion (13), protocol (9): 97 errors, none of which gate CI (the desktop workflow only runs the desktop lint). The new numbers are in section 4.
- `apps/linux/test/canvas-pacing.test.ts` imports `bun:test` and fails under Vitest on both trees.
- `packages/widget-runtime/pnpm-lock.yaml` was committed Prettier-formatted (double quotes); regenerating it with pnpm rewrites the style, so it was re-formatted to keep the diff additive.

## 6. Vitest (no e2e)

`VITEST_MAX_WORKERS=2`, run on the new tree and on the baseline tree: identical results.

| Suite | Result after | Result before |
|---|---|---|
| apps/desktop workspace (desktop 253 files / 1979 tests, chat-core 351, eva-core 129, contract 93, shell-core 63, browser-core 27) | all pass | all pass |
| root workspace: mobile 746, protocol 199, ota-server 11, canvas-live 38, portrait-motion 33, slack-emoji 5, linux 586 | all pass except `canvas-pacing.test.ts` (`bun:test`, pre-existing) | same failure (plus one flaky linux test that failed in that run) |
| packages/widget-runtime | 22 pass | 22 pass |
| packages/canvas-web | 106 pass (installed with `bun install`) | not installed in the baseline worktree |

## 7. Lost, preview-only, and risks

**Lost:** nothing we enforced. Gained or changed: the handful of stricter hits above. ESLint's editor integration goes away; oxlint has its own language server / editor extension, which was not set up or tested here.

**Preview / not-1.0 pieces:** oxfmt is **beta, 0.x**: output can shift between releases (pin the version; this branch pins `^0.76.0`, so use an exact version if churn matters); it does not run Prettier plugins (we used none). oxlint JS plugins are alpha and unused. `no-unnecessary-condition` / `prefer-optional-chain` were nursery in the migration tool.

**Risks:**
1. **No JS API in TS 7.** Anything importing `typescript` must get the compat package; today that is `scripts/lint-em-dash.ts`. If a dependency hard-requires `typescript@7` as its peer (Expo 54 pins `~5.9.2`; `expo doctor` may warn about the alias, not tested), keep it on the alias or pin it by `overrides`. TS 7.1 is meant to bring a new API; revisit then. The compat package is 6.0.2 where the repo had 6.0.3 (pnpm installs report `tsc6 -v` as 6.0.3; bun resolved the alias to the real `typescript@6.0.3` in canvas-web).
2. **tsgolint is pinned to a TS version** (`7.0.2006` = TS 7.0.2). Bump `typescript` (native), `oxlint-tsgolint` and `oxlint` together.
3. **oxlint is not byte-identical to typescript-eslint**: stricter on a few rules (above); tsgolint ports 59 of typescript-eslint's 61 type-aware rules, and no rule we had enabled turned out to be missing.
4. **Type-aware lint in the isolated installs** (widget-runtime, desktop) uses the root `oxlint` and the root `tsgolint`; both must be installed (`pnpm install` at the root) before `pnpm lint` there. CI already does the root install first.
5. **Branch churn:** the 20 reformatted desktop and package files may conflict with open worktrees that touch the same union types; the `.prettierrc` / `eslint.config.*` deletions will conflict with branches editing them. Add the formatting commit to `.git-blame-ignore-revs` after merge.
6. **Lockfiles** changed in four places (root pnpm, apps/desktop pnpm, widget-runtime pnpm, canvas-web bun): the TS 7 per-platform binary packages were added and the ESLint tree removed (root lockfile: roughly 1070 to 1020 package entries).
7. TS 7 `--checkers` makes type-check results order-dependent in rare cases; the default (4) is used everywhere.

## Appendix: commands

```sh
pnpm typecheck            # TS 7 native tsc, via turbo
pnpm typecheck:tsc6       # TS 6 fallback
pnpm lint                 # oxlint (type-aware where configured), via turbo
pnpm -C apps/desktop lint # oxlint + oxfmt --check + em-dash + spacing
pnpm format               # oxfmt --write
pnpm format:check
```
