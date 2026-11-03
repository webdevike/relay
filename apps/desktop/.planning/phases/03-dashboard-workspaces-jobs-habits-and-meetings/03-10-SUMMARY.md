---
phase: 03-dashboard-workspaces-jobs-habits-and-meetings
plan: 10
subsystem: eva-watch
tags: [chokidar, live-reload, dash-06]
requires: [03-07, 03-08, 03-09]
provides: ["startEvaWatch / watchTargets / areaFor", "renderer reload on eva.changed"]
key-files:
  created:
    - apps/desktop/src/main/eva/watch.ts
    - apps/desktop/src/main/eva/watch.test.ts
    - apps/desktop/e2e/eva-watch.spec.ts
    - proof/phase-3/dashboard-live-change.png
  modified:
    - apps/desktop/src/main/index.ts
    - apps/desktop/src/renderer/reload/reload.ts
    - apps/desktop/src/renderer/reload/reload.test.ts
decisions:
  - "chokidar 5 bundles and runs under electron-vite 6; no fs.watch fallback needed"
requirements: [DASH-06]
completed: 2026-10-15
---

# Phase 3 Plan 10: Live Eva change detection Summary

Narrow chokidar watch (seven explicit Eva paths, depth 4, 250 ms debounced area set) pushes `eva.changed` to the renderer, which calls `reloadAll()`, so external edits refresh the dashboard and sidebar counts without focus or Cmd+R.

## Tasks
1. Watcher: commit 1fb1c57. `watchTargets`, `areaFor`, `startEvaWatchWith` (injectable emitter), `startEvaWatch(ctx)` wired in main after IPC registration and closed via `onBeforeQuit`.
2. Renderer subscription and e2e: see the second commit of this plan. `startReload()` subscribes to `eva.changed` and unsubscribes in its disposer; e2e proves a todos.md append and a new workspace file appear within 3 s.

## Verification
Watch and reload unit tests, typecheck, build, and eva-watch, dashboard and sidebar e2e (17 tests) pass. Proof: proof/phase-3/dashboard-live-change.png.

## Deviations from Plan
None in scope. Note: on macOS FSEvents can replay writes made just before the watcher starts, producing one harmless extra `eva.changed` at launch; the unit test lets that settle before asserting a single debounced emit.

## Self-Check: PASSED
