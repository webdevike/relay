---
phase: 01-foundation-harness-and-the-two-spikes
plan: 03
subsystem: chat
tags: [omp-sessions, virtua, zustand, ipc, parser-port]
requires: [01-01]
provides:
  - parseSession and listSessionFiles ported from Rust session() and sessions_dir in @evaos/chat-core
  - chat.listSessions and chat.open IPC channels with realpath containment
  - Virtualized transcript (virtua VList) with session list, collapsed Thinking and tool rows
  - Deterministic 5,000-message benchmark fixture and small fixture session
affects: [01-05, 01-06]
tech-stack:
  added: []
  patterns: [flat ChatMessage rows, zustand vanilla store outside React, coded handler errors]
key-files:
  created:
    - packages/chat-core/src/message.ts
    - packages/chat-core/src/session.ts
    - packages/chat-core/src/sessions-dir.ts
    - apps/desktop/src/main/chat/transcript-ipc.ts
    - apps/desktop/src/renderer/chat/ChatLog.tsx
    - apps/desktop/src/renderer/chat/MessageRow.tsx
    - apps/desktop/src/renderer/chat/SessionList.tsx
    - apps/desktop/src/renderer/chat/chat-store.ts
    - scripts/gen-benchmark-session.ts
    - fixtures/agent/sessions/-fixture/
    - apps/desktop/e2e/chat-transcript.spec.ts
  modified:
    - packages/contract/src/chat.ts
    - apps/desktop/src/main/ipc/handle.ts
key-decisions:
  - "handle() now maps a thrown error carrying a kebab-case string code to that Result error code (used for outside-sessions-dir)."
  - "Unanswered tool calls stay status running, matching the plan; only a toolResult sets done or failed."
requirements-completed: [CHAT-01, CHAT-04]
duration: 35min
completed: 2026-10-15
---

# Phase 1 Plan 03: Transcript slice Summary

**Past omp sessions open from a list into a virtua log: the Rust active-branch parser is ported with tests, `chat.open` is path-contained, and the 5,000-message fixture mounts under 200 rows and opens at the end.**

## Accomplishments
- Parser port covers abandoned branch, hidden agent handoff, surface tag strip, tool result attach (done/failed/running), meta from active branch, title fallback, malformed lines. 13 chat-core tests.
- Benchmark generator is seeded and byte-identical across runs (sha1 f6d36719...); 5,192 message records, 5,000 user/assistant turns, last reply carries `LAST-MESSAGE-MARKER`.
- e2e: list, header title, collapsed thinking expands on click, tool row `done`, verbatim code fence, literal `<b>` text, abandoned and agent rows absent, bench log mounts fewer than 200 rows, within 48px of the bottom, and `/etc/hosts` is refused.
- `pnpm gate` is GREEN (4 e2e specs).

## Task Commits
1. Task 1: fixtures, generator, parser port, failing e2e - `33bb1c1`
2. Task 2: IPC and virtualized UI - `c4df595`

## Deviations from Plan

**1. [Rule 3 - Blocking] chat-core and contract dependencies**
- chat-core needed `zod` and `@types/node` (with `types: ["node"]`); contract needed a workspace dep on `@evaos/chat-core`. Lockfile regenerated.

**2. [Rule 2 - Missing critical] Coded handler errors**
- `handle()` turned every throw into `internal`, so `outside-sessions-dir` could not be returned. It now passes through lowercase kebab-case `code` properties.

**3. [Rule 1 - Bug] Test cleanup**
- Renderer tests did not unmount between cases (no vitest globals); `test-setup.ts` now registers RTL `cleanup`.

**4. [Rule 3 - Blocking] ResizeObserver notice failed the main-error gate**
- virtua's initial scroll triggers the benign "ResizeObserver loop completed with undelivered notifications" console error, which fixtures.ts treats as a failure. `test-hooks.ts` now ignores that one message prefix.

**5. Thinking and tool bodies mount only when expanded**
- Collapse still keeps children in the DOM, so content is rendered only when open (also cheaper for virtualization).

**6. Session list title fallback reads the whole file** when line 1 has an empty title (needed for the first-prompt title); files with titles read only the first 64 KB.

## Known Stubs
- Pin pills, composer and live streaming are plans 01-05 and 01-06; `pinned` is tracked in a ref only.
- `resolveLiveSessionsDir` is implemented and tested but not yet called (fixture dir comes from `EVAOS_SESSIONS_DIR`).
- Images show no preview (placeholder label only, Phase 4).

## Threat Flags
None beyond the plan's register: T-01-12 (realpath containment), T-01-13 (text nodes only, grep clean), T-01-14 (per-line try/catch, 50 cap), T-01-15 (synthetic fixtures) are mitigated.

## Self-Check: PASSED
