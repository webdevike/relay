---
phase: 01-foundation-harness-and-the-two-spikes
plan: 07
subsystem: browser
tags: [electron, webcontentsview, overlay, address-bar, playwright]
requires: [01-01, 01-02]
provides:
  - normalize() port of the Rust address bar rules (2 to 5 digit bare port rule)
  - BrowserHost with hardened persist:browser WebContentsView tabs, title/history/error state, slot bounds and occlusion
  - Typed browser contract (state, navigate, back, forward, reload, stop, copyLink, openExternal, setSlot, setOccluded, browser.tabs event)
  - Browser panel chrome, rAF-coalesced slot sync, OverlayStack plus useOccludeBrowser, Test overlay, panel divider
  - e2e static server and fixture pages (a, b, form)
affects: [01-08, 01-09, 01-10]
key-files:
  created:
    - packages/browser-core/src/address.ts
    - apps/desktop/src/main/browser/browser-host.ts
    - apps/desktop/src/main/browser/guest-session.ts
    - apps/desktop/src/main/browser/browser-ipc.ts
    - apps/desktop/src/renderer/overlay/overlay-store.ts
    - apps/desktop/src/renderer/browser/useSlotSync.ts
    - apps/desktop/e2e/browser-basic.spec.ts
    - apps/desktop/e2e/helpers/static-server.ts
  modified:
    - packages/contract/src/browser.ts
    - apps/desktop/src/renderer/app/App.tsx
    - apps/desktop/src/renderer/index.html
requirements-completed: [BROW-01, BROW-02, BROW-04, BROW-06]
duration: 35min
completed: 2026-10-15
---

# Phase 1 Plan 07: Browser slice Summary

**A hardened Chromium WebContentsView browser panel: address bar (URL, search, bare port) with back/forward/reload/copy/open-external, bounds locked to the React slot (0 px delta), and hiding under overlays through one OverlayStack mechanism.**

## Accomplishments
- browser-basic e2e passes end to end: bare port load, title follows, history, copy link, stubbed external open, bounds equal slot after window resize and divider drag, overlay hides and restores with identical bounds, sandbox/partition/no-preload/no `window.eva`, popup and geolocation denied, search URL, error card.
- Metrics recorded: `boundsDeltaPx: 0`, `overlayHidesView: true`, `boundsRestoredAfterOverlay: true`.
- `pnpm gate` prints GATE GREEN (5 Playwright specs).

## Task Commits
1. Failing e2e, static server, normalize port: `dd04388`
2. BrowserHost, guest session, browser IPC: `db595f7`
3. Panel chrome, slot sync, overlay stack, divider: `bcad9ab`

## Decisions Made
- The divider also occludes the native view while dragging (via useOccludeBrowser), because a native view over the pointer would swallow pointermove events when shrinking the panel.
- Shell CSP `img-src` widened to `http: https:` so guest favicons render in the tab strip (images only; scripts and connect stay strict).
- `normalize` encodes each search word with encodeURIComponent (plan behavior table) rather than Rust's raw join.

## Deviations from Plan

**1. [Rule 3 - Blocking] overlay-store test is `.tsx`**: plan named `overlay-store.test.ts` but it renders JSX hooks; file is `overlay-store.test.tsx`.
**2. [Rule 1 - Bug] Shell CSP blocked favicon images** (console errors failed the fixture); fixed by the img-src change above. The static server also serves a 1x1 PNG at `/favicon.ico` so the e2e console stays clean.
**3. Added `useSlotSync.test.ts`** covering the rAF coalescing behavior bullet (via an extracted `createSlotSync`).
**4. TabStrip omits the tab close button** and the `+` is disabled; close/new-tab behaviours land in 01-08 as the plan states.
**5. `Modal` data-testid** is on an inner wrapper div (Mantine 9 `Modal` has no `slotProps`).
**6. Plan verify command `--project renderer`** cannot filter nested projects from root; renderer tests ran by path (`vitest run src/renderer`).

## Known Stubs
- Tab `+` button is disabled and tabs cannot be switched or closed (01-08). Import Arc button slot is reserved (01-09).

## Self-Check: PASSED
