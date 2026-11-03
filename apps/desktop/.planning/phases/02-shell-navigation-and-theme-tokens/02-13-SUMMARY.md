---
phase: 02-shell-navigation-and-theme-tokens
plan: 13
subsystem: testing
tags: [playwright, e2e, proof, hotkeys, motion, quit-guard, gate]
requires: [02-11, 02-12]
provides:
  - e2e coverage for every README chord, the Esc ladder, guest chord forwarding, entrance motion and the quit guard
  - twelve proof screenshots in proof/phase-2 captured after their state assertions
  - proof/phase-2/CHECKLIST.md mapping success criteria and requirements to evidence
  - green full gate (including packaged smoke)
affects: [phase-2-verification]
tech-stack:
  added: []
  patterns: [playState based motion assertions, stubbed dialog.showMessageBox recording options, assertion-then-capture proof tests]
key-files:
  created:
    - apps/desktop/e2e/hotkeys.spec.ts
    - apps/desktop/e2e/motion.spec.ts
    - apps/desktop/e2e/quit-guard.spec.ts
    - apps/desktop/e2e/shell-proof.spec.ts
    - proof/phase-2/CHECKLIST.md
    - proof/phase-2/ (12 PNGs)
  modified:
    - apps/desktop/src/renderer/hotkeys/e2e-hooks.ts
    - apps/desktop/src/renderer/dirty/dirty-store.ts
key-decisions:
  - "Motion specs judge animation playState, because a finished fill-both fade stays in getAnimations()"
requirements-completed: []  # verifier marks them from CHECKLIST.md
duration: 70min
completed: 2026-10-15
---

# Phase 2 Plan 13: E2E, Proof and Gate Summary

Hotkey, motion and quit-guard specs, twelve state-asserted proof screenshots and a green `scripts/gate.sh` close phase 2.

## Tasks

| Task | Commit | Notes |
|------|--------|-------|
| 1 Hotkey, motion, quit-guard specs | 624947f | added `dirtySaves()` e2e hook |
| 2 Proof screenshots | 77b6f85 | 12 PNGs, each after its assertions |
| 3 Gate and checklist | 4bc12c4 | gate green first run, no lockfile or prettier changes needed |

## Results

- Guest chord forwarding passed through the real path (`sendInputEvent` into the guest webContents hitting `before-input-event`), so the fallback was not needed.
- Gate: Vitest 64 files / 408 tests, e2e 84 passed, packaged smoke 1 passed, `GATE GREEN`.

## Deviations from Plan

**1. [Rule 1 - Test bug] Motion spec expected `getAnimations()` to empty.** A finished `both`-fill animation remains listed, so the specs use `playState` and unchanged start times to prove "once per launch".

**2. [Rule 1 - Test bug] Esc ladder order.** The account trigger lives in the root slot and is inert on a sub-page, so the spec closes the menu first, then opens Chats; fourth Esc still asserts not prevented.

**3. [Rule 1 - Test bug] Quit-guard teardown.** With a dirty entry and a Cancel stub the app would not quit during fixture teardown; an `afterEach` answers Discard.

**4. [Rule 1 - Test bug] Live-switch element count.** Mantine inserts a transient `style[data-mantine-disable-transition]` during a scheme switch; the spec waits for it to go before counting nodes.

## Known Stubs

None.

## Deferred / still-needs-isaac

Feel of the sidebar slide and entrance, and real traffic-light placement in a normal window (see CHECKLIST.md).

## Self-Check: PASSED

Specs, 12 PNGs and CHECKLIST.md exist; commits 624947f, 77b6f85, 4bc12c4 present.
