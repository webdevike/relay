---
phase: 02-shell-navigation-and-theme-tokens
plan: 02
subsystem: contract, eva-core
tags: [ipc, zod, sidebar, jobs, todos, journal]
requires: []
provides:
  - "contract channels: layout.*, theme.*, settings.*, eva.sidebar, app.setBackground, app.quit, quit-guard replies, app.hotkey and quit-guard events"
  - "eva-core readSidebar(root) with countOpenTodos, jobScheduled, parseDurationMs, recentJournal"
affects: [02-05, 02-06, 02-07, 02-08]
tech-stack:
  added: []
  patterns: ["hand-rolled Rust-parity parsers, read-only fs", "new output fields use .default() to keep old handlers valid"]
key-files:
  created:
    - packages/eva-core/src/sidebar/todos.ts
    - packages/eva-core/src/sidebar/jobs.ts
    - packages/eva-core/src/sidebar/journal.ts
    - packages/eva-core/src/sidebar/read.ts
    - packages/eva-core/src/sidebar/sidebar.test.ts
    - packages/contract/src/shell.ts
    - packages/contract/src/eva.ts
    - fixtures/eva-root/jobs/heartbeat/job.md
    - fixtures/eva-root/jobs/paused/job.md
    - fixtures/eva-root/jobs/manual/job.md
  modified:
    - packages/eva-core/src/index.ts
    - packages/contract/src/app.ts
    - packages/contract/src/index.ts
    - packages/contract/src/contract.test.ts
    - apps/desktop/src/main/app-ipc.ts
key-decisions:
  - "Readers mirror eva.rs and jobs.rs semantics on text; no yaml dependency"
requirements-completed: [SHEL-02, SHEL-03, SHEL-04, SHEL-05, SHEL-08, SETT-01, THEM-02]
duration: 15min
completed: 2026-10-15
---

# Phase 2 Plan 02: Contract channels and sidebar readers Summary

Zod-validated IPC channels for every Phase 2 need, plus read-only eva-core readers giving the fixture 2 open todos, 1 scheduled job and 3 recent journal entries.

## Tasks
1. eva-core sidebar readers and fixture jobs: 31d4b75
2. Contract channels: bd67256

## Deviations from Plan

**[Rule 3 - Blocking] app-ipc.ts handler type** The `noMotion` default makes the handler's output type require the field, so `apps/desktop/src/main/app-ipc.ts` returns `noMotion: false` as a placeholder until 02-05 wires the real value. Commit bd67256.

## Issues Encountered
- `pnpm` prints ERR_PNPM_OUTDATED_LOCKFILE on pre-run install because plan 02-01 added `@evaos/shell-core` and `@evaos/theme-core` to apps/desktop without updating pnpm-lock.yaml. Out of scope for this plan; tests and typecheck still run. Needs `pnpm install --lockfile-only` by 02-01 or the phase wrap-up.

## Verification
Full Vitest 217 passed; `pnpm -r typecheck` green; eslint and prettier clean on touched packages; no write APIs in sidebar readers.

## Self-Check: PASSED
