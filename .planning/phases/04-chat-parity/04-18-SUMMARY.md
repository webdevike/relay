---
phase: 04-chat-parity
plan: 18
subsystem: chat
tags: [composer, toolbar, model-picker, access-mode, context-ring, session-manager, electron, react]
requires:
  - phase: 04-02
    provides: launch.ts (ompArgs, claudeArgs, parseModels, foldModels, contextPercent, APPROVAL_LABEL)
  - phase: 04-05
    provides: chat.models, chat.launchState, chat.setLaunch contract and MetaPatch contextWindow/thinking
  - phase: 04-10
    provides: SessionManager launchArgs, draft panes, transport factory
  - phase: 04-17
    provides: shared writer guard in SessionManager.send
provides:
  - ModelCatalog (one throwaway omp --mode rpc --no-session, cached on success, retried after failure)
  - SessionManager.launchState and setLaunch (live set_model, set_thinking_level, set_fast_mode; idle access restart through release and acquire; unsent-only account; stored choices become launch flags)
  - reducer emits contextWindow and thinking meta patches (get_state contextUsage.contextWindow and assistant usage.contextWindow; 0 means unknown)
  - composer toolbar: Attach, model picker with thinking levels, access picker, account picker (unsent omp chats), context ring, Stop and Send
affects: [04-chat-parity]
tech-stack:
  added: []
  patterns:
    - "Toolbar state lives in useLaunchState: main is the source of truth, the hook reloads on model, thinking, file and stopped changes"
    - "Per-pane PaneLaunch in SessionManager; startArgs() builds the full Launch only when something was chosen, else keeps the old defaults path"
key-files:
  created:
    - apps/desktop/src/main/chat/models.ts
    - apps/desktop/src/main/chat/models.test.ts
    - apps/desktop/src/renderer/chat/composer/Toolbar.tsx
    - apps/desktop/src/renderer/chat/composer/ModelPicker.tsx
    - apps/desktop/src/renderer/chat/composer/AccessPicker.tsx
    - apps/desktop/src/renderer/chat/composer/AccountPicker.tsx
    - apps/desktop/src/renderer/chat/composer/ContextRing.tsx
    - apps/desktop/src/renderer/chat/composer/useLaunchState.ts
    - apps/desktop/src/renderer/chat/composer/toolbar.test.tsx
    - proof/phase-4/composer-toolbar.png
    - proof/phase-4/composer-model-picker.png
    - proof/phase-4/composer-account.png
  modified:
    - apps/desktop/e2e/composer.spec.ts
    - apps/desktop/src/main/chat/session-manager.ts
    - apps/desktop/src/main/chat/session-manager.test.ts
    - apps/desktop/src/main/chat/live-ipc.ts
    - packages/chat-core/src/reducer.ts
    - packages/chat-core/src/reducer.test.ts
    - apps/desktop/src/renderer/chat/Composer.tsx
    - apps/desktop/src/renderer/chat/Composer.test.tsx
    - apps/desktop/src/renderer/chat/chat-store.ts
    - apps/desktop/src/renderer/chat/composer/composer.css
    - fixtures/fake-omp/fake-omp.mjs
    - fixtures/fake-omp/README.md
key-decisions:
  - "Toolbar controls are disabled when the pane is closed (stopped), while a change is in flight, or with no pane, per UI-SPEC; a new chat is never stopped so its choices stay open"
  - "launchState is synchronous in SessionManager; imagesAllowed reads the catalog cache (models()) and the IPC handler warms it first; unknown model means images allowed"
  - "Explicit approval, model or profile choices make startArgs build the whole Launch (omp order); with none chosen a resumed chat gets no flags and a new chat the configured defaults, as before"
  - "No Rust GPT-provider restriction on the account selector was found in chat.rs, so it shows for every unsent omp chat"
patterns-established:
  - "e2e spawn counts filter on rpc-ui: the catalog process also logs a spawn in the fake log"
requirements-completed: [CHTP-06]
duration: 55min
completed: 2026-10-15
---

# Phase 4 Plan 18: Composer Toolbar Summary

**Composer toolbar with model picker, access mode, new-chat account selector and a context ring, backed by a cached omp model catalog and per-pane launch state that switches live or becomes launch flags.**

## Performance

- **Duration:** ~55 min
- **Tasks:** 3
- **Files modified:** 28

## Accomplishments
- `ModelCatalog` spawns one `omp --mode rpc --no-session`, folds and caches the catalog; chat.models, chat.launchState and chat.setLaunch are registered.
- `setLaunch` writes `set_model`, `set_thinking_level`, `set_fast_mode` on a live pane; an access change on an idle live pane closes stdin, waits for exit and restarts with `--resume` and the new `--approval-mode` (never signals); a working pane gets `busy`; the account is only accepted before the first prompt of a new omp chat and becomes `--profile`.
- Reducer now emits `contextWindow` and `thinking`; the ring reads `Context 21% used` for 42000 of 200000, tokens when the window is unknown, `Unavailable` with no reading, warning at 80 and danger at 95.
- Models without image support disable Attach (and paste or drop shows `This model does not accept images.`).

## Task Commits

1. **Task 1: Failing e2e for the composer toolbar** - `5b4073c` (test)
2. **Task 2: Model catalog, launch state, live switches, context window** - `b7a9f63` (feat)
3. **Task 3: Toolbar pickers, account selector and context ring** - `913d87c` (feat)

## Verification
- Vitest: whole repo 135 files, 1053 tests pass (chat-core, main chat, renderer chat, overlay-lint included).
- Typecheck clean, em-dash lint clean, `pnpm -C apps/desktop build` succeeds.
- E2E green: composer (3), composer-images, new-chat, writers, chat-stream, chat-control, chat-ops, subagents-jobs, questions, settings-chat, chat-list, chat-watch, categories, chat-list-search, eva-watch, workspace, quit-guard.
- Proof: `proof/phase-4/composer-toolbar.png`, `composer-model-picker.png`, `composer-account.png`.
- ESLint on `apps/desktop/src` is clean. `eslint packages/chat-core/src` reports 4 pre-existing `no-explicit-any` errors in `fake-omp.contract.test.ts` (not touched here).

## Decisions Made
See key-decisions above.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Fake omp did not log the model it was asked to switch to**
- **Found during:** Task 3 (e2e step 1)
- **Issue:** `stdin-line` logs only `{type, id}`, so "set_model with provider and modelId" could not be asserted.
- **Fix:** fake logs a `set-model` event with `{provider, modelId}`; README updated.
- **Files modified:** fixtures/fake-omp/fake-omp.mjs, fixtures/fake-omp/README.md
- **Commit:** 913d87c

**2. [Rule 1 - Bug] Existing e2e counted the catalog process as a chat spawn**
- **Found during:** Task 3
- **Issue:** the catalog helper logs a fake `spawn`, breaking `writers.spec.ts` (no spawn expected) and `chat-control.spec.ts` (restart count).
- **Fix:** those counts filter on `rpc-ui`; chat-ops' rename check also requires `--resume`.
- **Commit:** 913d87c

**3. [Rule 1 - Bug] Stale expectation from 04-17 in chat-control.spec.ts**
- **Issue:** "a second pane on the same file is refused" still expected `already-owned`, but since 04-17 an unconfirmed send returns `owned-elsewhere`.
- **Fix:** updated to the 04-17 code and message; the no-second-process guarantee stays covered by writers.spec.ts.
- **Commit:** 913d87c

**4. [Rule 1 - Bug] Composer unit tests scripted every invoke call**
- **Issue:** the toolbar's new launchState and models reads consumed `mockImplementationOnce` results and tripped `not.toHaveBeenCalled`.
- **Fix:** mock is channel-aware (only chat.send scripted); assertions use a `sent()` helper.

**5. [Spec interpretation] The "no open session" e2e**
- The app always has a draft pane on the chat page, so the disabled state is exercised by closing a live session (`chat.close`) instead; the no-pane case is covered in `toolbar.test.tsx`.

Not touched: the flaky `chat-transcript.spec.ts` 5,000-message test (this plan does not touch ChatLog scrolling).

## Known Stubs
None.

## Threat Flags
None. T-04-57 (contract enums and length caps, model ids as argv elements, no shell), T-04-58 (restart only when idle through release then acquire) and T-04-59 (catalog timeout closes stdin, never signals) are implemented as planned.

## Self-Check: PASSED
