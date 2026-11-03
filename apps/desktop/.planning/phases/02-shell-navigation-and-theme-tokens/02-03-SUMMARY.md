---
phase: 02-shell-navigation-and-theme-tokens
plan: 03
subsystem: shell
tags: [shell-core, tabs, place, vitest]
requires: [02-01]
provides:
  - "@evaos/shell-core place.ts: Place model, samePlace, placeKey, placeToJson/placeFromJson, pageKey/pageFromKey"
  - "@evaos/shell-core tabs.ts: immutable Tabs reducer (navigate, forkTab, openNewChat, switchTo, close*, togglePin, back, forward, loadTabs, saveTabs)"
affects: [02-07, 02-09]
tech-stack:
  added: []
  patterns: ["immutable reducer keyed by stable tab ids"]
key-files:
  created:
    - packages/shell-core/src/place.ts
    - packages/shell-core/src/place.test.ts
    - packages/shell-core/src/tabs.ts
    - packages/shell-core/src/tabs.test.ts
  modified:
    - packages/shell-core/src/index.ts
key-decisions:
  - "Fresh (cmd-click) tabs still record the forked place as history on first navigation, matching the Rust code (its comment says otherwise)"
  - "Closing the last tab leaves a Dashboard tab (D-07), differing from Rust's new chat"
requirements-completed: [SHEL-04]
duration: 8min
completed: 2026-10-15
---

# Phase 2 Plan 03: Tabs and places Summary

Faithful TypeScript port of tabs.rs: the Place model, one-place-one-tab dedupe, pinned-first rules, 50-entry back/forward stacks and a Rust-shaped, never-throwing layout.json load/save, with the Rust unit tests ported to Vitest.

## Tasks

| Task | Commit |
| ---- | ------ |
| 1 Place model and saved-place JSON | 75b4efb |
| 2 Tabs reducer | e5e8fe6 |

40 Vitest tests pass in shell-core; typecheck and eslint clean. Threat T-02-09 mitigated: `loadTabs` tolerates null, scalars, malformed lists, unknown pages, and truncates history to 50.

## Deviations from Plan

None in substance. Tests and implementation written together per task (single GREEN run), so no separate RED commits. The Rust "fresh tab starts no history" comment contradicts its code; the code behavior was ported (noted in a test).

## Known Stubs

None.

## Self-Check: PASSED
