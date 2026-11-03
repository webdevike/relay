---
phase: 01-foundation-harness-and-the-two-spikes
fixed_at: 2026-10-15T06:40:13Z
review_path: .planning/phases/01-foundation-harness-and-the-two-spikes/01-REVIEW.md
iteration: 2
fix_scope: critical_warning
findings_in_scope: 5
fixed: 5
skipped: 0
status: all_fixed
extra_fixed: 2
gate: GATE GREEN (typecheck, eslint, prettier, em-dash lint, Vitest 186 tests, electron-vite build, 28 Playwright specs plus 3 live-only skipped, packaged smoke)
---

# Phase 1: Code Review Fix Report (iteration 2)

**Fixed at:** 2026-10-15T06:40:13Z
**Source review:** `.planning/phases/01-foundation-harness-and-the-two-spikes/01-REVIEW.md` (iteration 2)
**Iteration:** 2
**Scope:** Warning (WR-01 through WR-05; the review has no Critical findings). Two adjacent Info items (IN-14, IN-15) were fixed because the same files were already open; the other Info items are carried forward.

**Summary:**
- Findings in scope: 5
- Fixed: 5
- Skipped: 0
- Extra (Info, out of scope but trivially adjacent): 2 fixed

Each fix was read against the current source and its tests first, applied so the existing tests keep their intent, verified (re-read, `tsc --noEmit` on every package, eslint, prettier, em-dash lint, the relevant Vitest files, and for WR-05 the CDP e2e after a fresh build), and committed on its own. Work was done directly on `main` as the orchestrator's environment block required (sequential work on the main tree, no branches or worktree). After the last commit the full `corepack pnpm gate` was run; see Verification.

## Fixed Issues

### WR-01: A pane replaced or closed while `startTransport` is in flight leaks an owner-less omp, a flush timer and a stray batch, and the pending send fails with a `TypeError`

**Files modified:** `apps/desktop/src/main/chat/session-manager.ts`, `apps/desktop/src/main/chat/session-manager.test.ts`, `apps/desktop/src/main/chat/omp-transport.ts`, `apps/desktop/src/main/chat/omp-transport.test.ts`
**Commit:** 4fe5bea
**Outcome:** fixed
**Applied fix:** `startTransport()` checks `stillMine()` (same transport, same pane registered under the paneId) after `transport.start()` and again after the two handshake writes; when it is no longer the owner it throws a coded `session-closed` error and installs no flush timer, writes no handshake and marks nothing on the old batcher. `send()` re-reads `pane.transport` after awaiting the start and rejects with `session-closed` when it is gone, so the `TypeError` path is closed (also covers omp exiting between the handshake writes). On the transport side, `OmpStdioTransport.start()` records its in-flight promise and `close()` awaits it before looking for the child, so a close requested mid-spawn ends stdin of the real process instead of returning early and leaving it owner-less. The review's extra `transport.close()` inside `startTransport` was deliberately not added: the detach paths (`open()`/`close()` -> `release()`, or `_eof`) already own the single close, and the new test asserts `closeCalls === 1`.
**Tests:** `session-manager.test.ts` "a pane replaced while omp is spawning leaves no timer, no stray batch and one close" (start gate held open, `open()` on another file, gate released: pending send rejects with `session-closed`, zero timers, no batch under the old pane, no handshake written, one close, the new pane starts at seq 1) and "omp exiting during the handshake rejects the pending send with a code, not a TypeError" (a `writeHook` pushes `_eof` from inside the first handshake write). `omp-transport.test.ts` gained "close() requested while start() is still spawning waits for the child and ends it" (a real `/bin/sh` stand-in that exits 0 on stdin EOF; exit `{code: 0, timedOut: false}`, one `_eof` with `expected: true`) and "close() after a failed start does not hang".

### WR-02: `release()` drops session-file ownership before omp has exited, so a send inside the grace window spawns a second omp on the same session file

**Files modified:** `apps/desktop/src/main/chat/session-manager.ts`, `apps/desktop/src/main/chat/session-manager.test.ts`
**Commit:** b808083
**Outcome:** fixed
**Applied fix:** Ownership is now a record of the owning process, `Owner = { pane, transport, closing }`, keyed by the file's realpath, instead of a paneId (a paneId is reused when the user switches away and back, which the old key could not distinguish). `release()` detaches the pane but keeps the owner, sets `owner.closing` to the close promise and releases the file only when the close resolves without timing out; after a timed-out close (process still alive) the file stays owned and a one-off `_eof` listener on the old transport releases it when the process finally exits. `startTransport()` calls `acquire()`, which waits on `owner.closing` (looping, since a later owner may appear) and then refuses with `already-owned` if the file is still held: `ALREADY_OWNED` for another pane's live process, a new `STILL_CLOSING` message for the same pane after a timed-out close, as the review required. After waiting it also re-checks that the pane is still the registered one (the user may have switched away during the wait). The `_eof` frame path and a failed spawn release ownership explicitly via `disown(key, transport)` so a stale record can never be removed by the wrong process. Behaviour required by the instructions: a send on the same pane during the grace window waits for the old omp to exit and then starts one new process; a quick switch to another session and back does the same; nothing spawns while the file is owned.
**Tests:** "a send inside the close grace window waits for the previous omp to exit (single writer)", "switching to another session and back during the grace window waits as well" (also asserts the replaced pane emitted nothing and the fresh pane starts at seq 1), "a timed-out close keeps the file owned until the process reports its exit" (send refused with `already-owned` / `STILL_CLOSING`, released on `_eof`, next send spawns). The existing `already-owned`, `close()`/`closeAll()` and `_eof` tests pass unchanged.

### WR-03: Any send error disables the composer permanently, so the prompt restored by the WR-08 fix can never be re-sent

**Files modified:** `apps/desktop/src/renderer/chat/ChatPane.tsx`, `apps/desktop/src/renderer/chat/Composer.tsx`, `apps/desktop/src/renderer/chat/Composer.test.tsx`, `packages/chat-core/src/reducer.ts`, `packages/chat-core/src/reducer.test.ts`, `apps/desktop/src/main/chat/session-manager.ts`, `apps/desktop/src/main/chat/session-manager.test.ts`
**Commit:** 38345aa
**Outcome:** fixed (UI behaviour; worth a glance by Isaac when back, see note)
**Applied fix:** `ChatPane` passes `disabled={!pane}`; a pane error stays a banner and no longer locks the composer. `Composer` clears the pane error on a successful send (`setError(paneId, null)`) and when the user edits the field (`edit()` wraps `setText`), which is the behaviour the instructions asked for. Main side, `LiveReducer.sendPrompt()` clears its EOF error (a new prompt supersedes it) and, because `sendPrompt` runs outside `apply()`'s meta diffing, `SessionManager.send()` marks `error: null` on the batcher when there was an error, so the renderer and a later `chat.snapshot` (now carrying `error`, WR-04) agree. The `stopped` placeholder text and the `chat-control` e2e that asserts it are unchanged.
**Tests:** reducer "a new prompt after an unexpected _eof clears the error" (and the next frame does not re-report it); Composer "a successful send clears a previous pane error, so a restored prompt can be re-sent" (error set after the text is typed, so only the send can clear it) and "editing the composer clears the pane error"; the session-manager `_eof` test now asserts the batch after the restart carries `{ connected: true, error: null }`.
**Note:** the "Session is not running. Resume it to send a message." placeholder still shows while `stopped` is true even though Enter now restarts omp; it is asserted by an e2e and the wording is a UI-SPEC matter, so it was left alone.

### WR-04: `chat.snapshot` omits `connected` and `error`, so gap recovery loses the stopped state and the EOF banner

**Files modified:** `packages/chat-core/src/batcher.ts`, `packages/chat-core/src/batcher.test.ts`, `packages/contract/src/chat.ts`, `packages/contract/src/contract.test.ts`, `apps/desktop/src/renderer/chat/chat-store.ts`, `apps/desktop/src/renderer/chat/stream-drain.ts`, `apps/desktop/src/renderer/chat/stream-drain.test.ts`, `apps/desktop/src/main/chat/session-manager.ts`, `apps/desktop/src/main/chat/session-manager.test.ts`
**Commit:** d37848b
**Outcome:** fixed
**Applied fix:** `Snapshot` gains `connected: boolean` and `error: string | null`; `SeqBatcher.snapshot()` takes a `SnapshotState` object (`running`, `connected`, `error`) instead of a bare `running`. `SessionManager.snapshot()` fills `connected: p.transport !== null` and `error: p.reducer.error`. The contract output schema requires both fields. `chat-store.applySnapshot` sets `stopped: !snap.connected` and `error: snap.error` (the dead `stopped?` slot is gone). The drain's `Snapshot` type matches.
**Tests:** contract "chat.snapshot output carries connected and error, not just running"; batcher snapshot tests; stream-drain "a snapshot taken after omp exited restores the stopped state and the EOF banner" (the dropped batch is the `_eof` one); session-manager `_eof` test asserts the snapshot is `{ running: false, connected: false, error: EOF_ERROR }` and the plain snapshot test asserts `connected: true, error: null`.

### WR-05: `PageControl.navigate()` loads a URL straight into the guest view, bypassing the allow-list choke point

**Files modified:** `apps/desktop/src/main/browser/page-control.ts`, `apps/desktop/src/main/browser/page-control.test.ts` (new), `apps/desktop/src/main/browser/browser-host.ts`, `apps/desktop/e2e/browser-cdp.spec.ts`
**Commit:** 3ace61c
**Outcome:** fixed
**Applied fix:** `PageControl` takes a `load: (url) => void` callback and `navigate()` only calls it; `BrowserHost.pageControl()` passes `(url) => this.navigate(tabId, url)`, so agent page control goes through the same `loadableUrl` check and `TabState` updates as the address bar. `navigate()` is now synchronous (`void`), matching the host; the e2e `PC` type was updated.
**Tests:** `page-control.test.ts` with a fake `WebContents`: `navigate()` hands the URL to `load` and never calls `loadURL`; `evaluate()` attaches lazily and surfaces page exceptions. The CDP e2e now navigates to `file:///etc/hosts` through `PageControl`, asserts the "This address cannot be opened here" card, that `location.href` in the guest is still `a.html`, then navigates back and continues with the DevTools check. Verified green after a fresh build before committing.

## Adjacent Info items fixed

### IN-15: A stale `clearLabel` timer can clear the label of a later resync, and fires after `dispose()`

**Files modified:** `apps/desktop/src/renderer/chat/stream-drain.ts`, `apps/desktop/src/renderer/chat/stream-drain.test.ts`
**Commit:** 3884027
**Applied fix:** The deferred clear returns when `disposed` or when `resyncing.has(paneId)`. Test with an injected timer list and fixed clock: a second gap before the first label timer fires keeps the label up; after `dispose()` the timer is a no-op.

### IN-14: Extension tabs lose their `fromExtension` status on retry and cannot navigate between their own pages

**Files modified:** `apps/desktop/src/main/browser/browser-host.ts`
**Commit:** 35c289f
**Applied fix:** `Tab.fromExtension` is set by `navigate()` when the option is passed (sticky for the tab's life); `reload()` passes it back for the error-card retry; the `will-navigate`/`will-redirect` guard uses `loadableUrl(url, { fromExtension: tab.fromExtension })`, the same helper as `navigate()`, so an extension page can link to another of its own pages. The now-unused `LOADABLE_PROTOCOLS` import was dropped. Covered by typecheck, build and the existing extensions e2e (BrowserHost needs Electron, so no unit test).

## Skipped Issues

None.

## Info items carried forward (not in scope)

IN-01 through IN-13 and IN-16 from the review are unchanged: em-dash lint scope, dev-only IPC output validation, address input reset while focused, duplicate `CodedError`, dead `counted` set, unused exports, batcher `at` timing, guest favicons in the shell renderer, preload surface comment, scrubber `toolCallId`, gate tooling paths, `tabId` declaration order, tab-limit notice spam, and the login-shell PATH probe.

## Verification

- Per fix: re-read of the edited regions, `pnpm -r typecheck`, eslint and prettier on the touched files, em-dash lint (77 files clean), and the relevant Vitest files. WR-05 additionally ran `electron-vite build` plus the CDP e2e spec.
- Vitest went from 33 files / 170 tests to 34 files / 186 tests (new file `apps/desktop/src/main/browser/page-control.test.ts`; 16 new cases across session-manager, omp-transport, reducer, Composer, batcher, contract, stream-drain and page-control).
- Final: `corepack pnpm gate` on HEAD 35c289f exited 0 (`GATE GREEN`): install check (lockfile up to date), typecheck, eslint, prettier, em-dash lint, Vitest 34 files / 186 tests, electron-vite build, Playwright 28 passed / 3 skipped (the live-only specs, unchanged), packaged dir build smoke 1 passed.

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

_Fixed: 2026-10-15T06:40:13Z_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 2_
