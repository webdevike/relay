---
phase: 03-dashboard-workspaces-jobs-habits-and-meetings
plan: 16
subsystem: habits
tags: [gate-overlay, hotkeys, electron-dialog, e2e]
requires: [03-15]
provides:
  - habit.choosePhoto native dialog handler issuing single-use photo tokens
  - setChordLock in the hotkey router (only cmd+q passes)
  - GateOverlay break screen mounted at the app root
affects: [habits, hotkeys, shell]
key-files:
  created:
    - apps/desktop/src/renderer/habits/GateOverlay.tsx
    - apps/desktop/src/renderer/habits/GateOverlay.test.tsx
    - apps/desktop/src/renderer/habits/gate-overlay.css
    - apps/desktop/e2e/gate.spec.ts
    - proof/phase-3/gate-locked.png
    - proof/phase-3/gate-timer.png
    - proof/phase-3/gate-override.png
  modified:
    - apps/desktop/src/main/eva/habit-ipc.ts
    - apps/desktop/src/main/eva/habit-ipc.test.ts
    - apps/desktop/src/renderer/hotkeys/router.ts
    - apps/desktop/src/renderer/hotkeys/router.test.tsx
    - apps/desktop/src/renderer/app/App.tsx
key-decisions:
  - Dialog is imported dynamically and read at call time so e2e can stub dialog.showOpenDialog
  - Overlay fades in only (120 ms, none under motion-off); removal is immediate
requirements-completed: [HABT-03]
duration: 25min
completed: 2026-10-15
---

# Phase 3 Plan 16: Locked gate overlay Summary

A locked habit gate now turns the whole window into a break screen (z-index 400) that hides the native browser view, swallows every chord except Cmd+Q, and offers Start, countdown, photo proof and a typed-reason Override.

## Tasks

1. `habit.choosePhoto` (native open dialog, image filters, "Use photo", single-use token) and `setChordLock` in the router (also consumes guest-forwarded chords). Commits: 8d-series `feat(03-16): habit.choosePhoto...` and a follow-up `fix(03-16): await the open dialog result`.
2. `GateOverlay` with picker (radio rows, arrow keys), 1 s countdown (m:ss, h:mm:ss), Progress, photo choose/change with name chip, Mark break done gating, inline override (3 character minimum), error alert, Tab focus trap, Escape ignored; mounted in `App.tsx`. 7 unit tests.
3. `gate.spec.ts`: browser view hidden and chords/Escape swallowed while locked; start/timer/done unlock with the view returning; photo habit with stubbed dialog (`--photo <path>`); override with validation and `Overridden: ...` in Habits history; failing CLI shows the alert. Proof screenshots in `proof/phase-3/`.

## Verification

Vitest renderer (260) and main habit tests pass, typecheck, eslint, em-dash lint, build green; gate.spec (5) and hotkeys.spec pass, proof written with `EVAOS_PROOF=1`.

## Deviations from Plan

**1. [Rule 1 - Bug] Commit order slip.** A macOS `sed -i` failure let a commit through with a missing `await` on the dialog result; fixed in an immediate follow-up commit (tests and typecheck verified after).

**2. [Test adaptation]** `new-todo-modal` stays in the DOM when closed (Mantine), so the e2e asserts `toBeHidden()` rather than count 0.

## Known Stubs

None.

## Self-Check: PASSED
