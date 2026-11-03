---
phase: 04-chat-parity
plan: 03
subsystem: testing
tags: [fake-omp, fixtures, playwright, vitest]
requires: []
provides:
  - fake omp covering new chat, rpc-mode rename and model catalog, dialogs, launch switches, images, context window
  - fixtures/agent-p4 disposable agent dir (18 sessions, blobs, pins, mtime manifest)
  - makeChatFixture and writeChatPrefs e2e helpers
affects: [04-06 and later chat e2e specs]
tech-stack:
  added: []
  patterns: [tmp-copy fixtures with manifest mtimes, prompt-keyword scenarios in the fake]
key-files:
  created:
    - fixtures/agent-p4/README.md
    - fixtures/agent-p4/mtimes.json
    - fixtures/agent-p4/session-pins.json
    - fixtures/agent-p4/blobs/
    - fixtures/agent-p4/sessions/-fixture/
    - apps/desktop/e2e/helpers/chat-fixture.ts
    - apps/desktop/e2e/helpers/chat-fixture.test.ts
  modified:
    - fixtures/fake-omp/fake-omp.mjs
    - fixtures/fake-omp/README.md
    - packages/chat-core/src/fake-omp.contract.test.ts
key-decisions:
  - "The fake writes the --resume file only in --mode rpc (rename); rpc-ui stays read-only"
  - "Fixture blob named <sha256>.png, matching the real blob store which has both bare and extensioned names"
  - "mtimes.json manifest (minutes ago, keys are ids or id/subagent) drives deterministic ordering"
requirements-completed: [CHTP-04, CHTP-06, CHTP-08, CHTP-13, CHTP-14]
duration: 25min
completed: 2026-10-15
---

# Phase 4 Plan 03: Chat test seams Summary

Deterministic fake omp for every Phase 4 path plus a disposable `agent-p4` fixture dir and tmp-copy helper.

## Accomplishments
- fake-omp: `--mode rpc` (set_session_name rewrites the title record, get_available_models returns 4 models), `FAKE_OMP_SESSIONS_DIR` new-chat planned file created on first prompt, set_model / set_thinking_level / set_fast_mode / set_session_name, `contextUsage {tokens, contextWindow}`, prompt images, keyword dialogs (select, confirm, input, editor, ask, ask-multi, ask-bad) with ui-response logging, `[slow]`, and clean exit when stdin closes during a dialog.
- Contract suite: 23 cases pass (6 pre-existing, 17 new).
- agent-p4: 18 session files covering groups, pin, archive, background jobs (running and ended), subagents (done and running), images (inline base64 and blob ref), rename, writer.
- chat-fixture helper: 3 tests pass, including proof the repo fixture tree is byte-identical after use.

## Task Commits
1. Tasks 1 and 2 (fake omp, built together since dialogs share the new handler): 6380091
2. Task 3 (fixtures and helper): 445450f

## Deviations from Plan
- Tasks 1 and 2 were implemented and committed together (one commit) because both rewrite the same `handle` function. Both sets of acceptance checks pass.
- Added `fixtures/agent-p4/mtimes.json` (the manifest the plan mentions but did not list as a file).
- `AGENT_P4_TEMPLATE` in `paths.ts` was added by a parallel executor first; I did not duplicate it.

## Known Stubs
None.

## Threat Flags
None. Fixture blobs are generated 8x8 PNGs; blob naming was confirmed with a read-only `ls` of the real store.

## Self-Check: PASSED
