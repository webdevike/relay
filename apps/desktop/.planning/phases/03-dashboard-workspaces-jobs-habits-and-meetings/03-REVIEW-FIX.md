---
phase: 03-dashboard-workspaces-jobs-habits-and-meetings
fixed_at: 2026-10-15T13:45:00Z
review_path: .planning/phases/03-dashboard-workspaces-jobs-habits-and-meetings/03-REVIEW.md
iteration: 1
findings_in_scope: 14
fixed: 14
skipped: 0
status: all_fixed
---

# Phase 3: Code Review Fix Report

**Scope:** Critical + Warning (Info skipped by request). Each fix has unit tests.

**Verification:** `pnpm -r typecheck`, `eslint .`, `prettier --check .`, em-dash lint, `pnpm vitest run` (103 files, 720 tests), `pnpm build`, and Playwright specs dashboard, jobs, job-form, habits, gate, meetings, meetings-actions, new-todo, workspace, eva-watch (50 passed) all green.

## Fixed

- **CR-01** fixed (requires human verification, logic): `9a67da4`. Readers now conform to the contract: meeting stems failing the Stem regex are not listed; job names over 64, description and runNote are clamped or skipped; `parseDuration` bounded to 366 days and 9 digits; fractional `last-run` floored; proposal id and kind clamped. Deviation: for todo ids the contract `TodoId` was relaxed to `^T\S*$` (max 100) instead of making `parseRow` reject non-numeric ids, because `parseRow` is the shared Rust-parity row rule that the sidebar count also uses. Follow-up formatting and lint cleanups in `b2afa7a` and `0424aca`.
- **WR-01** fixed: `56f5341`. Status edit after the todo append uses `retryOnChange`; `not-proposed` after the append is success.
- **WR-02** fixed: `e93a87f`. New `resolveNotesPath` (absolute `.md`, realpath inside roots) shared by `meetings.get` and `openNotes`. Behavior change: a symlink inside the roots that resolves inside the roots is now readable (previously any symlink was refused); escapes are refused.
- **WR-03** fixed: `c02a0d4`. `OpenPathOptions.allowExts`; `habit.openPhoto` passes `PHOTO_EXTENSIONS`.
- **WR-04** fixed: `0d89868`. Token is peeked, consumed only after the gate succeeds; TTL raised to 11 hours; renderer clears the chosen photo on `invalid-input`.
- **WR-05** fixed: `5b15952`. `spawnDetached` returns a promise resolving on `spawn` and rejecting with `spawn-failed` on `error`. The double-click guard was not added.
- **WR-06** fixed: `9ea87c4`. Promise queue in `createHabitService` plus a `busy` guard in `runHabit`.
- **WR-07** fixed: `3bce2ba`. Removed the `.max()` caps on history, tasks, habits and breaks in the gate status schema.
- **WR-08** fixed: `5fa658b`. `registerReloader` takes areas; `eva.changed` areas are passed through (habits subscribes to none, jobs to `jobs`, meetings to `meetings`); atomic-write temp files are ignored by the watcher; watcher errors are logged. Job run state under `jobs/.runs` is still watched because the Jobs page shows it.
- **WR-09** fixed: `545c91d`. `mergeFresh` keeps only user-changed fields when "Keep editing" adopts fresh disk text.
- **WR-10** fixed: `c4d7807`. `maxTodoId` ignores non-safe-integer digit runs.
- **WR-11** fixed: `a4a5faf`. `validateJob` rejects control characters in every, max_run and keep. The `[ \t]*` regex change shipped earlier inside the CR-01 commit.
- **WR-12** fixed: `3601906`. `evaFs.create` removes the folder it made when the write fails.
- **WR-13** fixed: `bab0b60`. X axis and `ReferenceArea` keyed by `date`, ticks via `tickFormatter`; render test fails without the fix.

## Skipped

None.

---

_Fixer: Claude (gsd-code-fixer)_
