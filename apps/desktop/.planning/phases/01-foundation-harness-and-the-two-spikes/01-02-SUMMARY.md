---
phase: 01-foundation-harness-and-the-two-spikes
plan: 02
subsystem: infra
tags: [eva-fs, write-trap, proof-harness, pngjs, playwright, sentinel]
requires: [01-01]
provides:
  - EvaFs closed-allowlist write gateway (todo-append, file-save, job-md, job-delete, meeting-status), zero callers
  - Runtime node:fs write trap installed by installWriteGuard (EVAOS_WRITE_TRAP)
  - Static write-scan test, synthetic fixture Eva root
  - proofShot composite capture with blank rejection, recordMetrics, advisory git sentinel in the gate
affects: [01-03, 01-07, 01-08, 01-09, 01-10]
tech-stack:
  added: []
  patterns: [AsyncLocalStorage-marked EvaFs writes, composite shell plus capturePage proof shots]
key-files:
  created:
    - packages/eva-core/src/fs/allowlist.ts
    - packages/eva-core/src/fs/eva-fs.ts
    - packages/eva-core/src/fs/atomic-write.ts
    - packages/eva-core/src/fs/write-trap.ts
    - packages/eva-core/src/write-scan.test.ts
    - apps/desktop/e2e/helpers/proofShot.ts
    - apps/desktop/e2e/helpers/image.ts
    - apps/desktop/e2e/helpers/metrics.ts
    - apps/desktop/e2e/proof-harness.spec.ts
    - scripts/sentinel.ts
    - fixtures/eva-root/
  modified:
    - apps/desktop/src/main/eva/write-guard.ts
    - apps/desktop/src/main/test-hooks.ts
    - scripts/gate.sh
key-decisions:
  - "D-25 sentinel is advisory (decision 3); the runtime write trap is the authoritative check. EVAOS_SENTINEL_STRICT=1 makes it fail."
  - "Allow roots (repo, config dir, tmp) win over protected roots, because the repo sits inside ~/Eva."
requirements-completed: [FOUND-03, FOUND-04, FOUND-06]
duration: 20min
completed: 2026-10-15
---

# Phase 1 Plan 02: Write safety and proof harness Summary

**EvaFs closed-allowlist gateway plus a runtime node:fs write trap and static scan protect the Eva checkout, and `proofShot` composites the shell with native WebContentsViews and rejects blank captures; the gate now runs an advisory git sentinel.**

## Accomplishments
- EvaFs with realpath containment (absolute, `..`, symlink escape rejected), atomic temp-then-rename writes, `EvaFsDenied` with kind/path/reason; no callers.
- Write trap patches fs and fs.promises write APIs (sync, callback, promise, open with write flags, createWriteStream); unmarked writes under protected roots throw `EVAOS_WRITE_TRAP`; hits are exposed as `__evaosTest.hooks.writeTrapHits`.
- Static scan test (self-tested) finds zero offenders; only `config-store.ts` is excepted.
- proofShot verified against a real gradient WebContentsView (composite viewed: view pixels present); a white view raises `BlankImageError`.
- 19 eva-core tests, 6 helper tests, 2 e2e specs; `pnpm gate` prints GATE GREEN.

## Task Commits
1. Task 1: EvaFs, write trap, scan, fixtures - `1e7f3db`
2. Task 2: proofShot, image/metrics helpers, sentinel, gate - `49fb7d2`

## Deviations from Plan

**1. [Rule 1 - Bug] data: URLs in the spec used a raw `#`**
- A `#` starts a URL fragment, so the gradient and white colours were dropped and the view captured as blank. Encoded as `%23`.

**2. [Rule 3 - Blocking] eva-core lacked Node types**
- Added `@types/node` devDependency and `types: ["node"]` to its tsconfig; lockfile updated.

**3. [Rule 2 - Missing] Test hook registration order**
- `installWriteGuard` runs before `installTestHooks`, so `registerTestHook` now buffers pending hooks and attaches them later.

**4. proofShot retries captures for up to 1.5 s**
- Fresh views can capture blank before first paint; a still-uniform view then fails with `BlankImageError`.

**5. Plan verify command `vitest --project main` unavailable**
- Nested app projects cannot be filtered by name from the root; ran by path (`vitest run apps/desktop/e2e/helpers`) and the full suite in the gate.

**6. Added `metrics.test.ts`** covering the recordMetrics behaviour bullet.

## Known Stubs
EvaFs has no callers by design (first caller: Phase 3 todos append).

## Self-Check: PASSED
