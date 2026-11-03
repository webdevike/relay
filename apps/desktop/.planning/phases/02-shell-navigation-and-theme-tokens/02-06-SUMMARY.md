---
phase: 02-shell-navigation-and-theme-tokens
plan: 06
subsystem: renderer-infrastructure
tags: [hotkeys, overlay, scroll, dirty-edits, vitest]
requires: [02-01, 02-02]
provides:
  - "renderer/hotkeys: startHotkeyRouter, registerAction, runAction, registerPageChord, registerOverlayChord, registerTerminalScope, dispatchChord, useDismissable, dismissTop, panelFocusStore, initE2e"
  - "renderer/overlay: EvaModal, EvaMenu, EvaPopover, EvaDrawer (+ import lint)"
  - "renderer/ui: ScrollArea with fades, scroll-memory"
  - "renderer/dirty: dirtyStore, registerDirty, listDirty, saveAllDirty, startQuitBridge"
affects: [02-07, 02-08, 02-09, 02-10]
key-files:
  created:
    - apps/desktop/src/renderer/hotkeys/{router,dismiss,panel-focus,e2e-hooks}.ts
    - apps/desktop/src/renderer/hotkeys/{router,dismiss}.test.tsx
    - apps/desktop/src/renderer/overlay/{EvaModal,EvaMenu,EvaPopover,EvaDrawer}.tsx
    - apps/desktop/src/renderer/overlay/{index,motion}.ts
    - apps/desktop/src/renderer/overlay/overlay.css
    - apps/desktop/src/renderer/overlay/{overlay.test.tsx,overlay-lint.test.ts}
    - apps/desktop/src/renderer/ui/{ScrollArea.tsx,scroll.css,scroll-memory.ts}
    - apps/desktop/src/renderer/ui/{ScrollArea.test.tsx,scroll-memory.test.ts}
    - apps/desktop/src/renderer/dirty/{dirty-store,quit-bridge}.ts
    - apps/desktop/src/renderer/dirty/dirty-store.test.ts
  modified:
    - apps/desktop/src/renderer/browser/useBrowserHotkeys.ts
    - apps/desktop/src/renderer/browser/ImportArcModal.tsx
    - apps/desktop/src/renderer/overlay/TestOverlay.tsx
    - apps/desktop/src/renderer/app/App.tsx
    - apps/desktop/src/main/browser/browser-host.ts
    - apps/desktop/e2e/browser-tabs.spec.ts
    - apps/desktop/e2e/browser-basic.spec.ts
key-decisions:
  - "Router logs to window.__evaosHotkeys whenever that array exists (created by initE2e only under EVAOS_E2E=1), so the router has no e2e flag of its own"
  - "The Esc global handler is consumed only when dismissTop pops an entry (T-02-25)"
  - "Only cmd, ctrl, alt chords and Escape are routed; plain typing and native edit chords are never touched"
duration: 40min
completed: 2026-10-15
---

# Phase 2 Plan 06: Renderer infrastructure Summary

One capture-phase HotkeyRouter with overlay, terminal, page and global scopes, an Esc dismiss stack, Mantine overlay wrappers that always hide the native browser view (with an import lint), a ScrollArea with fades and per-place scroll memory, and a dirty-edits registry wired to main's quit guard.

## Tasks

| Task | Commit |
|------|--------|
| 1. Router, dismiss stack, e2e log, guest hotkey bridge | fc076d7 |
| 2. Overlay wrappers, import lint, Phase 1 overlay migration | 93eb09a |
| 3. ScrollArea, scroll memory, dirty registry, quit bridge | 5e38057 |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Phase 1 e2e specs relied on removed behaviour**
- **Found during:** Task 3 e2e run (the plan's research said no spec used Meta+t; `sendKey` in browser-tabs.spec.ts did)
- **Issue:** cmd+t no longer creates a browser subtab (it is the global new-tab action, D-14), and the Test overlay now has an X Close button as well as the body Close button, so the role selector was ambiguous.
- **Fix:** browser-tabs spec asserts cmd+t from the guest reaches the router as `new-tab` (via `__evaosHotkeys`) and adds the second subtab with the `+` button; browser-basic scopes the Close click to `overlay-test`. cmd+l and cmd+w from the guest still go through `app.hotkey` and are asserted unchanged.
- **Files modified:** apps/desktop/e2e/browser-tabs.spec.ts, apps/desktop/e2e/browser-basic.spec.ts
- **Commit:** 5e38057

**2. [Rule 3 - Blocking] Overlay lint without node types**
- The web tsconfig has no node types, so the lint test scans sources with `import.meta.glob(..., { query: '?raw' })` instead of `node:fs`.

Otherwise the plan executed as written. `browser.hotkey` stays in the contract (unused); removing it is a contract change left for a later cleanup.

## Verification

- Vitest: 51 files, 293 tests pass. Typecheck, eslint, prettier and the em-dash lint are clean.
- `pnpm -C apps/desktop build` succeeds. Playwright: 28 passed, 3 skipped (one earlier run showed one failure while another executor was working in the tree; two consecutive reruns were clean).

## Known Stubs

- Global actions without a feature yet (new-todo, reload, toggle-*, etc.) run named no-op stubs by design (D-14); 02-08 onward register real handlers.
- `panelFocusStore` is not driven yet; 02-08 wires focusin/focusout on the panel card. Until then cmd+w closes a browser subtab only for guest-forwarded keys.

## Threat Flags

None beyond the plan's threat model (T-02-23 to T-02-27 mitigated as specified).

## Requirements

SHEL-05, SHEL-06 and SHEL-08 are not marked complete: this plan delivers primitives only; their user-visible behaviour lands in 02-05 and 02-08 to 02-10.

## Self-Check: PASSED

All created files exist and commits fc076d7, 93eb09a, 5e38057 are in git history.
