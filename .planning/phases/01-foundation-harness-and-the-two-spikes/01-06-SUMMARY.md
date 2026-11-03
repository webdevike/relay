---
phase: 01-foundation-harness-and-the-two-spikes
plan: 06
subsystem: chat-control
tags: [abort, steer, lifecycle, pin-to-bottom, pills, frame-time, virtua]
requires: [01-05, 01-02]
provides:
  - chat.abort and chat.close IPC, SessionManager.close with a bounded stdin-end wait, closeAll on quit
  - Composer Stop button and Escape abort, stopped placeholder after close
  - pinReducer, Pills (Jump to latest, New reply), pinned ChatLog on virtua
  - 5,000-message frame-time benchmark with a same-run idle baseline, numbers in metrics.json
affects: [01-10]
tech-stack:
  added: []
  patterns: [pure pin state machine mirrored into the store, baseline-relative frame gate]
key-files:
  created:
    - apps/desktop/src/renderer/chat/{pin,pin.test}.ts
    - apps/desktop/src/renderer/chat/Pills.tsx
    - apps/desktop/e2e/{chat-control,chat-bench}.spec.ts
    - apps/desktop/e2e/helpers/{frames,frames.test}.ts
  modified:
    - packages/contract/src/chat.ts
    - packages/chat-core/src/reducer.test.ts
    - apps/desktop/src/main/chat/{session-manager,session-manager.test,live-ipc,index}.ts
    - apps/desktop/src/renderer/chat/{ChatLog,ChatPane,Composer,chat-store}.ts(x), chat.css
    - apps/desktop/e2e/fixtures.ts
key-decisions:
  - "virtua stays the virtualizer: pin gap 0, no jump while unpinned, gate passed (D-18)"
  - "Frame gate is baseline-relative, not the literal D-28 16 ms (decision 1)"
  - "After close the pane shows the not-running placeholder but stays enabled; the next send spawns a new omp"
requirements-completed: [CHAT-04, CHAT-05, CHAT-06, CHAT-07, PROF-02]
duration: 40min
completed: 2026-10-15
---

# Phase 1 Plan 06: Chat control and the frame-time benchmark Summary

**Stop and Escape abort, mid-turn sends are steers, closing or quitting only ends omp's stdin, and a 5,000-message session follows the stream pinned at gap 0 with Jump to latest and New reply pills, measured against a same-run idle baseline.**

D-28 literal p95 < 16 ms replaced by baseline-relative gate per decision 1: `streamP95 <= max(16.7, idleP95 * 1.25)` with zero frames over 50 ms.

## Measured numbers (chat-bench, 5,000 messages, long-turn about 400 updates, 16 ms delay)

Display: 119.97 Hz.

| Run | p50 | p95 | p99 | max | n |
|-----|-----|-----|-----|-----|---|
| Idle (3 s, same run) | 9.4 | 17.0 | 17.6 | 18.1 | 248 |
| Streaming | 8.4 | 16.9 | 17.4 | 18.8 | 740 |

- Budget `max(16.7, 17.0 * 1.25)` = 21.25 ms; stream p95 16.9 ms; frames over 50 ms: 0; gate passed.
- Earlier runs of the same spec: stream p95 16.7 / 16.7 / 16.8, idle p95 17.0 / 16.9 / 16.9. Streaming is indistinguishable from idle.
- Pinned gap during streaming: 0 px. `scrollTop` unchanged for 2 s of streaming while unpinned. Seq gaps 0, `seqContiguous` true (827 frames in, 759 batches).
- Long animation frames: none. React Profiler commit p95: not available (React production builds do not call `onRender`), recorded as `null` with `profilerCommits: 0`.
- virtua passed every gate, so no fallback to `@tanstack/react-virtual` was needed.

## Accomplishments
- chat.abort returns `{ sent }`, chat.close returns the transport exit; `SessionManager.close(paneId, 10 s)` ends stdin, applies an expected `_eof`, releases single-writer ownership and stops the flush timer. A timeout leaves the process alone.
- chat-control e2e (6 tests): abort by button and Escape, steer ordering and reconciliation (user row once, reply follows), close gives exit 0 / no signal / `stdin-end` before `exit`, quit does the same, second pane refused with the exact UI-SPEC copy.
- `grep` for `.kill(`, SIGKILL, SIGTERM, `process.kill` in `apps/desktop/src/main` prints nothing.
- Pills per UI-SPEC with a 120 ms fade disabled under reduced motion; never both at once.

## Task Commits
1. Failing chat control e2e: `68a73eb`
2. Abort, steer, close and quit lifecycle: `eb56203`
3. Pin, pills and benchmark: `e8c0bd1`

## Deviations from Plan

**1. [Decision 1] Baseline-relative frame gate instead of D-28's literal 16 ms** (as instructed).

**2. [Rule 3 - Blocking] e2e fixture teardown tolerates a closed app**: the quit test closes the app itself, so the post-test `app.evaluate` error check is now caught.

**3. [Rule 1 - Bug] Benchmark measurement**: the `chat-streaming` proof capture blocked frames inside the sampled window and failed the 50 ms rule under the full gate. The sampler is now paused around the capture (samples concatenated), which is a measurement fix, not a loosened rule.

**4. Abort expectations follow the fake recording**: the abort tail replaces the partial text with the recorded aborted message, so the spec asserts `Stopped.` plus kept assistant text rather than the pre-abort fox text.

**5. onBeforeQuit registration moved** from `live-ipc.ts` to `chat/index.ts` to match the plan's grep acceptance.

**6. Profiler p95 recorded as null**: production React skips Profiler callbacks; the Profiler hook stays for dev and profiling builds.

## Known Stubs
None for this plan. Jump and New reply appear only while unpinned; a send while unpinned does not re-pin (matches the plan, not specified by Rust either).

## Threat Flags
None beyond the register. T-01-26 (stdin end only, grep clean), T-01-27 (single-writer refusal copy tested), T-01-28 (strict Zod, unknown pane gives `{ sent: false }` / `{ exit: null }`), T-01-29 (zero long frames) are mitigated.

## Self-Check: PASSED
`corepack pnpm gate` exits 0 (GATE GREEN): 146 unit tests, 20 Playwright specs.
