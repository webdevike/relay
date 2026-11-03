---
phase: 02-shell-navigation-and-theme-tokens
plan: 09
subsystem: renderer-tabs
tags: [tabs, persistence, context-menu, hotkeys, playwright]
requires: [02-03, 02-06, 02-08]
provides:
  - "renderer/tabs: tabsStore, useTabs, startTabs, navigateTo, newChatTab, activate, close, closeOthersOf, togglePinOf, activePlace, activeTabId"
  - "renderer/tabs/tab-meta.ts: tabTitle(place), tabIconName(place)"
  - "TabBar (tab strip, context menu, sidebar and panel toggles) and MainCard"
  - "navigation openPlace bound to the tabs store (newTab forwarded)"
  - "window.__evaosShell.tabs() and openPlace(page, newTab) e2e hooks"
affects: [02-10, 02-11]
key-files:
  created:
    - apps/desktop/src/renderer/tabs/{tabs-store.ts,tabs-store.test.ts,tab-meta.ts,TabBar.tsx,TabBar.test.tsx,tabs.css}
    - apps/desktop/src/renderer/shell/MainCard.tsx
    - apps/desktop/e2e/tabs.spec.ts
  modified:
    - apps/desktop/src/renderer/{app/App.tsx,shell/Shell.tsx,shell/shell.css,styles/tokens.css,hotkeys/e2e-hooks.ts}
    - apps/desktop/e2e/{drag-region.spec.ts,shell-frame.spec.ts}
key-decisions:
  - "Tab state is a vanilla zustand store over the pure shell-core reducer; persistence is a 250 ms debounce with an unchanged-JSON check, seeded after load so the first load never echoes a save"
  - "The context menu anchors at the pointer via a fixed zero-size span; the data-testid tab-menu sits on the dropdown so it is a visible element"
duration: 40min
completed: 2026-10-15
---

# Phase 2 Plan 09: Tabs Summary

Main tabs now run on the shell-core reducer: a persisted tabs store, a Linear-style tab strip with pin, close, right-click menu, history chords and sidebar and panel toggles, and `openPlace` bound to the store for every later caller.

## Tasks

| Task | Commit |
|------|--------|
| 1. Tabs store, persistence, actions, navigator binding | da2ce10, plus typing fix in the following commit |
| 2. Tab strip, context menu, toggles, MainCard | feat(02-09) tab strip commit |
| 3. Tabs e2e and drag-region update | test(02-09) commit |

## Deviations from Plan

**1. [Rule 3 - Blocking] chat header drag and border live in tokens.css**
- The plan said to edit chat.css, but `.eva-chat-header` is defined in styles/tokens.css. The drag region removal and the `--eva-c-border` bottom border were made there. The now redundant 80px header padding rule in shell.css was removed (the tab strip owns traffic-light clearance).

**2. [Rule 1 - Bug] Test-only flake in shell-frame.spec**
- Width assertions right after a state flip raced the 220ms sidebar animation and failed once under full-suite load. They now use `expect.poll`.

**3. Tooltip note (research Pitfall 2)**
- Chrome tooltips only appear over the strip, so no native-view wrapper is needed. `IconTimer` does not exist in tabler 3.49, so Habits uses `IconFlame`.

**4. e2e browser visibility**
- The browser view is only visible once a page is loaded, so the menu e2e navigates to the static fixture page first.

## Verification

- Vitest 58 files, 372 tests pass. Typecheck, eslint, prettier, em-dash lint clean. Build succeeds.
- Playwright: 43 passed, 3 skipped (pre-existing), including tabs.spec.ts (7 tests: keys, dedupe, pin rules, menu occlusion, relaunch persistence, traffic-light clearance, panel toggle). The opt-in drag-region spec was run with EVAOS_OS_EVENTS=1 and reported agent-verified.

## Known Stubs

- MainCard still renders the Phase 1 ChatPane for every place; 02-10 swaps in the page router. Tab titles for chat are "New chat" until Phase 4.

## Threat Flags

None. T-02-09, T-02-34 and T-02-35 mitigated as planned (loadTabs never throws, debounced saves, titles rendered as React text).

## Self-Check: PASSED
