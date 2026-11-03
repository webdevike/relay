---
phase: 04-chat-parity
plan: 11
subsystem: chat
tags: [chat-list, search, collapse, archived, chat-json]
requires: [04-06]
provides:
  - chat.setCollapsed handler (single-key write of collapsed_groups on the WriteQueue)
  - list-store collapse (optimistic with rollback) and showArchived state
  - debounced title search that opens every group including archived chats
  - Archived (n) toggle at the bottom of the Chats tree
affects: [04-12, 04-13]
key-files:
  created:
    - apps/desktop/e2e/chat-list-search.spec.ts
    - apps/desktop/src/main/chat/chat-list-ipc.test.ts
    - apps/desktop/src/renderer/chat/list/ChatList.test.tsx
    - proof/phase-4/chat-search.png
    - proof/phase-4/chat-collapsed.png
  modified:
    - apps/desktop/src/main/chat/chat-list-ipc.ts
    - apps/desktop/src/renderer/chat/list/ChatList.tsx
    - apps/desktop/src/renderer/chat/list/list-store.ts
    - apps/desktop/src/renderer/chat/list/list-store.test.ts
    - apps/desktop/src/renderer/chat/list/chat-list.css
    - apps/desktop/e2e/chat-list.spec.ts
decisions:
  - Search state stays in SubPages; ChatList debounces it 100 ms itself and clears instantly when emptied.
  - Escape clearing reuses SearchBox's existing dismiss behaviour (no change to SubPages needed).
metrics:
  tasks: 3
  completed: 2026-10-15
---

# Phase 4 Plan 11: Chat search, collapse and Archived toggle Summary

Chats search now filters by title (100 ms debounce), opens every matching group in full with archived matches chipped `Archived`, shows `No chats match "{q}"` / `Try a different title.` on no match, and group collapse persists to chat.json `collapsed_groups` via a new `chat.setCollapsed` handler; an `Archived (n)` button hides archived chats when not searching.

## Tasks

| Task | Commit |
| ---- | ------ |
| 1 Failing e2e (search, collapse persistence, archived toggle) | 14269b0 |
| 2 and 3 Handler, store, tree changes, unit tests | ce99a5c |

Tasks 2 and 3 were committed together because the store and tree changes were verified as one unit.

## Verification

- vitest: chat-list-ipc (3), list-store, ChatList (3), sidebar suites green; typecheck, eslint, em-dash lint clean; app builds.
- e2e green: chat-list-search (3), chat-list (4), sidebar (7), shell-proof (12). Proof: `proof/phase-4/chat-search.png`, `proof/phase-4/chat-collapsed.png`.

## Deviations from Plan

**1. [Rule 1 - Bug] Known issue fixed: shell-proof `sidebar-subpage-chats`.** Search was previously ignored, so typing `plan` never reached the empty state. Real filtering with the `sidebar-sub-empty` no-match state fixes it; the spec now passes.

**2. Contract and reduced-motion already present.** `chat.setCollapsed` was already in the contract (04-05) and the chevron already honoured reduced motion; no change needed beyond the handler. The 04-06 e2e assertion for the archived toggle was updated to `Archived (1)`.

## Deferred Issues

- `chat-transcript.spec.ts` 5,000 message test is flaky (about 50% fail at `LAST-MESSAGE-MARKER`): the virtualised log lands near but not at the end after open. An attempt to re-aim `scrollToIndex` over several animation frames made it fail every time, so it was reverted. Likely cause is virtua height estimates or messages arriving after the open jump; needs a dedicated look at ChatLog.tsx.
- Pre-existing uncommitted prettier-only change in `packages/chat-core/src/workspaces.ts` left untouched.

## Self-Check: PASSED
