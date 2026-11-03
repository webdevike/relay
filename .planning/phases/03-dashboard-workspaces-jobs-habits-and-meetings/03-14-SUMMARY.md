---
phase: 03-dashboard-workspaces-jobs-habits-and-meetings
plan: 14
subsystem: jobs
tags: [jobs, form, e2e, quit-guard]
requires: [03-13]
provides:
  - JobForm modal (create, edit, Run now, Open last session, inline Delete) mounted by JobsPage
  - pure job-form-model (initialForm, formErrors, isDirty, toSaveInput)
key-files:
  created:
    - apps/desktop/src/renderer/jobs/job-form-model.ts
    - apps/desktop/src/renderer/jobs/job-form-model.test.ts
    - apps/desktop/src/renderer/jobs/JobForm.tsx
    - apps/desktop/src/renderer/jobs/JobForm.test.tsx
    - apps/desktop/src/renderer/jobs/job-form.css
    - apps/desktop/e2e/job-form.spec.ts
  modified:
    - apps/desktop/src/renderer/jobs/JobsPage.tsx
decisions:
  - Name is not re-validated in edit mode (read-only title)
  - Keep editing re-reads job.md and adopts it as the save basis while field edits stay; the dirty baseline is unchanged
  - Form body scrolls with a sticky footer so the 560px modal fits small windows
metrics:
  tasks: 3
  completed: 2026-10-15
---

# Phase 3 Plan 14: Job form Summary

Job create/edit modal with runner-correct inline validation, stale-save refusal banner, quit-guard entry, and Run now / Open last session / inline Delete, proven end to end including the real `jobs.run` spawn path against the fake job-run.

## Commits

- feat(03-14): job form modal with validation, stale-save banner, footer actions (tasks 1 and 2 share JobForm.tsx, so one commit)
- test(03-14): job form e2e with proof

## Verification

- Vitest renderer: 241 pass (model 2, JobForm 8); typecheck, eslint, prettier, em-dash lint, build clean.
- e2e job-form (7) and jobs (3) pass; rerun with EVAOS_PROOF=1 wrote `proof/phase-3/job-form-validation.png`, `job-form-changed-on-disk.png`, `job-form-edit.png` (dark).
- Run now e2e (requested addition): the real `buildCommand` + `spawnDetached` + `recordSpawn` path runs in the built app with EVAOS_JOB_RUN_BIN. Asserted: the fake's job log has one entry with argv `['nightly']` and cwd equal to the temp Eva root; the main-process `spawnLog` hook shows one `job-run` spawn whose argv contains the fake script path and ends in `nightly` (no bun, no real job); the fake's observable effects: `jobs/.runs/nightly.lock` appears, row shows `running`, lock disappears, exactly one new run dir has `status.json` state `done` note `fake exit 0`, row then shows `ok` and `just now`.
- Edit diff test: only `every: 2h` becomes `every: 3h`; comment line and body untouched. Stale test: file keeps the external content, Save disabled until Reload or Keep editing.
- Quit guard: dirty form listed as `Job nightly`.

## Deviations from Plan

- Tasks 1 and 2 committed together (same file).
- [Rule 1 - Bug] Modal overflowed an 800px window and clipped the footer (seen in the proof screenshot); added scroll with sticky footer in job-form.css.
- e2e checks form visibility through inner testids because the `job-form` testid lands on Mantine's zero-size Modal root.
- Quit-guard test switches the dialog stub to Discard before teardown, as quit-guard.spec does.

## Known Stubs

None.

## Self-Check: PASSED
