---
phase: 01-foundation-harness-and-the-two-spikes
fixed_at: 2026-10-15T07:05:00Z
review_path: .planning/phases/01-foundation-harness-and-the-two-spikes/01-REVIEW.md
iteration: 3
fix_scope: critical_warning
findings_in_scope: 1
fixed: 1
skipped: 0
status: all_fixed
extra_fixed: 3
gate: GATE GREEN (install check, typecheck, eslint, prettier, em-dash lint, Vitest 34 files / 189 tests, electron-vite build, Playwright 28 passed plus 3 live-only skipped, packaged smoke 1 passed)
---

# Phase 1: Code Review Fix Report (iteration 3, final)

**Fixed at:** 2026-10-15T07:05:00Z
**Source review:** `.planning/phases/01-foundation-harness-and-the-two-spikes/01-REVIEW.md` (iteration 3)
**Iteration:** 3
**Scope:** Warning (WR-01; the review has no Critical findings). The three Info items new in iteration 3 (IN-17, IN-18, IN-19) were fixed as well because each was a few lines in files already open or already covered by tests; the fourteen Info items carried forward from earlier iterations remain out of scope.

**Summary:**
- Findings in scope: 1
- Fixed: 1
- Skipped: 0
- Extra (Info, new in iteration 3): 3 fixed

Each fix was read against the current source and its tests first, verified (re-read, `tsc --noEmit` on both desktop tsconfigs, eslint, prettier, the relevant Vitest files; for IN-19 a fresh build plus the two browser e2e specs that exercise the blocked-URL path) and committed on its own. Work was done directly on `main` as the orchestrator's environment block required (sequential work on the main tree, no branches or worktree, nothing pushed). After the last commit the full `corepack pnpm gate` was run; see Verification.

## Fixed Issues

### WR-01: Two panes waiting on the same closing process both pass `acquire()` and spawn omp on one session file

**Files modified:** `apps/desktop/src/main/chat/session-manager.ts`, `apps/desktop/src/main/chat/session-manager.test.ts`
**Commit:** ab3f7f3
**Outcome:** fixed
**Applied fix:** `acquire()` now performs the claim itself: when the file is free it calls `createTransport()` and sets `owners[key] = { pane, transport, closing: null }` in the same synchronous step as the free check, and returns the transport to `startTransport()`. There is no await between the check and the set, so when one `close()` releases two waiters the first continuation claims and the second sees a live owner and is refused with `already-owned`. The claim was placed inside `acquire()` (rather than creating the transport before calling it, as the review sketched) so that no transport object is created while a pane is still waiting, which keeps the existing grace-window tests' `transports.toHaveLength(1)` assertions meaningful. `acquire()` also checks that the pane is still the one registered under its paneId before claiming, so a pane replaced by `open()` while it waited rejects with `session-closed` and never takes the file away from the live pane; the post-acquire registration check in `startTransport()` moved into that synchronous step. `disown()`, the failed-spawn path, `release()` and the `_eof` path are unchanged.
**Tests:** "two panes waiting on one closing process: exactly one spawns, the other is refused": pane-1 and pane-2 open the same file, pane-1 is live, `close('pane-1')` is held open, both panes send during the grace window, the close resolves; asserts exactly two transports ever created (the original and one new), the new one started on the file once and received only pane-1's prompt, pane-2's send rejected with `already-owned` / `ALREADY_OWNED`, `transportOf('pane-2')` is null and the file is still owned. The test was run against the pre-fix code and failed there (the second send resolved, meaning both panes spawned). All 20 session-manager tests pass.

## Adjacent Info items fixed

### IN-17: `acquire()` reports `ALREADY_OWNED` ("another window or pane") for the user's own pane after `open()` replaced the pane object

**Files modified:** `apps/desktop/src/main/chat/session-manager.ts`, `apps/desktop/src/main/chat/session-manager.test.ts`
**Commit:** 8b57b34
**Applied fix:** The refusal compares `owner.pane.paneId === pane.paneId` instead of pane objects, so a timed-out close followed by a re-open of the same file in the same pane is told `STILL_CLOSING`. Test: "re-opening the same file in the same pane after a timed-out close reports still closing, not another pane".

### IN-18: Typing clears the renderer error banner, but the reducer keeps it, so a later resync brings the banner back

**Files modified:** `apps/desktop/src/renderer/chat/chat-store.ts`, `apps/desktop/src/renderer/chat/Composer.tsx`, `apps/desktop/src/renderer/chat/stream-drain.test.ts`
**Commit:** 4223216
**Applied fix:** The review's second option (a dismissal flag the snapshot preserves), since not clearing on edit would have reversed the iteration-2 behaviour the orchestrator asked for. `PaneState` gains `dismissedError`; a new `dismissError(paneId)` action hides the banner and records its text; `applySnapshot` keeps `error` null when the snapshot carries exactly that text (and keeps the flag), otherwise shows the snapshot's error and resets the flag; a meta patch from a batch that sets `error` always applies and resets the flag (main speaking now); `setError` (a send result) resets the flag. `Composer.edit()` calls `dismissError` instead of `setError(null)`. Test: "a resync does not bring back the error banner the user dismissed by typing" (dismiss, gap resync with the same EOF text stays hidden with `stopped` true, a later batch error shows again and clears the flag). The existing Composer tests, including "editing the composer clears the pane error", pass unchanged.

### IN-19: A refused URL is written into `TabState.url` before the allow-list check

**Files modified:** `apps/desktop/src/main/browser/browser-host.ts`
**Commit:** 8a74764
**Applied fix:** `navigate()` writes `url`, `blank` and `error = null` only after `loadableUrl()` passes; the refused path sets `loading = false` and `error = { host: hostOf(url), code: BLOCKED_URL_CODE }` and returns, so the address bar, `copyLink`, the tab label and the history flags keep describing the page the view still shows. A blank tab whose first navigation is refused stays `blank: true` with the error set, and `BrowserPanel` shows the card for either flag. `BrowserHost` needs Electron, so no unit test; verified with a fresh build and the `browser-basic` (address-bar `file:` and `chrome:` blocked loop) and `browser-cdp` (`PageControl.navigate` to `file:///etc/hosts` then back) specs, both passing.

## Skipped Issues

None.

## Info items carried forward (not in scope)

IN-01 through IN-13 and IN-16 are unchanged, as in iteration 2: em-dash lint scope, dev-only IPC output validation, address input reset while focused, duplicate `CodedError`, dead `counted` set, unused exports, batcher `at` timing, guest favicons in the shell renderer, preload surface comment, scrubber `toolCallId`, gate tooling paths, `tabId` declaration order, tab-limit notice spam, and the login-shell PATH probe.

## Verification

- Per fix: re-read of the edited regions, `tsc --noEmit` on `tsconfig.node.json` and `tsconfig.web.json`, eslint and prettier on the touched files, the relevant Vitest files (session-manager 20 tests, stream-drain and Composer 16 tests). IN-19 additionally ran `electron-vite build` and the `browser-basic` and `browser-cdp` e2e specs.
- Vitest went from 34 files / 186 tests to 34 files / 189 tests (three new cases: two in session-manager, one in stream-drain).
- Final: `corepack pnpm gate` on HEAD 8a74764 exited 0 (`GATE GREEN`): install check (lockfile up to date), typecheck, eslint, prettier, em-dash lint, Vitest 34 files / 189 tests, electron-vite build, Playwright 28 passed / 3 skipped (the live-only specs, unchanged), packaged dir build smoke 1 passed.

## Iteration 2 (summary)

Five Warnings from the iteration-2 review were fixed in commits 4fe5bea through 3ace61c, plus two adjacent Info items, and verified as resolved by the iteration-3 review:

| Id | Fix | Commit |
|----|-----|--------|
| WR-01 | `startTransport()` checks `stillMine()` after `transport.start()` and after the handshake writes; `send()` re-reads `pane.transport` and rejects with `session-closed`; `OmpStdioTransport.close()` awaits an in-flight `start()` | 4fe5bea |
| WR-02 | Ownership is `Owner { pane, transport, closing }` keyed by realpath; `release()` keeps the file through the close and, after a timeout, until `_eof`; `acquire()` waits on `closing` and refuses with `already-owned` / `STILL_CLOSING` | b808083 |
| WR-03 | Composer disabled only when there is no pane; a send error is a banner; a successful send or an edit clears it; `LiveReducer.sendPrompt()` clears the EOF error and the manager diffs it into `markMeta({ error: null })` | 38345aa |
| WR-04 | `Snapshot` carries `connected` and `error`; contract, `applySnapshot` and the drain agree | d37848b |
| WR-05 | `PageControl.navigate()` goes through `BrowserHost.navigate()` and its allow-list; `loadURL` has one call site | 3ace61c |
| IN-15 | A stale label-clear timer no longer clears a later resync nor fires after `dispose()` | 3884027 |
| IN-14 | Extension tabs keep `fromExtension` on retry and in-page navigation | 35c289f |

The iteration-2 gate was green on 35c289f (Vitest 186 tests, 28 Playwright specs plus 3 live-only skipped, packaged smoke).

## Iteration 1 (summary)

Nine Critical and Warning findings from the iteration-1 review were fixed in commits a2868b7 through 7a7bfa3 and verified as resolved by the iteration-2 review:

| Id | Fix | Commit |
|----|-----|--------|
| CR-01 | Stream drain no longer loops on a held batch ahead of the snapshot; a pane replaced by `open()` stays inert | a2868b7 |
| WR-01 | `_eof` emitted once (from `close` only) and applied once; `detach()` shared by the `_eof` and release paths | 526013c |
| WR-02 | Concurrent sends during spawn share one `starting` promise; failed spawns reject every waiter with `spawn-failed` | fba9dbb |
| WR-03 | A null or rejected snapshot clears `reconnecting`, the stash and the label | 08f4249 |
| WR-04 | `isAppUrl` sender check is exact at a separator (`app-url.ts`, unit tested) | 7fdc4d5 |
| WR-05 | `BrowserHost.navigate()` is the single `loadURL` site with the `loadableUrl` allow-list; extension tabs pass `fromExtension` | 223a4ff |
| WR-06 | `did-navigate` counts the visit without the previous page's title | ecb227b |
| WR-07 | Tabs capped at 32 with a `browser.notice`; only the active tab may open tabs | 77d3de0 |
| WR-08 | A failed send restores the prompt text and removes the pending row | 7a7bfa3 |

The iteration-1 gate was green (170 tests, 28 Playwright specs plus 3 live-only skipped, packaged smoke).

---

_Fixed: 2026-10-15T07:05:00Z_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 3_
