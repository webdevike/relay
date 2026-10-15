---
phase: 04-chat-parity
plan: 10
subsystem: chat
tags: [new-chat, transport, adr, draft, session-manager, claude-bridge]
requires: [04-05, 04-06, 04-07, 04-09]
provides:
  - transport ADR (docs/adr/0001-chat-transport.md) and PROJECT.md Key Decisions row
  - createChatTransport (omp or Claude bridge from chat.json at call time)
  - SessionManager openDraft, ownerOf, liveFiles, liveStatus, onStatusChange, renameOwned
  - draft chat flow: chat.openDraft, bind on get_state sessionFile, tab place follows the file
affects: [04-11, 04-12, 04-13, 04-18]
tech-stack:
  patterns: [owner registered at bind for drafts, latest-open-wins in the renderer]
key-files:
  created:
    - docs/adr/0001-chat-transport.md
    - apps/desktop/src/main/chat/transport-factory.ts
    - apps/desktop/src/main/chat/transport-factory.test.ts
    - apps/desktop/e2e/new-chat.spec.ts
    - apps/desktop/src/renderer/chat/chat-store.test.ts
    - proof/phase-4/new-chat.png
    - proof/phase-4/new-chat-claude.png
  modified:
    - .planning/PROJECT.md
    - apps/desktop/src/main/chat/session-manager.ts
    - apps/desktop/src/main/chat/session-manager.test.ts
    - apps/desktop/src/main/chat/live-ipc.ts
    - apps/desktop/src/renderer/chat/ChatPane.tsx
    - apps/desktop/src/renderer/chat/SessionList.tsx
    - apps/desktop/src/renderer/chat/chat-store.ts
    - apps/desktop/src/renderer/chat/open-chat.ts
    - apps/desktop/src/renderer/tabs/tabs-store.ts
    - apps/desktop/src/renderer/hotkeys/e2e-hooks.ts
    - fixtures/fake-omp/fake-omp.mjs
decisions:
  - "Default launch args (approval from config) apply to new chats only; a resumed chat keeps the session's own flags, as in the Rust app"
  - "Harness for launch args is taken from transport.kind, so SessionManager needs no harness dependency"
  - "A draft that loses the bind race stays running unregistered; the first owner keeps the file"
  - "Opening a session from the list in a draft tab points that tab at the session"
metrics:
  tasks: 3
  completed: 2026-10-15
---

# Phase 4 Plan 10: New chat and transport ADR Summary

New chat starts a direct `omp --mode rpc-ui` child (or the Claude bridge when the harness says so) with no `--resume`, binds to the session file omp reports through `get_state`, moves the tab to that file in place, and tags every prompt once; the transport decision is recorded as ADR 0001 and in PROJECT.md.

## Tasks

| Task | Commit |
| ---- | ------ |
| 1 failing e2e and ADR | f9378fd |
| 2 factory, drafts, binding, status APIs | 646237e |
| 3 renderer draft flow | 1e2c208 |

## Deviations from Plan

**1. [Rule 3 - Blocking] Fake omp now logs prompts.** `fixtures/fake-omp/fake-omp.mjs` gained `log('prompt', { message })` so the e2e can assert the surface tag on the exact text omp received. The shell test hook `tabs()` also reports each tab's `chat` place.

**2. [Deviation] Launch args only for new chats.** The plan said to use `launchArgs` for resume and draft starts. A resumed chat in Rust keeps the session's own approval and model, and the existing chat-stream spec asserts a bare `--mode rpc-ui --resume <file>` argv, so defaults go to drafts only. Plan 04-18 extends per pane.

**3. [Rule 1 - Bug] Session list in a draft tab.** Opening a session from the list while the tab place was still `draft` made a later tab switch replace it with a new draft. The list now points the tab at the opened session, and opens are ordered so the latest call wins in both main and the renderer.

## Verification

- Vitest: 123 files, 903 tests pass; typecheck, eslint, prettier and em-dash lint clean; app builds.
- E2E: new-chat (3), chat-stream, chat-control, tabs, chat-list, composer-images, settings-chat, images, sidebar, hotkeys all pass (43 tests). Proof: `proof/phase-4/new-chat.png`, `proof/phase-4/new-chat-claude.png`.

## Deferred Issues

- `e2e/chat-transcript.spec.ts` (5,000 message session) is flaky: it fails on roughly half of runs with the log not at the end marker, and fails identically on the pre-plan renderer (verified by reverting the renderer files and running six times). It passes on retry. Not caused by this plan.
- The known `shell-proof.spec.ts` `sidebar-subpage-chats` failure was not touched (sidebar unchanged).
- `ChatListService` still gets `liveFiles: () => new Set()`; wiring it to `SessionManager.liveFiles()` belongs to the live status plan.

## Self-Check: PASSED

Files and commits f9378fd, 646237e, 1e2c208 exist.
