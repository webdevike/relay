---
phase: 04-chat-parity
plan: 13
subsystem: chat
tags: [questions, extension-ui, dialogs, hotkeys]
requires: [04-10]
provides:
  - LiveReducer.dialog state (held instead of auto-cancelled), answer(), cancelPending()
  - SessionManager.answerUi (pending-id check), cancel-on-abort, dead on exit, liveStatus.dialog
  - chat.answerUi IPC handler
  - QuestionCard, ExtensionUiCard, PendingDialog above the composer
  - bare 1-4 digit chords through the hotkey router with an input/xterm guard
affects: [04-14, 04-15]
key-files:
  created:
    - apps/desktop/e2e/questions.spec.ts
    - apps/desktop/src/renderer/chat/cards/QuestionCard.tsx
    - apps/desktop/src/renderer/chat/cards/ExtensionUiCard.tsx
    - apps/desktop/src/renderer/chat/cards/PendingDialog.tsx
    - apps/desktop/src/renderer/chat/cards/useQuestionHotkeys.ts
    - apps/desktop/src/renderer/chat/cards/cards.css
    - apps/desktop/src/renderer/chat/cards/cards.test.tsx
    - proof/phase-4/question-card.png
    - proof/phase-4/question-confirm.png
    - proof/phase-4/question-dead.png
  modified:
    - packages/chat-core/src/reducer.ts
    - packages/chat-core/src/reducer.test.ts
    - packages/chat-core/src/dialogs.ts
    - apps/desktop/src/main/chat/session-manager.ts
    - apps/desktop/src/main/chat/session-manager.test.ts
    - apps/desktop/src/main/chat/live-ipc.ts
    - apps/desktop/src/renderer/chat/chat-store.ts
    - apps/desktop/src/renderer/chat/ChatPane.tsx
    - apps/desktop/src/renderer/hotkeys/router.ts
    - apps/desktop/src/renderer/hotkeys/router.test.tsx
decisions:
  - "A lone single-choice question answers on click or key; multi-question or multi-select asks collect picks and send one frame from Send answer once every question has a pick."
  - "Key chips show only on the first unanswered question, since digits target that one."
  - "The router lets a bare 1-4 through only when focus is not an input, textarea, select, contentEditable or inside .xterm; it still dispatches only if a page handler claims it."
  - "Dead card: the store keeps the dialog when a batch clears it while the pane becomes stopped; a new dialog or reconnect clears it."
  - "Answer summaries: select label, ask labels joined with ', ', confirm 'Confirm', text first 80 chars one-lined, cancel 'Declined'."
metrics:
  tasks: 3
  completed: 2026-10-15
---

# Phase 4 Plan 13: Question cards and extension UI Summary

omp's blocking `ask` and extension UI requests (select, confirm, input, editor) are now held as dialog state and answered through numbered cards pinned above the composer, replacing the old reducer auto-cancel while keeping omp from ever hanging.

## Commits

- ffd2d41 test(04-13): e2e for question cards and extension UI
- 444609f feat(04-13): dialog state in the reducer and answerUi path in main
- 22adfc5 feat(04-13): question and extension UI cards with 1-4 hotkeys

## Verification

- vitest: chat-core, main chat and renderer suites green (14 new reducer and session-manager cases, card and router tests added).
- typecheck, eslint, em-dash lint clean; desktop build succeeds.
- Playwright (EVAOS_E2E=1): questions.spec.ts 10/10, plus hotkeys, chat-stream, chat-control 16/16. Proof shots in `proof/phase-4/question-*.png`.

## Deviations from Plan

None - plan executed as written. The reducer also treats `method: 'cancel'` with a matching targetId as a dead dialog (per behavior list).

## Known Stubs

None.

## Threat Flags

None. T-04-40 to T-04-43 mitigations implemented: pending-id check in answerUi, text-node rendering (no HTML APIs), cancel on abort and dead on exit, digit guard.

## Notes

The chat-transcript 5,000-message flake was not touched (this plan does not change ChatLog scrolling).

## Self-Check: PASSED
