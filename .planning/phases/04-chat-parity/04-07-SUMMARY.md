---
phase: 04-chat-parity
plan: 07
subsystem: chat
tags: [settings, chat-json, harness, claude-bridge, transport, e2e]
requires:
  - phase: 04-chat-parity
    provides: chat.harnessStatus contract (04-05), env.claudeBridgeBin/claudeBin (04-04), fake-claude-bridge fixture
provides:
  - Chat settings (show_thinking, show_tools, harness) stored in chat.json with settings.json read fallback
  - chat.harnessStatus handler in main
  - Harness SegmentedControl in Settings > Chat with the Claude-missing notice
  - ClaudeBridgeTransport (bridge --rpc over the omp stdio code, never signals)
  - ChatLog drops thinking rows live when Show thinking is off
affects: [04-10, 04-11, 04-14, 04-16]
key-files:
  created:
    - apps/desktop/src/main/chat/claude-transport.ts
    - apps/desktop/src/main/chat/claude-transport.test.ts
    - apps/desktop/e2e/settings-chat.spec.ts
    - proof/phase-4/settings-chat.png
    - proof/phase-4/settings-harness-missing.png
  modified:
    - packages/contract/src/shell.ts
    - apps/desktop/src/main/settings-ipc.ts
    - apps/desktop/src/main/config-ipc.test.ts
    - apps/desktop/src/main/chat/omp-transport.ts
    - apps/desktop/src/renderer/settings/settings-store.ts
    - apps/desktop/src/renderer/settings/ChatSection.tsx
    - apps/desktop/src/renderer/chat/ChatLog.tsx
    - apps/desktop/e2e/settings.spec.ts
    - apps/desktop/e2e/chat-transcript.spec.ts
    - apps/desktop/e2e/shell-proof.spec.ts
key-decisions:
  - "saveSettings writes only the patched keys to chat.json (merge via readForMerge), so settings.json values are never migrated or rewritten"
  - "OmpStdioTransport gained optional kind and command options; omp default argv is byte-identical"
  - "ClaudeBridgeTransport is a subclass, spawned through buildCommand (.ts via bun, .mjs via node)"
requirements-completed: [CHTP-07, CHTP-12]
duration: 40min
completed: 2026-10-15
---

# Phase 4 Plan 07: Chat settings in chat.json and Claude bridge transport Summary

Show thinking, Show tool details and the new Harness choice now persist in chat.json like the Rust app (thinking defaults off), with a ClaudeBridgeTransport ready for the 04-10 harness factory.

## Tasks

| Task | Commit | Notes |
| ---- | ------ | ----- |
| 1. Failing e2e | 442bb7c | settings-chat spec, updated settings, shell-proof and chat-transcript specs |
| 2. chat.json settings and harnessStatus | 171fd0f | contract harness enum, load/save/handler, 6 new unit cases |
| 3. Harness control and Claude transport | 9103f00 | store, ChatSection, ChatLog live filter, transport and tests |

## Verification

- Full vitest: 850 passed. Typecheck, eslint, em-dash lint, and desktop build clean.
- e2e settings-chat, settings, chat-transcript: pass; proof screenshots in `proof/phase-4/`.

## Deviations from Plan

**1. [Rule 2 - Missing functionality] ChatLog applies Show thinking**
- Nothing in the chat renderer consumed the setting, so "applies live to the open chat" could not hold. ChatLog now loads settings and filters thinking rows (`apps/desktop/src/renderer/chat/ChatLog.tsx`).
- chat-transcript.spec seeds `chat.json {show_thinking:true}` since it asserts the thinking row (default is now off).
- Show tool details is persisted but not yet consumed by the transcript (outside the plan's e2e; tool folding belongs to the transcript work).

## Deferred Issues

- `e2e/shell-proof.spec.ts` `sidebar-subpage-chats` fails at `sidebar-sub-empty` after typing `plan` in the sidebar search. Not touched by this plan; it follows the 04-06 sidebar Chats tree change. Deferred.
- Running shell-proof with EVAOS_PROOF=1 regenerates other phase-2 PNGs; only `proof/phase-2/settings-chat.png` (thinking now off) was kept.
- `packages/chat-core/src/workspaces.ts` has a pre-existing uncommitted formatting change, left alone.

## Self-Check: PASSED
