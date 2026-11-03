---
phase: 04-chat-parity
plan: 19
subsystem: testing
tags: [playwright, e2e, packaged-smoke, proof, gate]
requires: [04-08, 04-15, 04-16, 04-18]
provides:
  - Phase 4 tour spec (question status, answer, image, live settings, new chat in one session)
  - Packaged smoke that lists fixture chats and proves prompts spawn only the fake omp
  - proof/phase-4 README index with still-needs-isaac and deferred items
  - Green full gate
affects: [phase-4-verification]
tech-stack:
  added: []
  patterns: [packaged smoke reads a disposable chat fixture and asserts spawn log paths via realpath]
key-files:
  created:
    - apps/desktop/e2e/phase4-tour.spec.ts
    - proof/phase-4/README.md
    - proof/phase-4/tour-chat-question.png
    - proof/phase-4/tour-chat-image.png
    - proof/phase-4/tour-chat-new.png
    - proof/phase-4/tour-chat-compact.png
  modified:
    - apps/desktop/e2e/packaged.spec.ts
    - apps/desktop/src/renderer/chat/ChatLog.tsx
    - packages/chat-core/src/fake-omp.contract.test.ts
decisions:
  - "Show tool details off folds each run of tool calls into one line in ChatLog (Rust tool-group behaviour, simplified)"
  - "chat-transcript 5,000-message flake recorded as a deferred gap (passed in the final gate run)"
metrics:
  tasks: 2
  completed: 2026-10-15
---

# Phase 4 Plan 19: Tour, packaged smoke and proof index Summary

One continuous Playwright session now proves the Phase 4 slices together, the packaged app is shown to start omp only through the fake binary, and the full gate (`GATE GREEN`) passes with proof indexed in `proof/phase-4/README.md`.

## Tasks

| Task | Commit | Result |
| --- | --- | --- |
| 1. Tour spec and packaged smoke | b30a832 | tour passes; packaged smoke passes |
| 2. Gate, proof run, proof index | 82de14d, 06483db | gate green, 31 PNGs, README |

Gate result: Vitest 1053 passed, 184 e2e passed (2 env-gated skips), metrics check, packaged smoke.

## Deviations from Plan

**1. [Rule 2 - Missing functionality] show_tools had no effect on the chat log**
- **Found during:** Task 1 (plan requires "tool rows fold without reload")
- **Issue:** 04-07 persisted `show_tools` but nothing consumed it.
- **Fix:** `ChatLog` reads `show_tools`; when off, each run of tool messages becomes one `N tool calls` row.
- **Files:** apps/desktop/src/renderer/chat/ChatLog.tsx
- **Commit:** b30a832

**2. [Rule 3 - Blocking] Gate lint and prettier debt**
- **Issue:** eslint `no-explicit-any` in fake-omp.contract.test.ts and prettier drift in 7 Phase 4 files blocked the gate.
- **Fix:** targeted eslint-disable with reason on the four loose wire-JSON lines; `prettier --write`.
- **Commit:** style(04-19) commit

**3. Packaged spec adjustments:** spawns without a resume file (side probes) are allowed; resumed paths are compared by realpath because macOS tmp resolves through /private.

## Deferred gaps

- `chat-transcript.spec.ts` 5,000-message flake (about 50%, predates Phase 4); passed in the final gate run. Recorded in proof/phase-4/README.md.
- Tool folding shows a count, not the Rust per-tool summary.

## Known Stubs

None.

## Self-Check: PASSED
