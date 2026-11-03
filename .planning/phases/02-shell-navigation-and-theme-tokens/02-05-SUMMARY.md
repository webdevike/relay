---
phase: 02-shell-navigation-and-theme-tokens
plan: 05
subsystem: main-process
tags: [electron, ipc, config, quit-guard, vitest]
requires: [02-02]
provides:
  - "Main handlers: layout.load/save, theme.load/setAppearance, app.setBackground, app.quit, settings.load/save, eva.sidebar"
  - "createWriteQueue, ConfigStore.readText, createQuitGuard/installQuitGuard, Env.noMotion"
affects: [02-06, 02-07, 02-08, 02-12]
tech-stack:
  added: []
  patterns: ["pure logic functions over ConfigStore, thin register*Ipc wrappers", "request/reply registry with random ids and timeout"]
key-files:
  created:
    - apps/desktop/src/main/write-queue.ts
    - apps/desktop/src/main/layout-ipc.ts
    - apps/desktop/src/main/theme-ipc.ts
    - apps/desktop/src/main/settings-ipc.ts
    - apps/desktop/src/main/eva-ipc.ts
    - apps/desktop/src/main/quit-guard.ts
    - apps/desktop/src/main/quit-guard.test.ts
    - apps/desktop/src/main/config-ipc.test.ts
  modified:
    - apps/desktop/src/main/config-store.ts
    - apps/desktop/src/main/env.ts
    - apps/desktop/src/main/env.test.ts
    - apps/desktop/src/main/app-ipc.ts
    - apps/desktop/src/main/window.ts
    - apps/desktop/src/main/index.ts
key-decisions:
  - "Quit guard before-quit listener registered ahead of the hooks listener; the hooks listener returns early until the guard approves"
  - "quitGuard e2e hook is registered via registerTestHook in installQuitGuard, so test-hooks.ts needed no edit"
duration: 35min
completed: 2026-10-15
---

# Phase 2 Plan 05: Main-process config handlers and quit guard Summary

Every Phase 2 main channel now has a registered, tested handler: layout (clamped, malformed gives reset flag), theme appearance and last background (window and shell view painted, persisted, used at launch), chat settings, sidebar data from the Eva checkout (read-only), noMotion from EVAOS_NO_MOTION, and a Save/Discard/Cancel quit guard with a 2 s hung-renderer timeout. All config writes go through one serialised queue.

## Tasks

| Task | Commit |
| ---- | ------ |
| 1 Config handlers, noMotion, window background | bb41cb8 |
| 2 Unsaved-edits quit guard | 823e585 |
| 3 Handler registration scan test | f5863f7 |
| Prettier formatting | 0496107 |

## Verification

- vitest apps/desktop/src/main: 50 passing; `pnpm -r typecheck`, `pnpm lint`, `pnpm -C apps/desktop build` green.
- Phase 1 e2e: verified in a clean worktree at bb41cb8 (task 1 only) that browser-basic and browser-tabs pass. At 823e585 the full run gave 26 passed, 2 failed (browser-tabs hotkeys, chat-bench perf), 3 skipped; the chat-control quit-hooks spec passed.

## Deviations from Plan

None to the code. `test-hooks.ts` was not edited (hook registered through the existing `registerTestHook`).

## Issues Encountered

- Running the Phase 1 e2e on the shared tree after the concurrent 02-06 commits showed browser-tabs (guest hotkeys) and browser-basic (duplicate "Close" button, strict-mode locator) failing. Bisecting in a clean worktree: both pass at my task 1 commit and the browser-tabs failure first appears at fc076d7 (02-06 hotkey router); browser-basic fails with the later 02-06 overlay migration (93eb09a). These are 02-06 renderer regressions, not main-process ones, and are left for 02-06 to fix (Phase 1 specs likely need updated locators or the hotkey bridge needs repair). The chat-bench failure at 823e585 is a frame-time perf spec and was not re-examined.

## Known Stubs

None.

## Self-Check: PASSED

Files and commits bb41cb8, 823e585, f5863f7, 0496107 exist.
