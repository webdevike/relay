---
phase: 04-chat-parity
plan: 04
subsystem: infra
tags: [env, e2e, fakes, claude-bridge]
requires: []
provides:
  - Env.agentDir, Env.claudeBridgeBin, Env.claudeBin
  - fixtures/fake-claude-bridge/fake-bridge.mjs
  - paths.ts FAKE_CLAUDE_BRIDGE, AGENT_P4_TEMPLATE
affects: [04-06, 04-07, 04-08, 04-10, 04-14]
key-files:
  created: [fixtures/fake-claude-bridge/fake-bridge.mjs, fixtures/fake-claude-bridge/README.md]
  modified:
    - apps/desktop/src/main/env.ts
    - apps/desktop/src/main/env.test.ts
    - apps/desktop/e2e/fixtures.ts
    - apps/desktop/e2e/helpers/paths.ts
    - apps/desktop/e2e/helpers/fakes.test.ts
duration: 10min
completed: 2026-10-15
---

# Phase 4 Plan 04: Env seams and fake Claude bridge Summary

Env now exposes `agentDir`, `claudeBridgeBin` and `claudeBin` (fixtures and fakes outside live mode, real omp agent dir and bridge when live), and every e2e launch points the Claude harness at a fake bridge that delegates to fake-omp.

## Commits
- feat(04-04): env seams for agent dir and Claude bridge
- feat(04-04): fake Claude bridge and e2e launch defaults

## Deviations from Plan

**[Rule 3 - Blocking] Bridge `--no-relay` maps to rpc-ui, not rpc.** fake-omp exits 2 for any mode other than `rpc-ui`, so mapping to `--mode rpc` would be unusable. Both bridge shapes delegate to rpc-ui; documented in the fake's README. Plan 04-06/08 can extend fake-omp if a distinct rpc mode is needed.

`fixtures/agent-p4` (AGENT_P4_TEMPLATE) is only a path constant; the directory is created by a later plan.

## Verification
env.test.ts and fakes.test.ts pass (24 tests), `pnpm -r typecheck` and eslint clean.

## Self-Check: PASSED
