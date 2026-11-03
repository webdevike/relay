---
phase: 04-chat-parity
fixed_at: 2026-10-15T16:25:00Z
review_path: .planning/phases/04-chat-parity/04-REVIEW.md
iteration: 1
findings_in_scope: 9
fixed: 9
skipped: 0
status: all_fixed
---

# Phase 4: Code Review Fix Report

**Fixed at:** 2026-10-15
**Source review:** .planning/phases/04-chat-parity/04-REVIEW.md
**Iteration:** 1

**Summary:**

- Findings in scope: 9 (no Critical; WR-01 to WR-09). Info findings IN-01 to IN-04 were out of scope.
- Fixed: 9
- Skipped: 0

Fixes were committed directly on `main` (one commit per finding) rather than in a separate worktree, as the run instructions specified.

Gate after all fixes: `pnpm -r typecheck` clean, `eslint .` clean, `prettier --check .` clean, em-dash lint clean (313 files), `vitest run` 137 files / 1064 tests passing, desktop build succeeds, and the chat e2e specs (chat-control, chat-list, chat-ops, chat-transcript, new-chat, settings-chat) 26/26 passing with `EVAOS_E2E=1`.

## Fixed Issues

### WR-01: Session path guard accepts any file or folder inside the sessions dir

**Files modified:** `apps/desktop/src/main/chat/transcript-ipc.ts`, `apps/desktop/src/main/chat/chat-list-ipc.test.ts`
**Commit:** c4078d7
**Applied fix:** `resolveInsideSessionsDir` now requires a direct child that is a regular `.jsonl` file, and a missing sessions dir yields a coded error. Test added for nested files, non-jsonl files and folders.
**Status:** fixed: requires human verification (security guard logic)

### WR-02: Reducer notice ids can collide

**Files modified:** `packages/chat-core/src/reducer.ts`, `packages/chat-core/src/reducer.test.ts`
**Commit:** 53eff9f
**Applied fix:** Monotonic `noticeSeq` counter, with an `indexOf` check so an id is never reused. Regression test added.
**Status:** fixed

### WR-03: Question and extension cards lock permanently after a failed or stale answer

**Files modified:** `apps/desktop/src/renderer/chat/cards/QuestionCard.tsx`, `ExtensionUiCard.tsx`, `PendingDialog.tsx`, `cards.test.tsx`
**Commit:** 2cecdb9
**Applied fix:** `onAnswer` may return `Promise<boolean>`; cards reset `sent` on `false`. `PendingDialog.answer` returns false for `!ok` and for `sent:false` (with a visible message), and `failed` is cleared when the dialog id changes. Retry test added.
**Status:** fixed: requires human verification (UI state logic)

### WR-04: Launch state prefers stale session meta over the user's choice

**Files modified:** `apps/desktop/src/main/chat/session-manager.ts`, `session-manager.test.ts`
**Commit:** d3457f1
**Applied fix:** With no transport, `launchState` prefers `pane.launch` model and thinking over history meta; with a live process omp-confirmed meta still wins. Test added.
**Status:** fixed: requires human verification (logic)

### WR-05: Launch patch strings are passed to argv without validation

**Files modified:** `packages/contract/src/chat.ts`, `packages/contract/src/contract.test.ts`
**Commit:** 4a10cf8
**Applied fix:** Validation lives in the contract `LaunchPatchSchema` (`^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$`, no leading `-`) for provider, modelId and thinking, instead of a catalog lookup in `setLaunch`. The catalog may be empty or stale, which would block valid launches, and the schema guards every caller. Test added.
**Status:** fixed

### WR-06: Contract schemas stricter than shared `chat.json`

**Files modified:** `apps/desktop/src/main/chat/chat-list.ts`, `chat-list-ipc.ts`, `chat-list.test.ts`
**Commit:** f158e2b
**Applied fix:** `prefs()` drops assignments whose id or name fail the schema predicates (exported `SESSION_ID_RE`); `saveArchived` and `savePin` filter only their returned arrays, leaving persisted data intact. Invalid legacy assignments are dropped from `chat.json` on the next category save, since they could never match a real session id.
**Status:** fixed

### WR-07: `openChatFile` early return can leave a stale chat on screen

**Files modified:** `apps/desktop/src/renderer/chat/open-chat.ts`, `open-chat.test.ts` (new)
**Commit:** ce64ef0
**Applied fix:** Clicking the shown chat while a different open is in flight now re-opens it (bumping `latest`), so main and the pane agree. A failed `chat.open` shows a red notification.
**Status:** fixed: requires human verification (race logic)

### WR-08: Blob image cache stores failures and grows unbounded

**Files modified:** `apps/desktop/src/renderer/chat/ChatImage.tsx`, `ChatImage.test.ts` (new)
**Commit:** cae52f7
**Applied fix:** Failures are evicted from the cache, LRU cap of 24 entries, and `useImageSrc` resets `blob` at the start of its effect.
**Status:** fixed

### WR-09: Composer attach computes capacity before an await

**Files modified:** `apps/desktop/src/renderer/chat/Composer.tsx`, `composer/image-input.ts`, `composer/image-input.test.ts`
**Commit:** cac9eed
**Applied fix:** `readImageFiles(files, limit)` encodes at most `limit` files and reports `truncated`; `Composer.attach` passes the current room and recomputes room after the await.
**Status:** fixed

## Skipped Issues

None.

---

_Fixed: 2026-10-15_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 1_
