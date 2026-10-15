---
phase: 01-foundation-harness-and-the-two-spikes
reviewed: 2026-10-15T06:47:25Z
depth: standard
iteration: 3
files_reviewed: 102
files_reviewed_list:
  - apps/desktop/e2e/fixtures.ts
  - apps/desktop/e2e/fixtures/test-extension/content.js
  - apps/desktop/e2e/helpers/frames.ts
  - apps/desktop/e2e/helpers/image.ts
  - apps/desktop/e2e/helpers/metrics.ts
  - apps/desktop/e2e/helpers/paths.ts
  - apps/desktop/e2e/helpers/proofShot.ts
  - apps/desktop/e2e/helpers/static-server.ts
  - apps/desktop/electron.vite.config.ts
  - apps/desktop/playwright.config.ts
  - apps/desktop/src/main/app-ipc.ts
  - apps/desktop/src/main/app-url.ts
  - apps/desktop/src/main/browser/arc-import.ts
  - apps/desktop/src/main/browser/browser-host.ts
  - apps/desktop/src/main/browser/browser-ipc.ts
  - apps/desktop/src/main/browser/extensions.ts
  - apps/desktop/src/main/browser/guest-session.ts
  - apps/desktop/src/main/browser/history-store.ts
  - apps/desktop/src/main/browser/index.ts
  - apps/desktop/src/main/browser/page-control.ts
  - apps/desktop/src/main/chat/index.ts
  - apps/desktop/src/main/chat/live-ipc.ts
  - apps/desktop/src/main/chat/omp-transport.ts
  - apps/desktop/src/main/chat/session-manager.ts
  - apps/desktop/src/main/chat/shell-path.ts
  - apps/desktop/src/main/chat/transcript-ipc.ts
  - apps/desktop/src/main/config-store.ts
  - apps/desktop/src/main/context.ts
  - apps/desktop/src/main/env.ts
  - apps/desktop/src/main/eva/write-guard.ts
  - apps/desktop/src/main/index.ts
  - apps/desktop/src/main/ipc/handle.ts
  - apps/desktop/src/main/menu.ts
  - apps/desktop/src/main/test-hooks.ts
  - apps/desktop/src/main/window.ts
  - apps/desktop/src/preload/bridge.ts
  - apps/desktop/src/preload/index.ts
  - apps/desktop/src/renderer/app/App.tsx
  - apps/desktop/src/renderer/app/PanelDivider.tsx
  - apps/desktop/src/renderer/app/Rail.tsx
  - apps/desktop/src/renderer/browser/AddressRow.tsx
  - apps/desktop/src/renderer/browser/BrowserPanel.tsx
  - apps/desktop/src/renderer/browser/ExtensionActions.tsx
  - apps/desktop/src/renderer/browser/ImportArcModal.tsx
  - apps/desktop/src/renderer/browser/PageStateCard.tsx
  - apps/desktop/src/renderer/browser/Suggestions.tsx
  - apps/desktop/src/renderer/browser/TabStrip.tsx
  - apps/desktop/src/renderer/browser/browser-store.ts
  - apps/desktop/src/renderer/browser/useBrowserHotkeys.ts
  - apps/desktop/src/renderer/browser/useSlotSync.ts
  - apps/desktop/src/renderer/chat/ChatLog.tsx
  - apps/desktop/src/renderer/chat/ChatPane.tsx
  - apps/desktop/src/renderer/chat/Composer.tsx
  - apps/desktop/src/renderer/chat/MessageRow.tsx
  - apps/desktop/src/renderer/chat/Pills.tsx
  - apps/desktop/src/renderer/chat/SessionList.tsx
  - apps/desktop/src/renderer/chat/chat-store.ts
  - apps/desktop/src/renderer/chat/pin.ts
  - apps/desktop/src/renderer/chat/stream-drain.ts
  - apps/desktop/src/renderer/env.d.ts
  - apps/desktop/src/renderer/ipc.ts
  - apps/desktop/src/renderer/main.tsx
  - apps/desktop/src/renderer/overlay/TestOverlay.tsx
  - apps/desktop/src/renderer/overlay/overlay-store.ts
  - apps/desktop/src/renderer/test-setup.ts
  - apps/desktop/src/renderer/theme.ts
  - eslint.config.mjs
  - fixtures/arc-export-fixture.mjs
  - fixtures/fake-omp/fake-omp.mjs
  - packages/browser-core/src/address.ts
  - packages/browser-core/src/arc-cookies.ts
  - packages/browser-core/src/history.ts
  - packages/browser-core/src/hotkeys.ts
  - packages/browser-core/src/index.ts
  - packages/chat-core/src/batcher.ts
  - packages/chat-core/src/frames.ts
  - packages/chat-core/src/index.ts
  - packages/chat-core/src/line-framer.ts
  - packages/chat-core/src/message.ts
  - packages/chat-core/src/reducer.ts
  - packages/chat-core/src/session.ts
  - packages/chat-core/src/sessions-dir.ts
  - packages/chat-core/src/tagged.ts
  - packages/chat-core/src/transport.ts
  - packages/contract/src/app.ts
  - packages/contract/src/browser.ts
  - packages/contract/src/chat.ts
  - packages/contract/src/index.ts
  - packages/contract/src/result.ts
  - packages/eva-core/src/fs/allowlist.ts
  - packages/eva-core/src/fs/atomic-write.ts
  - packages/eva-core/src/fs/eva-fs.ts
  - packages/eva-core/src/fs/write-trap.ts
  - packages/eva-core/src/index.ts
  - scripts/check-metrics.ts
  - scripts/env.sh
  - scripts/gate.sh
  - scripts/gen-benchmark-session.ts
  - scripts/lint-em-dash.ts
  - scripts/record-omp.mjs
  - scripts/scrub-recording.mjs
  - scripts/sentinel.ts
findings:
  critical: 0
  warning: 1
  info: 17
  total: 18
status: issues_found
---

# Phase 1: Code Review Report (iteration 3, final)

**Reviewed:** 2026-10-15T06:47:25Z
**Depth:** standard
**Files Reviewed:** 102
**Status:** issues_found

## Summary

Final re-review after the iteration-2 fix loop (commits 4fe5bea through 35c289f). Every file in scope was read again. The fix-range diff (12 non-test files) was traced against its callers: `SessionManager` against `live-ipc.ts`, `transcript-ipc.ts` and `OmpStdioTransport`; `Composer`/`ChatPane` against `chat-store` and the drain; `Snapshot` through `batcher.ts`, the contract, `applySnapshot` and `stream-drain`; `PageControl` against `BrowserHost.navigate()` and the CDP e2e.

All five iteration-2 Warnings are resolved in the current code, and the two adjacent Info items the fixer took (IN-14, IN-15) are resolved too. The lifecycle paths were walked by hand for new races: `open()` on another file while `acquire()` or `transport.start()` is pending, `_eof` during the handshake writes, a close that times out and the deferred disown, a send during the grace window on the same pane and on a fresh pane for the same file, and the renderer side of a send that fails after the reducer error was cleared. All of those end in a consistent state.

One new Warning came out of the WR-02 fix. `acquire()` releases its waiters without claiming the file, and the claim (`owners.set`) happens in the caller after one more microtask hop, so two panes waiting on the same closing process both see the key free and both spawn omp on the same session file. With a single paneId (all the Phase 1 renderer ever uses) the "pane still registered" check saves it, so it is not reachable from today's UI; it is reachable through the IPC contract with two paneIds, which is exactly the multi-pane case the manager's `ALREADY_OWNED` guard and its two-pane test are written for. The ordering was confirmed with a standalone simulation of the same control flow.

Fourteen Info items are carried forward from earlier iterations by id (IN-14 and IN-15 are closed). Three new Info items were added: a misleading `ALREADY_OWNED` message after a pane object is replaced, a resync re-asserting an error banner the user dismissed by typing, and the blocked URL being written into `TabState.url` before the allow-list check.

## Iteration 2 findings verified

| Id | Status | Evidence |
|----|--------|----------|
| WR-01 | resolved | `session-manager.ts:190-194` checks `stillMine()` (same transport object, same pane registered under the paneId) right after `transport.start()`, before the timer or `markMeta({ connected: true })`; `:199-201` checks again after the two handshake writes. `send()` re-reads `pane.transport` at `:127-128` and rejects with `session-closed` instead of dereferencing null. `omp-transport.ts:57-61` records the in-flight `start()` and `close()` awaits it at `:161` before looking for the child, so a close requested during `resolveSpawnPath` ends stdin of the real process. `release()` runs `detach()` synchronously (`:259`) before `open()` replaces the pane, so no timer or batch is ever installed on the replaced pane. |
| WR-02 | resolved | Ownership is `Owner { pane, transport, closing }` keyed by `realpath` (`:55-59`, `:85`). `release()` keeps the owner, sets `held.closing` (`:283`) and only disowns when the close resolved without timing out (`:271`); after a timeout a one-off `_eof` listener disowns when the process actually exits (`:274-278`). `acquire()` waits on `closing` and refuses with `already-owned` (`STILL_CLOSING` for the same pane) while the file is held (`:150-160`). Residual two-waiter race is new WR-01 below. |
| WR-03 | resolved | `ChatPane.tsx:78` passes `disabled={!pane}`; the error is a banner only (`:64-68`). `Composer.tsx:26-28` clears the error on a successful send and `:36-39` on edit. `reducer.ts:89-90` clears `error` in `sendPrompt()`, and `session-manager.ts:130-132` diffs that into `markMeta({ error: null })` since `sendPrompt` runs outside `apply()`. |
| WR-04 | resolved | `batcher.ts:21-31` `Snapshot` carries `connected` and `error`; `session-manager.ts:324-335` fills them from `p.transport !== null` and `p.reducer.error`; `contract/chat.ts:55-56` requires both; `chat-store.ts:132-133` sets `stopped: !snap.connected, error: snap.error`; `stream-drain.ts:5-12` type matches. The dead `stopped?` slot is gone. |
| WR-05 | resolved | `page-control.ts:12-16,47-49` takes a `load` callback and `navigate()` only calls it; `browser-host.ts:61-65` passes `(url) => this.navigate(tabId, url)`. `wc.loadURL` has exactly one call site (`browser-host.ts:270`). The CDP e2e asserts `file:///etc/hosts` through `PageControl` shows the blocked card and leaves `location.href` on `a.html`. |
| IN-14 | resolved (extra) | `browser-host.ts:22-23` `Tab.fromExtension`, set sticky at `:258`, passed back by `reload()` at `:284`, used by the `will-navigate`/`will-redirect` guard at `:191-193`. |
| IN-15 | resolved (extra) | `stream-drain.ts:76-80` the deferred clear returns when `disposed` or `resyncing.has(paneId)`. |

## Warnings

### WR-01: Two panes waiting on the same closing process both pass `acquire()` and spawn omp on one session file

**File:** `apps/desktop/src/main/chat/session-manager.ts:150-160`, `:166-173`
**Issue:** `acquire()` is the check half of a check-and-set whose set half (`this.owners.set(pane.key, ...)` at line 172) lives in the caller behind one more `await`. When `owner.closing` resolves, every waiter's continuation is queued in registration order. Waiter A re-reads the map (the owner was already deleted inside the `.then` that resolves `closing`), finds no owner and returns; waiter B's continuation runs next, also finds no owner and returns; only then does A's `startTransport` resume and set itself as owner, and B's resumes and overwrites it. Both call `createTransport()` and `transport.start({ sessionFile: pane.key })`: two `omp --resume` processes append to one session `.jsonl`, the single-writer rule (D-17) that WR-02 was fixed to protect, and the second `owners.set` means `disown()` from the first process never matches, so the first process is also unreachable to `closeAll()`. The pattern was reproduced in isolation (same loop, same `.then` ordering): both waiters spawn and the map ends with the second owner.

Reachability, precisely: with one paneId the replaced pane object fails `this.panes.get(pane.paneId) !== pane` at line 168 and bails, so the Phase 1 renderer (always `pane-1`) cannot hit this. It is reachable through the IPC contract with two paneIds on the same file while the first pane's process is in its 2 to 10 s grace window: `open('pane-1', f)`, `send('pane-1')`, `close('pane-1')` (or `open('pane-1', g)`), then `send('pane-1')` and `send('pane-2')` before the old omp exits. That is the configuration the manager's own `refuses a second pane on the same session file` test and the `ALREADY_OWNED` message exist for; the test only covers the steady state, not the grace window.
**Fix:** Make the claim atomic with the check by setting the owner inside the loop, before any further await:

```ts
private async acquire(pane: Pane, transport: ChatTransport): Promise<void> {
  for (;;) {
    const owner = this.owners.get(pane.key)
    if (!owner) {
      // Claim synchronously: no await between the check and the set.
      this.owners.set(pane.key, { pane, transport, closing: null })
      return
    }
    if (owner.closing) {
      await owner.closing
      continue
    }
    throw new CodedError('already-owned', owner.pane === pane ? STILL_CLOSING : ALREADY_OWNED)
  }
}

private async startTransport(pane: Pane): Promise<void> {
  const transport = this.deps.createTransport()
  await this.acquire(pane, transport)
  if (this.panes.get(pane.paneId) !== pane) {
    this.disown(pane.key, transport)
    throw new CodedError('session-closed', 'The session was closed before omp started.')
  }
  pane.transport = transport
  // ... unchanged from here
}
```

Add a test: two panes on the same file, close the first with the close promise held, send on both, release the close, and assert exactly one new transport was started and the other send rejected with `already-owned`.

## Info

Carried forward (still present at the cited lines unless noted):

### IN-01: Em dash lint does not scan `apps/desktop/src/main/**`

**File:** `scripts/lint-em-dash.ts:43-46`
**Issue:** Unchanged. `STILL_CLOSING` (`session-manager.ts:21-22`) is another user-facing string in main that is clean but unlinted.
**Fix:** Add `fs.globSync('apps/desktop/src/main/**/*.ts')`.

### IN-02: IPC output validation only runs in dev, and `.parse` strips unknown keys

**File:** `apps/desktop/src/main/ipc/handle.ts:35`
**Fix:** Validate in both modes or use `safeParse` as a dev-only assertion and always return `value`.

### IN-03: Address input text is overwritten by any URL change, including in-page navigation

**File:** `apps/desktop/src/renderer/browser/AddressRow.tsx:99`
**Fix:** Skip the reset while the input is focused.

### IN-04: `CodedError` is defined twice

**File:** `apps/desktop/src/main/chat/transcript-ipc.ts:8-15`; `apps/desktop/src/main/chat/session-manager.ts:10-17`
**Fix:** Import from `session-manager.ts` or move to `ipc/handle.ts`.

### IN-05: Dead code

**File:** `apps/desktop/src/main/browser/history-store.ts:15-16`
**Issue:** The `counted` set is still never read or written.
**Fix:** Remove `counted`.

### IN-06: Unused exports

**File:** `apps/desktop/src/main/browser/extensions.ts:19` (`getExtensionHost`); `packages/chat-core/src/sessions-dir.ts:94` (`resolveLiveSessionsDir`, while `env.ts:88` hard-codes `sessions/-Eva`); `packages/chat-core/src/frames.ts:81` (`cmd.cancelUi`, reducer builds the same object at `reducer.ts:186`); `apps/desktop/src/main/chat/session-manager.ts:107` (`has`, now used only by tests); `packages/chat-core/src/reducer.ts:84` (`stderrLines`); `packages/contract/src/result.ts:4` (`ok`)
**Fix:** Wire `resolveLiveSessionsDir` into live `resolveEnv` or delete it; use `cmd.cancelUi`; drop or phase-tag the rest.

### IN-07: `SeqBatcher` `at` is captured at mark time, not flush time

**File:** `packages/chat-core/src/batcher.ts:42-44`, `:64-71`
**Fix:** Recompute `at` at flush or document the append-only invariant next to `markUpsert`.

### IN-08: Guest favicons load in the privileged shell renderer on the default session

**File:** `apps/desktop/src/renderer/browser/TabStrip.tsx:34`; `apps/desktop/src/renderer/index.html:7` (`img-src ... http: https:`)
**Fix:** Fetch favicons in the guest session in main and hand the renderer a `data:` URL; then drop `http: https:` from `img-src`.

### IN-09: Preload surface is wider than the comment claims

**File:** `apps/desktop/src/preload/index.ts:7-8`
**Fix:** Correct the comment; note the library-owned browser-action bridge in the threat model.

### IN-10: Recording scrubber rewrites `id` but not `toolCallId`

**File:** `scripts/scrub-recording.mjs:32`
**Fix:** Scrub `id` only on frame objects, or map `id`/`toolCallId` through one table.

### IN-11: Gate tooling side effects and hard-coded paths

**File:** `scripts/check-metrics.ts:52-55`; `scripts/sentinel.ts:11`
**Fix:** Move the note injection to the metrics writer; derive the sentinel repo list from `EVAOS_EVA_ROOT` / `os.homedir()`.

### IN-12: `tabId` is referenced before its declaration

**File:** `apps/desktop/src/renderer/browser/AddressRow.tsx:72-76` vs `:100`
**Fix:** Move `const tabId = tab?.id` above `go`.

### IN-13: The tab-limit notice can be spammed by the active guest page

**File:** `apps/desktop/src/main/browser/browser-host.ts:113-119`, `:162-178`
**Fix:** Rate-limit the notice (once per second) or deny silently in the window-open handler and emit only for user-initiated creations.

### IN-14: resolved in 35c289f (see table above).

### IN-15: resolved in 3884027 (see table above).

### IN-16: Login-shell PATH probe takes the whole stdout, including anything the rc files print

**File:** `apps/desktop/src/main/chat/shell-path.ts:15-18`
**Fix:** Use the last line of stdout, or run `-lc` first and fall back to `-ilc`.

New in iteration 3:

### IN-17: `acquire()` reports `ALREADY_OWNED` ("another window or pane") for the user's own pane after `open()` replaced the pane object

**File:** `apps/desktop/src/main/chat/session-manager.ts:158`; `:84-105`
**Issue:** `owner.pane === pane` compares pane objects. `open()` always creates a new `Pane` object for the paneId, so after a timed-out close followed by a re-open of the same file in the same pane (same paneId, same key), the next send is refused with `ALREADY_OWNED`, which tells the user the session is open "in another EvaOS window or pane", when it is their own previous omp still exiting. `STILL_CLOSING` is the message that applies. Reachable only through `chat.open` while a pane exists (not from the Phase 1 UI).
**Fix:** Compare paneIds: `owner.pane.paneId === pane.paneId ? STILL_CLOSING : ALREADY_OWNED`.

### IN-18: Typing clears the renderer error banner, but the reducer keeps it, so a later resync brings the banner back

**File:** `apps/desktop/src/renderer/chat/Composer.tsx:36-39`; `apps/desktop/src/main/chat/session-manager.ts:331-332`; `packages/chat-core/src/reducer.ts:61`, `:89-90`
**Issue:** `edit()` calls `setError(paneId, null)` locally; main's `LiveReducer.error` stays `EOF_ERROR` until the next `sendPrompt()`. `chat.snapshot` returns `p.reducer.error`, so if a gap resync happens between the user starting to type and pressing Enter (a batch dropped while omp is restarted, for example), `applySnapshot` re-asserts the banner the user just dismissed. Cosmetic; the snapshot is the truth and the next successful send clears both sides.
**Fix:** Either do not clear on edit (clear only on a successful send, which also updates main), or treat the banner as dismissed locally with a separate `errorDismissed` flag that `applySnapshot` preserves.

### IN-19: A refused URL is written into `TabState.url` before the allow-list check

**File:** `apps/desktop/src/main/browser/browser-host.ts:259-266`
**Issue:** `navigate()` sets `t.state.url = url` and `blank = false` before `loadableUrl()` runs, so for a blocked scheme the tab's `url` (address bar text, `copyLink`, the label in `TabStrip` when there is no title) becomes `file:///etc/hosts` while the view still shows the previous page, and `canGoBack`/`canGoForward` still describe that page. `openExternal` is unaffected (it re-checks http/https). The error card already uses `tab.error.host`, so the state does not need the URL to render it.
**Fix:** Keep the previous `url` when the scheme is refused and carry the typed address only in `error.host`:

```ts
if (!loadableUrl(url, opts)) {
  t.state.loading = false
  t.state.error = { host: hostOf(url), code: BLOCKED_URL_CODE }
  this.changed()
  return
}
t.state.url = url
t.state.blank = false
t.state.error = null
```

---

_Reviewed: 2026-10-15T06:47:25Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
_Iteration: 3_
