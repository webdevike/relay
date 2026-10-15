---
phase: 01-foundation-harness-and-the-two-spikes
plan: 08
subsystem: browser
tags: [electron, webcontentsview, cdp, devtools, history, hotkeys]
requires: [01-07]
provides:
  - Multi-tab browser (each tab its own WebContentsView), create/close/activate, target=_blank to new tab
  - In-app history suggestions (history.rs ranking port) stored as JSON in the config dir
  - PageControl (CDP via webContents.debugger) coexisting with detached DevTools
  - Guest-to-shell app hotkey forwarding via before-input-event; app menu without a Close accelerator
affects: [01-09, 01-10]
key-files:
  created:
    - packages/browser-core/src/history.ts
    - packages/browser-core/src/hotkeys.ts
    - apps/desktop/src/main/menu.ts
    - apps/desktop/src/main/browser/page-control.ts
    - apps/desktop/src/main/browser/history-store.ts
    - apps/desktop/src/renderer/browser/Suggestions.tsx
    - apps/desktop/src/renderer/browser/useBrowserHotkeys.ts
    - apps/desktop/e2e/browser-tabs.spec.ts
    - apps/desktop/e2e/browser-cdp.spec.ts
  modified:
    - packages/contract/src/browser.ts
    - apps/desktop/src/main/browser/browser-host.ts
    - apps/desktop/src/main/browser/browser-ipc.ts
    - apps/desktop/src/renderer/browser/{TabStrip,AddressRow,BrowserPanel}.tsx
requirements-completed: [BROW-03, BROW-05, BROW-07]
completed: 2026-10-15
---

# Phase 1 Plan 08: Browser tabs, suggestions, DevTools and CDP Summary

**Real browser ergonomics: per-tab WebContentsViews, history suggestions ranked like Rust history.rs, detached DevTools plus a CDP PageControl, and app chords that escape guest pages.**

## Accomplishments
- browser-core: `history.ts` (visitKey, addVisit, suggest; Rust tests ported) and `hotkeys.ts` (chord table, matchesAppChord), 12 unit tests.
- Main: `closeTab`/`activateTab`/`createTab(activate)`, window-open handler that only creates http(s) foreground/background tabs, `before-input-event` forwarding (devtools chord opens detached DevTools), HistoryStore, PageControl, `installAppMenu()` with no close role.
- Renderer: TabStrip with `+`, close button and middle-click; Suggestions list (hides the native view via `useOccludeBrowser`); useBrowserHotkeys also re-dispatches `eva:hotkey`.
- `pnpm gate`: GATE GREEN (13 Playwright specs).

## D-10 result: DevTools and debugger coexist
With detached DevTools open (a `devtools://` page appears in `app.windows()`), `PageControl.readText()`, `click`, `evaluate` and `navigate` still work. Recorded `devtoolsCoexist: true`, `cdpClick: true` in browser metrics.

## Decisions Made
- History is JSON (`browser-history.json`, 2000 cap, 500 ms debounced atomic write through ConfigStore), not node:sqlite (D-11 discretion).
- The `browser.createTab` IPC activates the new tab; `+` and Cmd+T use it. `title` events add a 0-visit fold, `did-navigate` counts one visit (mirrors history.rs add semantics).
- `devtools` chord (Alt+Cmd+I) is handled in main and not forwarded to the shell.

## Deviations from Plan
1. **[Rule 1 - Bug] browser-basic regression**: the new tab close buttons made `getByRole('button', { name: 'Close' })` ambiguous in the overlay step; the existing spec now uses `exact: true`.
2. **Test adjustment**: in browser-tabs the Cmd+W/Cmd+L steps re-activate the first tab before sending keys, since a hidden blank tab's view does not receive synthesized input.
3. `HotkeyChordSchema` excludes `devtools` (main-only), matching the plan's event contract.

## Known Stubs
None. Import Arc button slot remains reserved for 01-09.

## Self-Check: PASSED
