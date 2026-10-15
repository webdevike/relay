---
phase: 02-shell-navigation-and-theme-tokens
plan: 08
subsystem: renderer-shell
tags: [layout, grips, shell-frame, fit, zustand, playwright]
requires: [02-01, 02-05, 02-06, 02-07]
provides:
  - "renderer/shell: layoutStore, useLayout, previewWidth, commitWidth, resetWidth, toggleSidebar, togglePanel, loadLayout, registerLayoutActions, Shell, Grip, Footer, PanelCard"
  - "renderer/navigation/navigate.ts: openPlace and setNavigator indirection for 02-09"
  - "renderer/sidebar/SidebarColumn.tsx placeholder (carries data-testid sidebar and rail) for 02-10 to replace"
  - "e2e fixtures: buildLaunchEnv, launchApp"
affects: [02-09, 02-10]
key-files:
  created:
    - apps/desktop/src/renderer/shell/{layout-store.ts,layout-store.test.ts,Grip.tsx,Grip.test.tsx,Shell.tsx,Footer.tsx,PanelCard.tsx,shell.css}
    - apps/desktop/src/renderer/navigation/navigate.ts
    - apps/desktop/src/renderer/sidebar/SidebarColumn.tsx
    - apps/desktop/e2e/shell-frame.spec.ts
  modified:
    - apps/desktop/src/renderer/app/App.tsx
    - apps/desktop/src/renderer/styles/tokens.css
    - apps/desktop/src/renderer/browser/{TabStrip.tsx,browser.css}
    - apps/desktop/e2e/{fixtures,proof,browser-basic,browser-arc,browser-cdp,browser-extensions,browser-tabs}.ts
  deleted:
    - apps/desktop/src/renderer/app/{Rail.tsx,Rail.test.tsx,PanelDivider.tsx}
key-decisions:
  - "Derived widths (sidebarPx, panelPx, state) are stored in the layout store and recomputed on every change through shell-core fit; the renderer never computes widths itself"
  - "Widths reach CSS through variables written imperatively by a store subscription, not React state"
  - "Closed panel is display none (stays mounted) so the browser slot measures 0 by 0 and the native view hides"
  - "resetWidth saves the default constant itself, not the fitted value, so a narrow window never persists a squeezed width"
duration: 50min
completed: 2026-10-15
---

# Phase 2 Plan 08: Shell frame, grips, layout store Summary

The Phase 1 spike frame is replaced by [sidebar][main card][panel card] over a 32px footer, with widths derived only from shell-core `fit()`, edge Grips that commit to layout.json once per gesture, and Cmd+B and Cmd+Shift+B routed through the hotkey router.

## Tasks

| Task | Commit |
|------|--------|
| 1. Layout store and navigation indirection | 646a283 |
| 2. Shell frame, Grip, footer, panel card, spike removal | 46b523b |
| 3. Browser testid rename, specs, shell-frame e2e | 286e280 |

## Deviations from Plan

**1. [Rule 1 - Bug in plan arithmetic] Panel drag and relaunch widths**
- The plan's e2e vectors (panel 420 dragged left 100 giving 520, and relaunch widths 300 and 500) exceed what `fit` allows: at 1280 with a 272 sidebar the panel maxes at 512, and with a 300 sidebar at 484 (main floor 480).
- The e2e uses a sidebar drag from 272 to 332 as planned, a panel drag of 80 to 500 (sidebar at 272), and relaunch widths of 300 and 460. The Grip unit test uses a 60px drag giving 480.

**2. [Rule 2 - Missing functionality] Traffic-light clearance and chat min-width**
- When the sidebar is not open, the chat header gets 80px left padding so macOS traffic lights do not overlap it. `.eva-chat` lost its 480px min-width so the card (clipping) governs main at 760 and 800; otherwise the two-card vectors overflowed.

**3. Preview that clamps instead of folds**
- A sidebar preview below 200 clamps to 200 (not a fold); a preview is ignored only when `fit` folds the sidebar (narrow window). Test 4 was written for that behavior.

Otherwise the plan executed as written. The SidebarColumn placeholder keeps the wordmark and env badge so skeleton.spec and drag-region.spec stay valid.

## Verification

- Vitest 56 files, 355 tests pass. Typecheck, eslint, prettier and em-dash lint clean. `pnpm -C apps/desktop build` succeeds.
- Playwright: 36 passed, 3 skipped (pre-existing skips), including the new shell-frame.spec.ts (5 tests) and all renamed Phase 1 specs.

## Known Stubs

- SidebarColumn is a placeholder until 02-10; the main card still hosts the Phase 1 ChatPane until 02-09; `openPlace` is a no-op until 02-09 binds the navigator; footer Eregon slot is empty (Phase 6).

## Threat Flags

None. T-02-30..32 mitigated as planned (preview never calls IPC, widths pass through fit, browser view occluded while dragging).

## Self-Check: PASSED
