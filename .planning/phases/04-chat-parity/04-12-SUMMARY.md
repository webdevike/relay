---
phase: 04-chat-parity
plan: 12
subsystem: chat
tags: [chat-list, watch, live-status, chokidar]
requires: [04-10, 04-11]
provides:
  - ChatWatch (chokidar depth 1 plus recent-file stat poll plus slow sweep, 100 ms debounce)
  - live row status (Open, Working, Needs approval, Has a question, Job) via rowStatus
  - chat.listChanged push, list-store subscription with stable row identity and 300 ms change highlight
  - registerChat returns onSessionsChanged for 04-15 (no second watcher)
affects: [04-13, 04-14, 04-15]
key-files:
  created:
    - apps/desktop/src/main/chat/chat-watch.ts
    - apps/desktop/src/main/chat/chat-watch.test.ts
    - apps/desktop/e2e/chat-watch.spec.ts
    - proof/phase-4/chat-status.png
    - proof/phase-4/chat-watch-latency.json
  modified:
    - apps/desktop/src/main/chat/chat-list.ts
    - apps/desktop/src/main/chat/chat-list.test.ts
    - apps/desktop/src/main/chat/index.ts
    - apps/desktop/src/main/chat/chat-list-ipc.ts
    - apps/desktop/src/renderer/chat/list/list-store.ts
    - apps/desktop/src/renderer/chat/list/list-store.test.ts
    - apps/desktop/src/renderer/chat/list/ChatRow.tsx
    - apps/desktop/src/renderer/chat/list/ChatList.tsx
    - apps/desktop/src/renderer/chat/list/chat-list.css
decisions:
  - "Assumption A2 outcome: chokidar 5 on macOS DID report appends through a descriptor held open on an old file (unit test, under 500 ms), so FSEvents-style misses did not reproduce. The stat poll (200 ms, recent or live files only) and a 1 s full sweep stay as a belt, matching the Rust PollWatcher rationale at flat CPU cost."
  - "Background jobs are parsed from the full file only when its mtime or size changed and the file is at most 8 MB; larger files list without a Job status."
  - "Status changes from the app's own sessions coalesce for 30 ms before pushing the list."
metrics:
  tasks: 3
  completed: 2026-10-15
---

# Phase 4 Plan 12: Live chat list Summary

The Chats list now follows session files without refocusing: a new file appeared in about 120 ms in all three measured trials (budget 500 ms, `proof/phase-4/chat-watch-latency.json`), and rows show Open, Working, Needs approval, Has a question or Job with Rust wording, updating instantly for the app's own sessions.

## Tasks

| Task | Commit |
| ---- | ------ |
| 1 Failing e2e (latency, held-open append, delete, Job, Working to Open) | test(04-12) |
| 2 ChatWatch and live status in ChatListService, wiring in index.ts | feat(04-12) ChatWatch |
| 3 Renderer subscription, stable updates, status presentation | feat(04-12) live subscription |

## Verification

- vitest: chat main suites (78) and renderer suites (326) green; typecheck, eslint, em-dash lint clean; app builds.
- e2e green twice: chat-watch (2), chat-list (4), chat-list-search (3); EVAOS_PROOF run wrote `chat-status.png` (taken while Working) and the latency file.

## Deviations from Plan

1. The e2e expands every "Show N more" group before checking p4-jobs (it sits beyond the first five rows); the Open check targets `.eva-cl-dot[data-status="open"]` because the wrapper span carries the same attribute.
2. `registerChatListIpc` takes the SessionManager as an unused `_manager` parameter, as specified, for later rename and delete rules.

The unrelated pre-existing uncommitted formatting change in `packages/chat-core/src/workspaces.ts` was left alone. The known flaky chat-transcript 5,000-message test was not touched (no ChatLog scrolling changes).

## Known Stubs

None. `liveStatus` dialog stays null until the question slice lands (existing SessionManager behavior).

## Self-Check: PASSED
