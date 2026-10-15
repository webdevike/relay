---
phase: 03-dashboard-workspaces-jobs-habits-and-meetings
plan: 13
subsystem: jobs
tags: [jobs, ipc, evafs, e2e]
requires: [03-01, 03-02, 03-03, 03-05, 03-08, 03-12]
provides:
  - main jobs.list, jobs.get, jobs.save, jobs.setEnabled, jobs.delete, jobs.run handlers
  - jobsStore (loadJobs, setJobEnabled, openJobForm, closeJobForm) and formatNextDue for 03-14
  - JobsPage (page-jobs) registered for the jobs place
key-files:
  created:
    - apps/desktop/src/main/eva/jobs-ipc.ts
    - apps/desktop/src/main/eva/jobs-ipc.test.ts
    - apps/desktop/src/renderer/jobs/JobsPage.tsx
    - apps/desktop/src/renderer/jobs/jobs-store.ts
    - apps/desktop/src/renderer/jobs/job-format.ts
    - apps/desktop/src/renderer/jobs/jobs.css
    - apps/desktop/e2e/jobs.spec.ts
  modified:
    - apps/desktop/src/main/eva-ipc.ts
    - apps/desktop/src/renderer/pages/registry.ts
    - apps/desktop/e2e/pages.spec.ts
    - apps/desktop/e2e/workspace.spec.ts
decisions:
  - Handlers are pure functions over (root, evaFs, clock/spawner) so tests inject temp roots and a fake spawner
  - Create renders front matter only for non-default settings; update uses EvaFs.edit with the form basis as expected (refuse, never retry)
  - The refusal e2e makes the job folder read-only (deleting job.md would make the watcher drop the row)
metrics:
  tasks: 3
  completed: 2026-10-15
---

# Phase 3 Plan 13: Jobs list and toggle Summary

Jobs page listing schedule, last run with state badge, next due and an optimistic enabled switch that rewrites only the `enabled` line; main now implements the full jobs channel set so 03-14 is UI only.

## Commits

- feat(03-13): main jobs channels
- feat(03-13): Jobs page with enabled switch
- style(03-13): prettier and test wording
- test(03-12): force dark appearance for the workspace dark proof (regenerated workspace-dark, -light, -missing)
- test(03-13): jobs e2e with proof

## Verification

- Vitest: jobs-ipc (9), renderer jobs (12), full renderer suite green; typecheck, eslint, em-dash lint and build clean.
- e2e: jobs (3) and pages (6) pass against the built app: row order, 4 scheduled badge, Every 2h / Manual, ok / failed / never run, Due now, one-line toggle in job.md with count 3 then 4, refused write reverts with toast.
- Proof: `proof/phase-3/jobs-list-dark.png`, `jobs-list-light.png` (dark now set explicitly through the appearance control).
- No `.kill(` in jobs-ipc.ts; `Daily` absent from jobs sources (D4).

## Deviations from Plan

- **[Rule 1 - Bug] Dark proof was light:** workspace-dark was captured on System appearance; the spec now clicks `appearance-dark` first and the shots were regenerated (requested).
- jobs.run real spawner (`buildCommand` plus `spawnDetached` plus `recordSpawn`) is exercised through a fake spawner in unit tests; the real wiring is covered by typecheck only. Job form is 03-14.
- Jobs page test list is in-file: `Daily` check built with a split regex so the acceptance grep stays 0.

## Self-Check: PASSED
