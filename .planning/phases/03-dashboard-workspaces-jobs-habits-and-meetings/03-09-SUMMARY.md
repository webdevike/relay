---
phase: 03-dashboard-workspaces-jobs-habits-and-meetings
plan: 09
subsystem: dashboard
tags: [dashboard, ipc, zustand, reload, charts, e2e]
requires: [03-02, 03-03, 03-04, 03-07, 03-08]
provides:
  - "eva.dashboard main handler (dashboardHandler) with injectable clock"
  - "main/eva/runtime.ts: evaFsFor(ctx), clockFor(ctx)"
  - "renderer/reload/reload.ts: registerReloader, reloadAll, reloadPages, startReload (single owner of the reload action)"
  - "renderer/dashboard/dashboard-store.ts: dashboardStore, loadDashboard (single flight plus one queued follow-up), useDashboard, workspaceName, setFilter, setRange"
  - "DashboardPage (hero with rotating banners, Recent Workspaces charts, filters, grid, Open Todos, Quick Stats) and PageBySlug registry dispatch"
affects: [03-10, 03-11, 03-12]
key-files:
  created:
    - apps/desktop/src/main/eva/runtime.ts
    - apps/desktop/src/main/eva/dashboard-ipc.ts
    - apps/desktop/src/renderer/reload/reload.ts
    - apps/desktop/src/renderer/dashboard/*.tsx
    - apps/desktop/src/renderer/dashboard/dashboard.css
    - apps/desktop/src/renderer/assets/banners/*.png
    - apps/desktop/e2e/dashboard.spec.ts
  modified:
    - apps/desktop/src/main/eva-ipc.ts
    - apps/desktop/src/renderer/sidebar/sidebar-store.ts
    - apps/desktop/src/renderer/pages/registry.ts
    - apps/desktop/src/renderer/app/App.tsx
    - apps/desktop/src/renderer/theme/motion.ts
    - apps/desktop/src/renderer/ui/ActivityChart.tsx
    - apps/desktop/e2e/pages.spec.ts
requirements-completed: [DASH-01, DASH-02, DASH-03, DASH-04, DASH-05, DASH-06]
completed: 2026-10-15
---

# Phase 3 Plan 09: Dashboard vertical slice Summary

The Dashboard now runs end to end from the Eva files through the `eva.dashboard` handler, IPC and a zustand store to the page, with reload on window focus, the refresh button and Cmd+R (which also refreshes the sidebar counts) owned by one module.

## Commits
- ebd23d5 feat(03-09): eva.dashboard handler, reload seam and dashboard store
- (task 2) feat(03-09): Dashboard page with hero banners, filters, grid, charts and aside
- 435dbe6 feat(03-09): dashboard e2e with reload triggers and phase 3 proof

## What was built
- Main: `dashboardHandler(root, clock)` over `readDashboard`; `evaFsFor`/`clockFor` memoized helpers for later plans. The renderer sends no paths (T-03-30).
- Reload seam: `startReload()` registers the only `'reload'` action (the sidebar no longer registers one) and a window focus listener that reloads pages; `reloadAll()` = sidebar refresh plus every registered reloader.
- Store: single flight with exactly one queued follow-up (three calls during a flight produce two invokes), previous data kept on error.
- Page: hero (four stacked banners, 9 s rotation and 1400 ms crossfade, paused when hidden, first banner only under motion off), range and filter radiogroups with arrow-key roving, two chart cards, grid of everything after the first two filtered workspaces, Open Todos (first 6 in file order) and Quick Stats, loading skeleton, error card, empty state, `data-compact` at 760 px via ResizeObserver.
- Proof: seven screenshots under `proof/phase-3/dashboard-*.png` (wide dark and light, compact dark and light, three filters).

## Verification
- Vitest: 81 files, 572 tests pass; typecheck, em-dash lint, `pnpm build` clean.
- Playwright (built app): full suite 94 passed, 3 skipped (pre-existing skips); dashboard.spec 9 of 9 including motion-on hero fade, Cmd+R/focus/refresh reload, compact stacking, filter counts 3/2/0 and tab navigation.
- `eslint apps/desktop` reports 4 `no-explicit-any` errors in `e2e/helpers/fakes.test.ts`, not touched by this plan (out of scope, pre-existing).

## Deviations from Plan

**1. [Rule 1 - Bug] ActivityChart tooltip crashed the React tree on hover**
- Found during: Task 3 e2e (chat-pane test lost the whole tree when the mouse sat over a chart)
- Issue: 03-07's tooltip payload items lacked `payload`/`dataKey`, so Mantine `ChartTooltip` threw `Cannot read properties of undefined`.
- Fix: map to `{ name: 'count', dataKey: 'count', payload: row }` with a series label "updates"; dashboard e2e now hovers a chart and asserts the tooltip.
- Files: apps/desktop/src/renderer/ui/ActivityChart.tsx
- Commit: 435dbe6

**2. [Rule 3 - Blocking] Entrance cues never played on the dashboard**
- Issue: `useEntrance` is once per launch, and the sidebar consumed it before the page mounted.
- Fix: `useEntrance(key?)` with a per-key played set (default behavior unchanged); the dashboard uses key `'dashboard'`. Motion-on e2e asserts the hero eva-cue animation starts below opacity 1 and reaches 1 within 2 s.
- Files: apps/desktop/src/renderer/theme/motion.ts, DashboardPage.tsx

**3. Custom radiogroup instead of Mantine SegmentedControl** for 7D/30D/90D: shares the filter chip styling and gives per-segment test ids without the FloatingIndicator. Behavior and testids match UI-SPEC.

**4. Wide e2e uses an 1800 px window**: at 1280 the shell leaves the page under 760 px, so the wide layout only appears with a wider window or a folded panel.

## Notes
- Working tree contained uncommitted edits by another process (hidden-window changes in main/env.ts, main/index.ts, main/window.ts, e2e/fixtures.ts, e2e/packaged.spec.ts). They are not part of this plan and were left uncommitted.
- Banner PNGs (about 12 MB) were copied read-only from the Rust app per T-03-31.

## Known Stubs
- "PRs to review" shows 0 by design until Phase 7 supplies data (UI-SPEC).
- Hero New Todo triggers `runAction('new-todo')`, which plan 03-11 implements; no handler yet.

## Self-Check: PASSED
