---
phase: 03-dashboard-workspaces-jobs-habits-and-meetings
plan: 11
subsystem: dashboard-todo
tags: [todo, evafs, modal, hotkey, e2e]
requires: [03-01, 03-04, 03-08, 03-09]
provides:
  - appendTodoVia and knownTags (shared with meeting Accept, 03-18)
  - eva.todo.preview and eva.todo.add IPC handlers
  - New Todo modal, store and the new-todo action (Cmd+N, hero button)
affects: [03-18]
key-files:
  created:
    - apps/desktop/src/main/eva/todo-write.ts
    - apps/desktop/src/main/eva/todo-write.test.ts
    - apps/desktop/src/main/eva/todo-ipc.ts
    - apps/desktop/src/renderer/todo/new-todo-store.ts
    - apps/desktop/src/renderer/todo/new-todo-store.test.ts
    - apps/desktop/src/renderer/todo/NewTodoModal.tsx
    - apps/desktop/src/renderer/todo/NewTodoModal.test.tsx
    - apps/desktop/src/renderer/todo/new-todo.css
    - apps/desktop/e2e/new-todo.spec.ts
  modified:
    - apps/desktop/src/main/eva-ipc.ts
    - apps/desktop/src/renderer/app/App.tsx
    - apps/desktop/e2e/hotkeys.spec.ts
decisions:
  - "Retry-once append (EvaFs.edit retryOnChange) with todos-done.md re-read inside the transform so ids stay fresh."
  - "Handler collapses newlines and rejects unknown tags with invalid-input before touching the file."
metrics:
  tasks: 3
  completed: 2026-10-15
---

# Phase 3 Plan 11: New Todo Summary

Cmd+N or the hero button opens a New Todo modal with a workspace select and a live row preview; submit appends `- [ ] T<n> [tag] text (added date)` after the last open row of memory/todos.md through EvaFs.edit, with the id taken from todos.md and todos-done.md.

## Commits
- aec6c1c feat(03-11): todo append through EvaFs and todo IPC
- feat(03-11): New Todo store, action and modal
- style(03-11): format todo-write test
- test(03-11): New Todo e2e (this plan's final task commit)

## Verification
- vitest: 589 passed (full repo); typecheck, em-dash lint and build clean; write-scan green.
- e2e: new-todo (5), hotkeys (5), dashboard all pass. Proofs: proof/phase-3/new-todo-modal.png, proof/phase-3/new-todo-error.png.

## Deviations from Plan

**1. [Rule 1 - Bug] hotkeys.spec chord sweep broke**
- Cmd+N now opens a modal, so later chords in the sweep hit the overlay. The spec now closes the modal with Escape after Meta+n.
- Files: apps/desktop/e2e/hotkeys.spec.ts

**2. e2e modal visibility**: Mantine Modal.Root has zero size, so specs assert on `new-todo-text` for open/closed instead of `new-todo-modal` (the alert is still scoped under the modal root).

## Deferred
- Pre-existing eslint no-explicit-any errors in apps/desktop/e2e/helpers/fakes.test.ts (not from this plan).
- Workspace page "New Todo" button (ws-new-todo) belongs to the workspace plan; openNewTodo({ tag }) is ready for it.

## Self-Check: PASSED
