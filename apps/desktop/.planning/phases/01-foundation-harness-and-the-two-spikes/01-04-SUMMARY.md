---
phase: 01-foundation-harness-and-the-two-spikes
plan: 04
subsystem: chat-transport
tags: [omp, rpc-ui, line-framer, zod, fake-omp, vitest]
requires: [01-01]
provides:
  - Real omp 18.8.5 rpc-ui turn recording (scrubbed) plus abort tail and a synthetic 400-update long turn
  - Deterministic fake omp (env-selected chunking, steer queue, lifecycle log, stdin-close exit 0)
  - LineFramer (UTF-8 aware, newline-only) and loose Zod frame schemas with v1 command builders
affects: [01-05, 01-06]
tech-stack:
  added: []
  patterns: [recorded-frame replay, chunking equivalence tests, loose Zod schemas with unknown fallthrough]
key-files:
  created:
    - scripts/record-omp.mjs
    - scripts/scrub-recording.mjs
    - fixtures/fake-omp/fake-omp.mjs
    - fixtures/fake-omp/README.md
    - fixtures/fake-omp/recordings/turn.jsonl
    - fixtures/fake-omp/recordings/abort-tail.jsonl
    - fixtures/fake-omp/recordings/long-turn.jsonl
    - packages/chat-core/src/line-framer.ts
    - packages/chat-core/src/line-framer.test.ts
    - packages/chat-core/src/frames.ts
    - packages/chat-core/src/frames.test.ts
    - packages/chat-core/src/fake-omp.contract.test.ts
  modified:
    - eslint.config.mjs
key-decisions:
  - "Recording is REAL (omp 18.8.5, haiku, throwaway temp cwd and session dir), not research-derived"
  - "Stay on protocol v1; no negotiate command exists in frames.ts"
  - "Steer is delivered after the current replay's session_settled, as queue_update then user echo then a short reply"
requirements-completed: [CHAT-03]
duration: 25 min
completed: 2026-10-15
---

# Phase 1 Plan 04: Fake omp, recordings, LineFramer Summary

**A scrubbed real omp 18.8.5 turn drives a deterministic fake omp, and a newline-only StringDecoder LineFramer proves identical frames under 1-byte, glued, mid-emoji, 900 KB and bad-line delivery.**

## Accomplishments
- Real recording captured on a throwaway session (113 raw frames, omp exited 0 after stdin close); `~/.omp/agent/sessions/-Eva` count unchanged (198 before and after). `turn.jsonl` has 51 frames with a code fence and the rocket emoji; `abort-tail.jsonl` has 7; `long-turn.jsonl` is synthesised (about 400 message_update frames).
- Observed handshake: `ready` (protocol 1, supported [1,2], maxFrameBytes 1048576) about 235 ms after spawn, then setWidget, advisor_cost_changed, available_commands_update, then responses; documented in `fixtures/fake-omp/README.md`.
- fake-omp contract test (6 tests) and framer/frames tests; chat-core Vitest project 32 tests passing. `pnpm gate` exits 0 (GATE GREEN, 4 Playwright specs).

## Task Commits
1. Task 1 (record + fake omp): `320fd31`, lint fix follow-up
2. Task 2 RED: failing tests commit; GREEN: `feat(01-04): LineFramer and Zod frame schemas...`; trailing prettier fix commit

## Deviations from Plan

**1. [Rule 3 - Blocking] ESLint globals for .mjs scripts**
- `eslint.config.mjs` got a `scripts/**/*.mjs` globals block so the new record/scrub scripts lint. Also added `scripts/scrub-recording.mjs` (not in plan) to make scrubbing and long-turn generation reproducible.

**2. [Rule 1 - Bug] Lint/prettier fixes after first commit** - `no-explicit-any` in the contract test, a "readline" word in a framer comment tripping the acceptance grep. Fixed in follow-up commits.

**3. Dev note** - macOS `sed -i` needs a suffix arg; used perl instead. `gsd-sdk` state helpers used as available.

**Total deviations:** 3 minor. **Impact:** none on scope.

## Known Stubs
None. `long-turn.jsonl` is intentionally synthetic (repeated text), for the 01-06 frame-time benchmark.

## Threat Flags
None. Recordings grep clean of `/Users/`, `ike`, `iweber`.

## Next Phase Readiness
Ready for 01-05 (live slice against fake omp via `EVAOS_OMP_BIN`).

## Self-Check: PASSED
