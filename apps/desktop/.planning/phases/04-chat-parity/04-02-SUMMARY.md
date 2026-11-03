---
phase: 04-chat-parity
plan: 02
subsystem: chat-core
tags: [dialogs, jobs, subagents, launch, models, image-size]
requires: []
provides: [parseDialog, dialogResponse, backgroundJobs, subagentsFromListing, claudeSubagentDone, ompArgs, claudeArgs, renameArgs, parseModels, foldModels, contextPercent, readApproval, imageSize]
affects: [04-07, 04-08, 04-09, 04-10, 04-13, 04-15, 04-18]
tech-stack:
  added: []
  patterns: [pure functions over text, plain TS types (no zod) to run parallel with 04-05]
key-files:
  created:
    - packages/chat-core/src/dialogs.ts
    - packages/chat-core/src/jobs.ts
    - packages/chat-core/src/launch.ts
    - packages/chat-core/src/image-size.ts
  modified: []
decisions:
  - "claudeArgs emits the same omp flags minus --profile; the bridge maps alias, effort (off to low) and permission mode itself (bridge README, session.ts)"
  - "readApproval uses Rust's line scan for approvalMode: (no YAML dependency in chat-core)"
  - "set_model frame fields confirmed for 04-18: { type: 'set_model', provider, modelId }"
metrics:
  tasks: 3
  tests: 35
  completed: 2026-10-15
---

# Phase 4 Plan 02: Session-side rules Summary

Pure, Vitest-covered chat-core modules porting Rust chat.rs: omp dialog parsing with exact `extension_ui_response` frames, background jobs and subagents from session files, omp/Claude launch argv with the model catalog fold and context ring math, and a dependency-free PNG/JPEG/GIF/WebP header reader.

## Commits
- dialogs: feat(04-02) dialog parse and frames
- jobs: feat(04-02) background jobs and subagents
- launch and image-size: feat(04-02) launch argv, catalog, context math, image reader

## Deviations from Plan
None. Notes: the Rust app has no editor `prefill` field; `prefill` is read when present, per plan. Rust folds confirm answers as `picked == "Yes"`; here the card passes `confirmed` directly.

## Verification
35 tests across 4 suites pass; `pnpm --filter @evaos/chat-core typecheck` and eslint on the new files are clean. Full `pnpm -r typecheck` was not run because other executors are editing other packages in parallel.

## Self-Check: PASSED
