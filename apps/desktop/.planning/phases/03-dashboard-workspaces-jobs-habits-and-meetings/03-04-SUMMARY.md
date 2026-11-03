---
phase: 03-dashboard-workspaces-jobs-habits-and-meetings
plan: 04
subsystem: eva-core data model
tags: [parsers, dashboard, workspaces, todos, tdd]
requires: []
provides:
  - Electron-free ports of eva.rs, dashboard.rs and workspace.rs rules under packages/eva-core/src/model
  - readDashboard, readWorkspaceDetail, readTodoTexts read-only readers
  - appendTodo pure append with whole-text next-id scan
affects: [03-07, 03-08, 03-09, 03-11, 03-12]
tech-stack:
  added: []
  patterns: [line-oriented parsers, pure builders wrapped by one fs module]
key-files:
  created:
    - packages/eva-core/src/model/tags.ts
    - packages/eva-core/src/model/plain.ts
    - packages/eva-core/src/model/dates.ts
    - packages/eva-core/src/model/journal.ts
    - packages/eva-core/src/model/todos.ts
    - packages/eva-core/src/model/workspaces.ts
    - packages/eva-core/src/model/dashboard.ts
    - packages/eva-core/src/model/read-eva.ts
    - packages/eva-core/src/model/text.test.ts
    - packages/eva-core/src/model/todos.test.ts
    - packages/eva-core/src/model/workspaces.test.ts
    - packages/eva-core/src/model/dashboard.test.ts
    - packages/eva-core/src/model/__fixtures__/real-todos.md
    - packages/eva-core/src/model/__fixtures__/real-todos-done.md
  modified:
    - packages/eva-core/src/sidebar/todos.ts
    - .prettierignore
key-decisions:
  - "countOpenTodos now uses the shared isOpenTodoRow, so sidebar count and dashboard rows cannot disagree"
  - "Workspace.name is the raw H1 text; displayName is the shortened form; sorting ties break on displayName (Rust parity)"
  - "Section bodies keep leading blank lines and drop trailing ones, as the plan states"
  - "buildWorkspaceDetail added to dashboard.ts as the pure core of readWorkspaceDetail"
requirements-completed: [DASH-01, DASH-02, DASH-03, DASH-04, DASH-05, DASH-07, DASH-08]
duration: ~20 min
completed: 2026-10-15
---

# Phase 3 Plan 04: Dashboard data rules Summary

Exact TypeScript ports of the Rust Eva data rules (workspaces, tagged journal activity, open todos, next todo id and append, filters, summary line, 7/30/90 day activity) with the Rust unit vectors translated and snapshot tests on Isaac's real todo files.

## Tasks

| Task | Commits |
| ---- | ------- |
| 1 Text, date, journal and todo rules | 6869e04 (test), ded4179 (feat) |
| 2 Workspaces, dashboard, readers | test and feat commits for 03-04 (see git log) |

## Verification

- eva-core Vitest: 73 tests green; full repo Vitest 487 green; typecheck, eslint and em-dash lint clean.
- Real-file snapshot confirms the research numbers unchanged: max ids 75 and 78, next id T79, 24 open rows.
- Only `read-eva.ts` imports `node:fs` among non-test model modules; no `yaml` dependency (D14).

## Deviations from Plan

**1. [Rule 3 - Blocking] Prettier rewrote the byte-for-byte fixtures**
- Found during: Task 2 formatting pass
- Fix: restored the fixtures from git and added `packages/eva-core/src/model/__fixtures__` to `.prettierignore`; verified `cmp` against the live files.

**2. [Rule 3 - Blocking] Em dash escapes were normalised to literals by the editor**
- Fix: restored the `—` escape in plain.ts and tests so lint-em-dash passes.

Otherwise the plan executed as written.

## Known Stubs

None.

## Self-Check: PASSED
