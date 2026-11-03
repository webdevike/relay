---
phase: 03-dashboard-workspaces-jobs-habits-and-meetings
plan: 01
subsystem: eva-core fs
tags: [evafs, atomic-write, write-scan, tdd]
requires: []
provides:
  - EvaFs.readStamp, EvaFs.edit, EvaFs.create
  - createPathQueue
  - runner-parity job name regex
affects: [03-11, 03-13, 03-14, 03-18]
tech-stack:
  patterns: [per-path serial queue, stamp-and-recheck before atomic rename]
key-files:
  created: [packages/eva-core/src/fs/path-queue.ts]
  modified:
    - packages/eva-core/src/fs/eva-fs.ts
    - packages/eva-core/src/fs/eva-fs.test.ts
    - packages/eva-core/src/fs/allowlist.ts
    - packages/eva-core/src/write-scan.test.ts
    - packages/eva-core/src/index.ts
key-decisions:
  - "Errors use kebab codes (changed-on-disk, not-found, already-exists) via Object.assign so handle() maps them"
  - "retryOnChange retries once from fresh text and drops the expected basis"
metrics:
  tasks: 2
  files: 6
---

# Phase 3 Plan 01: EvaFs write foundation Summary

EvaFs now offers readStamp, edit (transform with stale refusal, sha256 plus mtime and size recheck before the atomic rename) and create (refuses an existing job folder), with every write on one path serialized by a per-path queue. Job names follow the runner regex `^[a-z0-9][a-z0-9-]*$`, and the static write scan covers renderer and preload.

## Commits
- test(03-01): failing tests for readStamp, edit, create, path queue (RED)
- feat(03-01): EvaFs readStamp, edit, create and per-path queue (GREEN)
- feat(03-01): runner-parity job name rule and extended write scan

## Deviations from Plan
None. A `retryOnChange` retry also clears `expected`, since the basis is stale by definition on a retry.

## Verification
`vitest run packages/eva-core` 38 tests green, `pnpm -r typecheck` clean, eslint clean on eva-core. TDD gate: test commit precedes feat commit.

## Known Stubs
None.

## Self-Check: PASSED
