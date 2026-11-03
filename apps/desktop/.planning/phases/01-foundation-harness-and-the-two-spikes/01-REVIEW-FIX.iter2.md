---
phase: 01-foundation-harness-and-the-two-spikes
fixed_at: 2026-10-15T06:13:03Z
review_path: .planning/phases/01-foundation-harness-and-the-two-spikes/01-REVIEW.md
iteration: 1
fix_scope: critical_warning
findings_in_scope: 9
fixed: 9
skipped: 0
status: all_fixed
gate: GATE GREEN (typecheck, eslint, prettier, em-dash lint, Vitest 170 tests, electron-vite build, 28 Playwright specs, packaged smoke)
---

# Phase 1: Code Review Fix Report

**Fixed at:** 2026-10-15T06:13:03Z
**Source review:** `.planning/phases/01-foundation-harness-and-the-two-spikes/01-REVIEW.md`
**Iteration:** 1
**Scope:** Critical + Warning (CR-01, WR-01 through WR-08). Info findings were out of scope and left as-is.

**Summary:**
- Findings in scope: 9
- Fixed: 9
- Skipped: 0

Each fix was read against the current source first, applied with the review's suggestion or a
variant that preserves the existing tests' intent, verified (re-read, `tsc --noEmit` on every
package, eslint, prettier, em-dash lint, the relevant Vitest files), and committed on its own.
After the last fix the full `corepack pnpm gate` was run and exited 0 (unit tests went from 154
to 170; 28 Playwright specs and the packaged smoke still pass). Work was done directly on `main`
as the orchestrator's environment block required (sequential work on the main tree, no branches).

## Fixed Issues

### CR-01: Stream drain loops forever when a held batch's seq is ahead of the snapshot

**Files modified:** `apps/desktop/src/renderer/chat/stream-drain.ts`, `apps/desktop/src/renderer/chat/stream-drain.test.ts`, `apps/desktop/src/main/chat/session-manager.ts`, `apps/desktop/src/main/chat/session-manager.test.ts`
**Commit:** a2868b7
**Applied fix:** Both halves of the review's fix. In the renderer, held batches replayed after a snapshot now follow a strict rule: `<= last` is skipped, `last + 1` is pushed, anything else is counted as a gap and dropped (re-stashing it is what looped). The next live batch resyncs once more if anything is still missing, so recovery is bounded. In main, `SessionManager.release()` returns right after `t.close()` when the pane is no longer the one registered under its `paneId`, so a pane replaced by `open()` on another file never applies `_eof` or flushes under the old seq. Tests: the requested stream-drain test (`{seq: 57}` against a `{seq: 0}` snapshot asserts exactly one `requestSnapshot`, label cleared, next in-order batch applies) and a session-manager test that reopens a live pane on another file and asserts no batch is emitted under the old batcher's seq.

### WR-01: `_eof` emitted twice on spawn failure and applied twice on normal exit

**Files modified:** `apps/desktop/src/main/chat/omp-transport.ts`, `apps/desktop/src/main/chat/omp-transport.test.ts` (new), `apps/desktop/src/main/chat/session-manager.ts`, `apps/desktop/src/main/chat/session-manager.test.ts`
**Commit:** 526013c
**Applied fix:** Verified locally on Node 24 that a failed spawn emits `error`, then (after the rejection microtask) `close`. `_eof` is now emitted only from the `close` handler, guarded by an `eofSent` flag; the `error` handler just rejects `start()`, so `startTransport`'s cleanup (unsubscribe, owners.delete) runs before `close` fires and the reducer never sees a spurious "ended unexpectedly". `SessionManager` gained `detach(pane)` (timer, subscription, transport, ownership) used by both the `_eof` frame path (no `close()`, no synthetic second `_eof`, meta `connected:false, running:false` flushed once) and by `release()`. Tests: new `omp-transport.test.ts` spawns a missing binary and asserts `start()` rejects and exactly one `_eof` arrives; a session-manager test pushes an `_eof` frame and asserts `closeCalls === 0`, one final batch with `remove sent-1` and `error: EOF_ERROR`, no timers left, and that the next send starts a fresh process.

### WR-02: Second `send` during spawn hits a null child and bricks the pane

**Files modified:** `apps/desktop/src/main/chat/session-manager.ts`, `apps/desktop/src/main/chat/session-manager.test.ts`
**Commit:** fba9dbb
**Applied fix:** `Pane` has a `starting: Promise<void> | null`; `send()` awaits it if present, otherwise starts the transport and stores the promise (cleared in `finally`). Concurrent sends share one spawn and keep prompt order; if the spawn fails, every waiting send rejects with `spawn-failed` and the pane is left clean for the next attempt. Tests: `MemoryTransport` got a `startGate`; one test holds the gate open across two sends and asserts a single transport, handshake first, prompts in order; another makes the gate reject and asserts both sends fail with `spawn-failed` and a third send succeeds on a new transport.

### WR-03: Resync leaves `reconnecting: true` forever when the snapshot fails or returns null

**Files modified:** `apps/desktop/src/renderer/chat/stream-drain.ts`, `apps/desktop/src/renderer/chat/stream-drain.test.ts`
**Commit:** 08f4249
**Applied fix:** Factored `clearLabel()` (honours `minReconnectMs`) and `fail()` (drops `resyncing`, deletes the stash, clears the label); `.then` with a null snapshot and `.catch` both call `fail()`. Test: a null snapshot and a rejected snapshot each clear the label, and the next in-order batch applies without another `requestSnapshot`.

### WR-04: `isAppUrl` prefix checks have no separator

**Files modified:** `apps/desktop/src/main/app-url.ts` (new), `apps/desktop/src/main/app-url.test.ts` (new), `apps/desktop/src/main/window.ts`
**Commit:** 7fdc4d5
**Applied fix:** The check moved into a pure `app-url.ts` (`matchesAppUrl(url, { devServerUrl, rendererDir })`) so it can be unit tested without importing `electron`; `window.ts` re-exports `isAppUrl`, so `ipc/handle.ts` is unchanged. Dev: `url === origin || url.startsWith(origin + '/')`; built: `pathToFileURL(rendererDir).href + '/'`. A malformed dev URL returns false instead of throwing. Tests cover `localhost:5173.evil.example`, `localhost:51730`, `renderer-other/`, the bare directory, hash/query suffixes, undefined and empty.

### WR-05: Address bar and extension `createTab` bypass the guest protocol allow-list

**Files modified:** `packages/browser-core/src/address.ts`, `packages/browser-core/src/address.test.ts`, `apps/desktop/src/main/browser/browser-host.ts`, `apps/desktop/src/main/browser/extensions.ts`, `apps/desktop/src/renderer/browser/PageStateCard.tsx`, `apps/desktop/e2e/browser-basic.spec.ts`
**Commit:** 223a4ff
**Applied fix:** `browser-core/address.ts` exports `LOADABLE_PROTOCOLS` (http, https, about), `BLOCKED_URL_CODE` (-20, ERR_BLOCKED_BY_CLIENT) and a pure `loadableUrl(url, { fromExtension })` (regex scheme parse; `browser-core` has no `URL` global and must stay DOM-free). `BrowserHost.navigate()` is the single choke point: a refused scheme sets `error = { host, code: BLOCKED_URL_CODE }` and never reaches `loadURL`; `createTab()` forwards options; the error-card retry in `reload()` now goes through `navigate()` too (it used to call `loadURL` directly, which would have re-opened the bypass). The `will-navigate` guard uses the same set. Extension-created tabs pass `fromExtension: true`, so `chrome-extension:` pages (Bitwarden popouts, options) keep working while the address bar cannot open them. `PageStateCard` shows a plain message for the blocked code ("This address cannot be opened here" / "Only web pages (http and https) open in this panel. {host} was not loaded.") without a Try again button. Tests: unit tests for `loadableUrl`; the browser-basic e2e now types `file:///etc/hosts` and `chrome://settings` into the address bar and asserts the card, no Try again button, the guest `getURL()` is not file/chrome, and the view stays hidden.

### WR-06: `did-navigate` records history with the previous page's title

**Files modified:** `apps/desktop/src/main/browser/browser-host.ts`
**Commit:** ecb227b
**Applied fix:** `nav()` counts the visit with an empty title (`history.visit(url, '')`); `addVisit` never replaces a title with an empty one, and `page-title-updated` supplies the right title via `history.title()`. The review's optional `s.title = ''` reset in `nav()` was deliberately not applied: `page-title-updated` is not guaranteed to fire again on back/forward navigations and the e2e asserts tab titles after back and reload, so the stale-title-during-load cosmetic was traded for not risking a blank tab title. The persisted-wrong-title bug itself is fixed. Covered by the existing history unit tests and the "suggestions from in-app history" e2e.

### WR-07: No cap on tabs a guest page can create

**Files modified:** `packages/contract/src/browser.ts`, `apps/desktop/src/main/browser/browser-host.ts`, `apps/desktop/src/main/browser/browser-ipc.ts`, `apps/desktop/src/main/browser/extensions.ts`, `apps/desktop/src/renderer/browser/browser-store.ts`
**Commit:** 77d3de0
**Applied fix:** `MAX_TABS = 32`. `createTab()` returns `null` once the cap is reached and emits a new contract event `browser.notice` (`{ message }`), which `startBrowserStore()` shows as a Mantine notification ("Tab limit reached (32). Close a tab to open another."), so nothing is dropped silently. The `browser.createTab` IPC handler returns a `tab-limit` coded error on null; the extension `createTab` callback throws. The window-open handler denies openers that are not the active tab, so a background page cannot spawn tabs. `TabIdSchema` was left alone (unrelated limit, as the review notes).
**Note:** the cap path itself has no automated test (BrowserHost needs Electron and a 32-view e2e would be slow and flaky); it is covered by typecheck, build and the existing tabs e2e (create, switch, close, target=_blank from the active tab still pass). Worth a quick manual check when Isaac is back.

### WR-08: A failed send loses the prompt text and leaves an unconfirmed row behind

**Files modified:** `packages/chat-core/src/reducer.ts`, `packages/chat-core/src/reducer.test.ts`, `apps/desktop/src/main/chat/session-manager.ts`, `apps/desktop/src/main/chat/session-manager.test.ts`, `apps/desktop/src/renderer/chat/Composer.tsx`, `apps/desktop/src/renderer/chat/Composer.test.tsx`
**Commit:** 7a7bfa3
**Applied fix:** `Composer.send` still clears the field immediately (avoids a double send on a fast second Enter) but restores the text on `!r.ok` unless something new was typed meanwhile, then sets the pane error as before. `LiveReducer.dropUnconfirmedRow(id)` removes exactly one unconfirmed prompt; `SessionManager.send` wraps the transport write and on rejection drops the row and `markRemove`s it before rethrowing. Tests: reducer test for `dropUnconfirmedRow`; session-manager test where `send()` rejects with EPIPE asserts the row is gone from the snapshot and the next batch carries only `remove sent-2`; Composer test asserts the text comes back and the pane error is set.

## Skipped Issues

None.

## Verification

- Per fix: re-read of the edited region, `pnpm -r typecheck` (or the desktop app's typecheck), eslint and prettier on the touched files, em-dash lint, and the relevant Vitest files.
- Final: `corepack pnpm gate` exited 0 (`GATE GREEN`): install check, typecheck, eslint, prettier, em-dash lint (77 files clean), Vitest 33 files / 170 tests, electron-vite build, Playwright 28 passed / 3 skipped (the live-only specs, unchanged), packaged dir build smoke 1 passed.
- New test files: `apps/desktop/src/main/chat/omp-transport.test.ts`, `apps/desktop/src/main/app-url.test.ts`. New source file: `apps/desktop/src/main/app-url.ts` (extracted so the IPC sender check is unit-testable).

---

_Fixed: 2026-10-15T06:13:03Z_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 1_
