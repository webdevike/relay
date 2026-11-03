---
phase: 03-dashboard-workspaces-jobs-habits-and-meetings
plan: 05
subsystem: eva-core
tags: [jobs, frontmatter, tdd]
requires: []
provides:
  - JobDoc byte-preserving job.md line editor
  - parseDuration, nameError, validateJob, nextDue, scheduleLabel, agoLabel, untilLabel, JOB_COPY
  - listJobs, readJobRun, isLockLive (read-only jobs/.runs reader)
affects: [03-08, 03-13, 03-14]
tech-stack:
  added: []
  patterns: [immutable line editor, injectable pidAlive and fileExists seams]
key-files:
  created:
    - packages/eva-core/src/model/jobs.ts
    - packages/eva-core/src/model/jobs.test.ts
    - packages/eva-core/src/model/jobs-read.ts
    - packages/eva-core/src/model/jobs-read.test.ts
  modified: []
key-decisions:
  - "Follow the runner over UI-SPEC (D1 to D6): keep is a duration, runner name regex, full duration units, Every/Manual labels, steps required, run badge mapping"
  - "nextDue returns 0 (due now) when a scheduled job never ran, per plan, rather than Rust's every-ms value"
  - "Dead lock pid is ignored, unreadable lock counts as live"
requirements-completed: [JOBS-01, JOBS-02, JOBS-03]
duration: 10min
completed: 2026-10-15
---

# Phase 3 Plan 05: Jobs data rules Summary

Runner-parity Jobs layer in eva-core: a line-oriented, byte-preserving `JobDoc` editor for `job.md`, validation, durations and labels, plus a read-only reader for `jobs/` and `jobs/.runs/` with pid-liveness lock checks.

## Tasks

| Task | Commit |
|------|--------|
| 1 RED tests | f2ebba2 |
| 1 JobDoc, durations, validation, labels | 8bda666 |
| 2 RED tests | 27e3304 |
| 2 jobs-read reader | 29592ce |

18 tests in jobs.test.ts, 8 in jobs-read.test.ts. Full eva-core suite (110 tests), `pnpm -r typecheck`, eslint and em-dash lint are green.

## Deviations from Plan

None to the plan's behavior. Small notes:
- `JobDoc` is immutable (apply, setEnabled, withSteps return new docs), as the interface listed, rather than Rust's mutating API.
- `listJobs` accepts `nowMs` per the interface but does not use it; run state does not depend on the clock.
- `nextDue` for a never-run scheduled job returns 0, matching the plan and the "due now" label, which differs from the Rust crate (which returns every ms).

## Known Stubs

None.

## Threat Flags

None. The reader only reads; the only process interaction is `process.kill(pid, 0)`, which sends no signal.

## Self-Check: PASSED
