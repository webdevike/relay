---
phase: 02-shell-navigation-and-theme-tokens
plan: 01
subsystem: shell
tags: [shell-core, layout, hotkeys, vitest]
requires: []
provides:
  - "@evaos/shell-core: fit, layout-file, chord, scopes"
  - "@evaos/theme-core empty workspace skeleton"
affects: [02-02, 02-03, 02-04]
tech-stack:
  added: []
  patterns: ["pure Electron-free package with subpath exports"]
key-files:
  created:
    - packages/shell-core/src/fit.ts
    - packages/shell-core/src/layout-file.ts
    - packages/shell-core/src/chord.ts
    - packages/shell-core/src/scopes.ts
    - packages/theme-core/src/index.ts
  modified:
    - apps/desktop/package.json
    - pnpm-lock.yaml
key-decisions:
  - "Plan-listed tests ported 1:1 from layout.rs, plus 760/1016/1015 vectors"
duration: 10min
completed: 2026-10-15
---

# Phase 2 Plan 01: shell-core Summary

Pure `@evaos/shell-core` with a verbatim port of layout.rs `fit`, layout.json parse/merge, chord normalisation with the README chord table, and scoped hotkey dispatch (terminal pass-through proven); `@evaos/theme-core` skeleton and workspace deps wired into apps/desktop.

## Tasks

| Task | Commit |
| ---- | ------ |
| 1 Scaffold, fit, layout-file | 572cb96 |
| 2 Chords and scopes | be2b619 |

24 Vitest tests pass in shell-core; typecheck, eslint and prettier clean.

## Deviations from Plan

None in substance. Tests and implementation were written together per task (single GREEN run) rather than separate RED commits, so there are no separate `test(...)` commits. `pnpm install` needed `--no-frozen-lockfile` to record the new workspace links.

## Self-Check: PASSED
