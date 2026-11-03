---
phase: 03-dashboard-workspaces-jobs-habits-and-meetings
plan: 15
subsystem: habits
tags: [habits, habit-gate, polling, ipc, e2e]
requires: [03-02, 03-03, 03-06, 03-08, 03-12, 03-13]
provides:
  - habit.status (single flight, epoch-guarded), habit.run, habit.openPhoto IPC over the habit-gate CLI
  - photo-tokens (issuePhotoToken, takePhotoToken; single use, 10 minute expiry) for 03-16
  - habitStore with startHabits, pollHabits, runHabit, useHabits (launch-time polling, generation counter)
  - Habits page, sections and habit form
key-files:
  created:
    - apps/desktop/src/main/eva/habit-ipc.ts
    - apps/desktop/src/main/eva/habit-ipc.test.ts
    - apps/desktop/src/main/eva/photo-tokens.ts
    - apps/desktop/src/renderer/habits/habit-store.ts
    - apps/desktop/src/renderer/habits/habit-store.test.ts
    - apps/desktop/src/renderer/habits/HabitsPage.tsx
    - apps/desktop/src/renderer/habits/HabitSections.tsx
    - apps/desktop/src/renderer/habits/HabitForm.tsx
    - apps/desktop/src/renderer/habits/HabitsPage.test.tsx
    - apps/desktop/src/renderer/habits/habits.css
    - apps/desktop/e2e/habits.spec.ts
  modified:
    - apps/desktop/src/main/eva-ipc.ts
    - apps/desktop/src/renderer/app/App.tsx
    - apps/desktop/src/renderer/pages/registry.ts
    - apps/desktop/src/renderer/pages/PageRouter.test.tsx
    - apps/desktop/e2e/pages.spec.ts
decisions:
  - Main status reads are shared only within one command epoch, so a read begun before a command is never reused after it
  - Today's breaks rows show state and time only; plan breaks carry no habit name, so no name or Task badge is shown there (override reasons live in History per D10)
  - Form open state is local to HabitsPage, not in habitStore
metrics:
  tasks: 3
  completed: 2026-10-15
---

# Phase 3 Plan 15: Habits Summary

Habits page backed only by the habit-gate CLI (the app never writes habits.yml or gate.json): status polls from app launch every 4 s while visible, a generation counter and busy flag stop stale reads from overwriting command results, and every habit or task edit is a CLI subcommand.

## Commits

- feat(03-15): habit gate IPC over the CLI with single-flight status and photo tokens
- feat(03-15): habits page with launch-time polling, generation-guarded store and habit form
- test(03-15): habits e2e against the fake gate with proof

## Verification

- Vitest: habit-ipc 6 plus write-scan pass; renderer 252 pass (store 4, page 7). Typecheck, eslint, em-dash lint, build clean.
- e2e habits (6) and pages (7) pass against the built app and the fake gate; proof written to `proof/phase-3/habits-dark.png`, `habits-light.png`, `habits-stale.png`.
- e2e covers: launch-time status call before the page opens, external state change appearing within 6 s, add/edit/remove habit argv, task add/remove argv, failing gate (stale line, inline alert, recovery), proof photo opened inside the photos dir.

## Deviations from Plan

- [Rule 1 - Bug] Main single-flight could hand a post-command poll a read started before the command; added an epoch bump around `run`.
- Plan paths are `apps/desktop/...` as written; `HabitRun` is not exported from contract, so the type is derived with `InvokeInput<'habit.run'>`.
- Today's breaks rows omit habit name and Task badge (plan data has none).
- `habit.choosePhoto` is not registered here; 03-16 owns it (it consumes `issuePhotoToken`).

## Known Stubs

None.

## Self-Check: PASSED
