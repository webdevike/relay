---
phase: 03-dashboard-workspaces-jobs-habits-and-meetings
plan: 02
subsystem: main-process
tags: [env, spawn, seams, habits, jobs]
requires: []
provides:
  - "Env fields habitGateBin, jobRunBin, now, habitPhotosDir"
  - "main/eva/spawn.ts: resolveBun, buildCommand, childPathFor, spawnDetached, runCapture, recordSpawn"
affects: [03-13, 03-15, 03-16, 03-09]
tech-stack:
  added: []
  patterns: ["argv-only spawn, no shell", "fixture fakes by default, real tools only with EVAOS_LIVE=1"]
key-files:
  created:
    - apps/desktop/src/main/eva/spawn.ts
    - apps/desktop/src/main/eva/spawn.test.ts
  modified:
    - apps/desktop/src/main/env.ts
    - apps/desktop/src/main/env.test.ts
key-decisions:
  - "Non-live defaults point at fixtures/fake-gate and fixtures/fake-job-run (created by 03-03)"
  - "EVAOS_NOW validated at startup with Date.parse; unparsable value throws"
duration: 10min
completed: 2026-10-15
requirements: [JOBS-03, HABT-01, HABT-02]
---

# Phase 3 Plan 02: Process seams Summary

Env seams (EVAOS_HABIT_GATE_BIN, EVAOS_JOB_RUN_BIN, EVAOS_NOW, EVAOS_HABIT_PHOTOS_DIR) default to fakes outside live mode, and one spawn module runs bun `.ts` tools and node `.mjs` fakes via argv only, detached (unref'd, never signalled) or captured with a timeout.

## Tasks

| Task | Commit |
|------|--------|
| 1 Env seams | 0b1dfb5 |
| 2 Spawn helper | 06420d6 |

## Verification

env.test.ts (11 tests), spawn.test.ts (8 tests), write-scan test, `pnpm -r typecheck`, eslint on main: all green. No `shell: true`, `exec(` or `.kill(` in spawn.ts.

## Deviations from Plan

None. The fake scripts referenced by the default paths do not exist until plan 03-03.

## Known Stubs

None.

## Self-Check: PASSED
