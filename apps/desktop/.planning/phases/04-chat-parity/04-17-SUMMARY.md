---
phase: 04-chat-parity
plan: 17
subsystem: chat
tags: [shared-writers, session-manager, modal, electron, react]
requires:
  - phase: 04-05
    provides: chat.send force and chat.open owner contract fields
  - phase: 04-10
    provides: SessionManager owner registry (ownerOf, onStatusChange)
  - phase: 04-09
    provides: SessionManager.send with images
provides:
  - owned-elsewhere rules in SessionManager.send (owned by another pane, or written in the last 10 minutes with no owner)
  - forced send routed through the owner's transport (one omp per file), remembered per file until the owner changes
  - chat.open returns owner; e2e-only hooks openInPane and sendFromPane
  - WriterPrompt (400px EvaModal), Composer resend with force true, header chip Owned by another pane
affects: [04-chat-parity]
tech-stack:
  added: []
  patterns:
    - "send() = writerFor() guard, then startTransport, then deliver(); deliver is shared by own and routed sends"
key-files:
  created:
    - apps/desktop/e2e/writers.spec.ts
    - apps/desktop/src/renderer/chat/WriterPrompt.tsx
    - apps/desktop/src/renderer/chat/WriterPrompt.test.tsx
    - proof/phase-4/writer-prompt.png
  modified:
    - apps/desktop/src/main/chat/session-manager.ts
    - apps/desktop/src/main/chat/session-manager.test.ts
    - apps/desktop/src/main/chat/live-ipc.ts
    - apps/desktop/src/main/chat/transcript-ipc.ts
    - apps/desktop/src/main/chat/index.ts
    - apps/desktop/src/renderer/chat/Composer.tsx
    - apps/desktop/src/renderer/chat/ChatPane.tsx
    - apps/desktop/src/renderer/chat/chat-store.ts
    - apps/desktop/src/renderer/chat/chat.css
key-decisions:
  - "A send into a file whose owner is still closing skips the prompt and falls to acquire(), which keeps its already-owned/still-closing behaviour"
  - "Remembered choices live in a Map keyed by realpath (value: owner pane id or 'external') and are dropped inside notify() when the owner differs"
  - "The owner chip hides when this pane's own omp runs (extras.running), so it cannot go stale after the pane becomes the owner"
requirements-completed: [CHTP-10]
duration: 25min
completed: 2026-10-15
---

# Phase 4 Plan 17: Shared Writers Summary

Sending into a chat another pane owns, or one written in the last 10 minutes with no owner here, now asks first (`Chat is open elsewhere`). `Send anyway` goes through the owning process, so there is still exactly one omp per session file.

## Tasks

| Task | Commit |
| ---- | ------ |
| 1. Failing e2e for the writer prompt | 973287c |
| 2. owned-elsewhere rules, routing, remembered choice | f916ba5 |
| 3. WriterPrompt, force resend, owner chip, proof | e2210fd |

## Verification

- Full vitest: 133 files, 1030 tests green (7 new session-manager cases, 3 WriterPrompt cases).
- typecheck, eslint, em-dash lint, `pnpm -C apps/desktop build` clean; `.kill(` count in session-manager is 0.
- e2e (EVAOS_E2E=1): writers (2), chat-stream, composer-images, new-chat, chat-ops all green, 18 of 18.
- Proof: proof/phase-4/writer-prompt.png (modal with `Don't send` focused, viewed).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] e2e asserted visibility on the Mantine Modal.Root test id**
- **Issue:** the root element is a zero-size wrapper and reports hidden.
- **Fix:** the spec locates the modal by its title text.
- **Commit:** e2210fd

**2. Execution order:** Task 2 code was written before Task 1 was committed; commits still follow plan order (e2e, main, renderer).

## Known Stubs

None. A routed send echoes the prompt row into the owning pane's reducer; a non-owning pane's transcript shows it only after reopen (real multi-pane live sync is Phase 6).

## Deferred Issues

- Pre-existing flaky chat-transcript 5,000-message test untouched (ChatLog not touched).
- Unrelated working-tree edit to packages/chat-core/src/workspaces.ts (formatting) was present at start and left uncommitted.

## Threat Flags

None. T-04-54 (force routes to the owner transport, acquire still refuses races), T-04-55 (hooks only under env.e2e), T-04-56 (explicit confirm, memory dropped on owner change) are implemented.

## Self-Check: PASSED
