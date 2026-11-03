---
phase: 03-dashboard-workspaces-jobs-habits-and-meetings
plan: 03
subsystem: testing
tags: [fixtures, e2e, fakes, habit-gate, job-run]
requires: []
provides:
  - fixtures/eva-p3 token-dated template Eva root
  - fake habit gate and fake job-run scripts
  - makeEvaFixture and EXPECT_P3 helpers, fake-by-default e2e launch env
affects: [all Phase 3 e2e specs]
tech-stack:
  added: []
  patterns: [date-token fixture copy per test, env-selected fake binaries]
key-files:
  created:
    - fixtures/eva-p3/ (README, workspaces, memory, jobs incl. .runs, work/meetings)
    - fixtures/fake-gate/fake-gate.mjs
    - fixtures/fake-gate/README.md
    - fixtures/fake-job-run/fake-job-run.mjs
    - apps/desktop/e2e/helpers/eva-fixture.ts
    - apps/desktop/e2e/helpers/eva-fixture.test.ts
    - apps/desktop/e2e/helpers/fakes.test.ts
  modified:
    - apps/desktop/e2e/helpers/paths.ts
    - apps/desktop/e2e/fixtures.ts
key-decisions:
  - "eva-p3 README.md is documentation only and is not copied into the temp root, because it contains literal tokens."
metrics:
  completed: 2026-10-15
---

# Phase 3 Plan 03: Fixtures and fakes Summary

Token-dated fixture Eva root (`fixtures/eva-p3`) copied fresh per test by `makeEvaFixture()`, a stateful fake habit gate and a fake job-run, and e2e launch defaults that point every spec at the fakes with per-test state.

## Tasks

| Task | Commit |
|------|--------|
| 1. eva-p3 fixture with expected-numbers table | b722fc8 |
| 2. fake-gate and fake-job-run plus fakes.test.ts (9 tests) | see git log "fake habit gate and fake job-run" |
| 3. makeEvaFixture, EXPECT_P3, buildLaunchEnv defaults, tests (13 tests) | see git log "makeEvaFixture" |

## Verification

- `vitest run apps/desktop/e2e/helpers`: 22 passed.
- `pnpm -r typecheck` clean; `pnpm -C apps/desktop build` ok.
- sidebar.spec.ts and pages.spec.ts: 11 passed with the new launch defaults.
- fixtures/eva-root untouched.

## Deviations from Plan

- The plan's acceptance count `grep -c "^- \[ \] T" todos.md` = 6 is off by one: the "Tbad" row also matches, so it prints 7 (5 open numbered rows, Tbad, T14). Fixture content follows the plan text exactly.
- `README.md` in the template is skipped when copying (it documents tokens literally and would fail the "no `{{` left" check). Rule 3 fix.

## Known Stubs

None.

## Self-Check: PASSED
