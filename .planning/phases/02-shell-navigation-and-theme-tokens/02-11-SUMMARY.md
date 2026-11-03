---
phase: 02-shell-navigation-and-theme-tokens
plan: 11
subsystem: renderer-sidebar
tags: [sidebar, navigation, sub-pages, recent, account-menu, playwright]
requires: [02-02, 02-06, 02-07, 02-08, 02-09, 02-10]
provides:
  - "sidebar-store: sidebarStore, startSidebar, refreshSidebar (single in-flight), filterRecent, countLabel"
  - "nav-level: navLevelStore, openSub, backToRoot, levelForPlace, registerSearchFocuser, focusSearch"
  - "SidebarColumn: sliding two-page track (main nav and Chats, Settings, Meetings sub-pages), testids sidebar and rail kept"
  - "Actions reload (refresh counts and Recent) and focus-search (shows a hidden sidebar first)"
affects: [02-12]
key-files:
  created:
    - apps/desktop/src/renderer/sidebar/{sidebar-store.ts,nav-level.ts,MainNav.tsx,NavRow.tsx,RecentList.tsx,SearchBox.tsx,SubPages.tsx,AccountMenu.tsx,icons.ts,sidebar.css}
    - apps/desktop/src/renderer/sidebar/{sidebar-store.test.ts,sidebar.test.tsx}
    - apps/desktop/e2e/sidebar.spec.ts
  modified:
    - apps/desktop/src/renderer/sidebar/SidebarColumn.tsx
    - apps/desktop/src/renderer/shell/{Shell.tsx,shell.css}
    - apps/desktop/src/renderer/app/App.tsx
key-decisions:
  - "Own icon map in sidebar/icons.ts instead of editing PlaceholderPage"
  - "Old placeholder sidebar rules removed from shell.css; new rules live in sidebar.css"
  - "Env badge (Fixture data / Live Eva data) kept in the sidebar footer because skeleton.spec depends on it"
  - "Plain click on Chat while already on a chat only drills in, so it does not push a new draft chat each time"
  - "Sidebar search Esc band is 20, above sub-page Back (10) and below overlays (100)"
requirements-completed: []
duration: 40min
completed: 2026-10-15
---

# Phase 2 Plan 11: Sidebar Summary

Real sidebar: Main nav rows with Tasks and Jobs counts, filtered Recent journal titles, account menu, Light/Dark/System control, and a 220 ms sliding track to Chats, Settings and Meetings sub-pages with Back and Esc.

## Tasks
1. Sidebar data store, nav-level store, reload and focus-search actions (TDD, 9 tests): 6849161
2. Sliding sidebar UI, nav rows, Recent, sub-pages, account menu, `--eva-sidebar-inner-w` writer in Shell, App starts the store (11 component tests): 53479e9
3. sidebar.spec.ts, 7 e2e tests against the fixture Eva root: 8ab390d

## Verification
Vitest full suite green, typecheck, eslint, em-dash lint and build clean. Playwright e2e: 58 passed, 3 skipped (pre-existing opt-in specs), zero console errors.

## Deviations from Plan
- Unit test for Esc ordering uses `sidebar-sub-search` (the root search is inert at level chats).
- The e2e account-menu check covers browser view hiding and Esc closing the menu at root; the "menu open while on a sub-page" ordering is covered only by the component test, because the account trigger lives on the root page and cannot be opened while a sub-page is shown.
- Mid-run, `pnpm -r typecheck` briefly failed on 02-12's in-progress `e2e/settings.spec.ts`; it was clean on the final run.

## Known Stubs
- Chats and Meetings sub-pages show the intentional "arrive in a later update" lines; Recent rows are inert until later phases pass `onOpen`.

## Threat Flags
None. Titles render as React text plus a title attribute (T-02-40); refresh uses one in-flight promise (T-02-41); Quit calls `app.quit` through the 02-05 guard (T-02-43).

## Self-Check: PASSED
