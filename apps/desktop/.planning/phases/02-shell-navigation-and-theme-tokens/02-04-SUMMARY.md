---
phase: 02-shell-navigation-and-theme-tokens
plan: 04
subsystem: theme
tags: [theme-core, tokens, css-variables, vitest]
requires: [02-01]
provides:
  - "@evaos/theme-core: COLOR_KEYS (139), EVAOS_LIGHT/DARK, BASE_LIGHT/DARK, ThemeDoc, resolveTheme, colorVars, shapeVars"
affects: [02-07]
tech-stack:
  added: []
  patterns: ["generated kit base committed, no runtime derivation"]
key-files:
  created:
    - packages/theme-core/src/keys.ts
    - packages/theme-core/src/bundled.ts
    - packages/theme-core/src/base-light.ts
    - packages/theme-core/src/base-dark.ts
    - packages/theme-core/src/doc.ts
    - packages/theme-core/src/resolve.ts
    - packages/theme-core/src/vars.ts
    - packages/theme-core/src/theme-core.test.ts
    - packages/theme-core/scripts/gen-base.ts
  modified:
    - packages/theme-core/src/index.ts
    - .prettierignore
key-decisions:
  - "Generated base files are prettier-ignored so re-running gen-base.ts yields no diff"
  - "src imports are extensionless (tsc without allowImportingTsExtensions); only the script uses .ts"
duration: 20min
completed: 2026-10-15
---

# Phase 2 Plan 04: theme-core tokens Summary

Electron-free `@evaos/theme-core` resolves all 139 kit color keys per mode (kit base from a committed generator porting gpui-component 0.7.0 `apply_config` fallbacks, then verbatim bundled EvaOS themes, then doc edits) and maps them to `--eva-c-*` plus shape variables.

## Tasks

| Task | Commit |
| ---- | ------ |
| 1 Keys, bundled themes, generated base | cd4a0ba |
| 2 ThemeDoc, resolveTheme, vars | e233112 |

12 Vitest tests pass; typecheck, eslint and prettier clean; `pnpm -r typecheck` green.

## Deviations from Plan

- **[Rule 1 - Bug]** gen-base.ts skips unknown keys in default-theme.json (`description_list_label.foreground` typo, ignored by the kit via serde) instead of failing.
- **[Rule 3 - Blocking]** Source imports use extensionless specifiers (tsc rejects `.ts` here); `.prettierignore` gained the two generated files.
- Tests and implementation were written together (no separate RED commit).
- The generator uses float64 and rounds hex rather than gpui's f32 truncation (at most 1 unit per channel; noted in the script header). Literal hex values in the default theme are copied exactly.

## Known Stubs

None.

## Self-Check: PASSED
