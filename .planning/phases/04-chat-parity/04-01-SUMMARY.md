---
phase: 04-chat-parity
plan: 01
subsystem: chat-core
tags: [chat-list, categories, workspaces, vitest, typescript]
requires: []
provides:
  - "workspaceOf/WORKSPACES/workspaceNames: Rust keyword grouping of chat titles"
  - "sessionId: id from omp and Claude session file names"
  - "Categories: custom categories (add, rename, remove, assign, reorder) matching chat.json shape"
  - "groupChats: pure chat list view (pinned, running first, five recent plus hidden count, search, archived)"
affects: [04-06, 04-11, 04-12, 04-14, 04-16]
tech-stack:
  added: []
  patterns: ["Electron-free pure ports of Rust logic with ported Vitest cases"]
key-files:
  created:
    - packages/chat-core/src/workspaces.ts
    - packages/chat-core/src/workspaces.test.ts
    - packages/chat-core/src/session-id.ts
    - packages/chat-core/src/session-id.test.ts
    - packages/chat-core/src/categories.ts
    - packages/chat-core/src/categories.test.ts
    - packages/chat-core/src/chat-groups.ts
    - packages/chat-core/src/chat-groups.test.ts
  modified: []
key-decisions:
  - "Pinned rows (not archived) live only in `pinned`, never in their group, matching Rust look::split"
  - "Archived pinned rows go to the archived list, or into their group while searching"
requirements-completed: [CHTP-01, CHTP-02, CHTP-03]
duration: 10 min
completed: 2026-10-15
---

# Phase 4 Plan 01: Chat list core Summary

Pure, tested chat-core ports of the Rust workspace grouping, session ids, custom categories and the grouped list view (pinned, running first, five recent plus `Show N more`, search opening everything including archived).

## Tasks

| Task | Commit | Notes |
| ---- | ------ | ----- |
| 1 workspaces, session-id, Categories | 425a1fc | WORKSPACES copied verbatim from chat.rs |
| 2 groupChats | 3430d7a | also dedups the "already exists" error constant in categories.ts |

## Deviations from Plan

**1. [Plan vs source] Rust chat_groups.rs has one test and no editing methods**
- The plan said to port "4 Rust tests" and add/rename/remove/assign/reorder from chat_groups.rs. The read-only Rust file only has `from_prefs`, `category_of` and one test. The editing methods were implemented from the research spec (04-RESEARCH.md "Categories") with the same error strings; Rust tests that exist were ported (workspace_of, session_id, category_of) and extra Vitest cases cover the rest.
- Verification: 20 tests pass in categories and chat-groups, 14 across workspaces, session-id and categories.

**2. [Source check] Pinned handling**
- Rust `look::split` takes pinned rows out of folders; followed that.

**Total deviations:** 2 documentation-level, no code impact.

## Verification

- `vitest run packages/chat-core/src/` for the new suites: pass; `pnpm -r typecheck`: clean; eslint on new files: clean.
- Acceptance greps: RECENT_CHATS line 1, `600_000` present, no `Date.now`, no node/electron imports, error strings once each.
- Note: the full chat-core suite had one failing file during the run owned by a parallel plan (untracked dialogs/jobs files); not touched.

## Self-Check: PASSED
