---
phase: 04-chat-parity
plan: 15
subsystem: chat
tags: [subagents, background-jobs, chat-extras, electron, react]
requires:
  - phase: 04-12
    provides: ChatWatch batches of changed session paths
  - phase: 04-13
    provides: PendingDialog slot between log and composer
provides:
  - ExtrasService in main emitting chat.extras per pane
  - SessionManager.paneFiles
  - SubagentChips and JobsStrip components with chat-store extras state
affects: [04-chat-parity]
tech-stack:
  added: []
  patterns:
    - "File-derived extras computed in main, deep-compared, pushed as events; renderer store stashes events that beat chat.open"
key-files:
  created:
    - apps/desktop/src/main/chat/extras.ts
    - apps/desktop/src/main/chat/extras.test.ts
    - apps/desktop/src/renderer/chat/strips/SubagentChips.tsx
    - apps/desktop/src/renderer/chat/strips/JobsStrip.tsx
    - apps/desktop/src/renderer/chat/strips/strips.css
    - apps/desktop/src/renderer/chat/strips/strips.test.tsx
    - apps/desktop/e2e/subagents-jobs.spec.ts
  modified:
    - apps/desktop/src/main/chat/index.ts
    - apps/desktop/src/main/chat/session-manager.ts
    - apps/desktop/src/main/chat/session-manager.test.ts
    - apps/desktop/src/renderer/chat/chat-store.ts
    - apps/desktop/src/renderer/chat/ChatPane.tsx
key-decisions:
  - "Changed files are matched to panes by basename (file or stem folder), avoiding realpath mismatches such as /var vs /private/var"
  - "Subagent failed is always false: the Rust source has no failed state"
  - "Only omp-layout subagent folders are read (<stem>/*.jsonl); Claude subagents/ layout is not covered"
requirements-completed: [CHTP-09]
duration: 30min
completed: 2026-10-15
---

# Phase 4 Plan 15: Subagent chips and jobs strip Summary

Open chats show subagent chips (running spinner, finished check, Clear done, last-line popover) and a collapsible jobs strip while this app's omp runs, all derived from session files via the existing 04-12 watcher.

## Tasks

| Task | Commit |
|------|--------|
| 1 Failing e2e | 22c19d2 |
| 2 ExtrasService and paneFiles | 2eba6dc |
| 3 Chips and strip UI | 4244aba |

## Verification

- vitest main/chat and renderer/chat: 213 tests pass (extras 7, strips 7)
- typecheck, eslint, em-dash lint clean; app builds
- e2e subagents-jobs (3), questions (all), chat-stream, chat-watch pass with EVAOS_E2E=1
- Proof: proof/phase-4/subagent-chips.png, proof/phase-4/jobs-strip.png

## Deviations from Plan

**1. [Rule 1 - Bug] chat.extras event beat chat.open response**
- **Found during:** Task 3 e2e
- **Issue:** Main emits extras during the chat.open handler; the renderer received it before the pane existed (or before openPane replaced the pane), so chips were lost.
- **Fix:** Store keeps `pendingExtras` for absent panes; openPane carries over the existing/pending extras (draft panes start empty). ExtrasService.reset makes the first refresh after open always emit.
- **Files:** chat-store.ts, extras.ts, index.ts
- **Commit:** 4244aba, 2eba6dc

**Total deviations:** 1 auto-fixed. No impact on scope.

## Known Stubs

None.

## Deferred / notes

- chat-transcript 5,000-message flake untouched (plan does not touch ChatLog scrolling).
- Pre-existing uncommitted prettier change in packages/chat-core/src/workspaces.ts left alone.

## Self-Check: PASSED
