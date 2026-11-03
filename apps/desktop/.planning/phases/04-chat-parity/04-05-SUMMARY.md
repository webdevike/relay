---
phase: 04-chat-parity
plan: 05
subsystem: chat
tags: [contract, zod, ipc, chat-core, transport]
requires: []
provides:
  - chat-core status constants (CHAT_STATUSES, STATUS_LABEL, rowStatus)
  - widened ChatMessage images, SessionMeta contextWindow, Dialog/Subagent/BgJob/ModelInfo schemas
  - ChatTransport with nullable sessionFile, launch args and prompt images
  - all Phase 4 chat IPC channels and events (Zod validated)
affects: [04-06, 04-07, 04-08, 04-09, 04-10, 04-13, 04-14]
key-files:
  created:
    - packages/chat-core/src/status.ts
    - packages/chat-core/src/status.test.ts
    - packages/chat-core/src/message.test.ts
  modified:
    - packages/chat-core/src/message.ts
    - packages/chat-core/src/batcher.ts
    - packages/chat-core/src/batcher.test.ts
    - packages/chat-core/src/transport.ts
    - apps/desktop/src/main/chat/omp-transport.ts
    - apps/desktop/src/main/chat/omp-transport.test.ts
    - packages/contract/src/chat.ts
    - packages/contract/src/contract.test.ts
    - packages/contract/src/index.ts
decisions:
  - Status labels are Rust words sentence-cased in one module; precedence is dialog confirm, dialog other, working, jobs, owned
  - Dialog schemas mirror the shapes 04-02 documents for dialogs.ts
metrics:
  tasks: 3
  completed: 2026-10-15
---

# Phase 4 Plan 05: Chat contract Summary

Interface-first contract for Phase 4: status wording module, widened message/meta/batcher types, a transport that can start new chats and send images, and 14 new typed chat invoke channels plus 2 events.

## Commits
- 75f93fc: status constants, widened message, meta and batcher types
- 736f554: transport signature for new chats, launch args, images
- (contract commit, next in git log): Phase 4 chat IPC contract

## Notes
- packages/contract/src/index.ts changed: it now re-exports ChatList, ChatRow, ChatPrefs, DialogResponse, LaunchState, LaunchPatch, Extras types.
- `cmd.prompt` in frames.ts is untouched; images are spread onto the prompt command inside OmpStdioTransport.send.
- Rust sources use lowercase "needs approval" / "has a question"; the plan-mandated sentence-cased labels are in STATUS_LABEL.
- chat.send's `text` is now allowed empty when images are present (refine); SessionManager callers still compile unchanged.

## Deviations from Plan
None in scope. Running prettier over the shared package dirs may have reformatted other parallel executors' uncommitted files (categories.ts, workspaces.ts in chat-core); those were not staged. A categories test failing in packages/chat-core belongs to another plan in this wave.

## Self-Check: PASSED
Vitest (contract, status, batcher, message, desktop chat), typecheck and eslint green at commit time.
