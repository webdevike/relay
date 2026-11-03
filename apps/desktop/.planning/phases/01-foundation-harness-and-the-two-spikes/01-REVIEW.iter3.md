---
phase: 01-foundation-harness-and-the-two-spikes
reviewed: 2026-10-15T06:23:39Z
depth: standard
iteration: 2
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
  warning: 5
  info: 16
  total: 21
status: issues_found
---

# Phase 1: Code Review Report (iteration 2)

**Reviewed:** 2026-10-15T06:23:39Z
**Depth:** standard
**Files Reviewed:** 102
**Status:** issues_found

## Summary

This is the re-review after the iteration-1 fix loop (commits a2868b7 through 7a7bfa3). Every file in scope was read again, with the fix commits traced against their callers (`SeqBatcher`, `LiveReducer`, `chat-store.applyOps`, `handle()`/`emit()`, the preload channel filter, `history.addVisit`, `normalize`/`loadableUrl`) and the pre-fix `session-manager.ts` diffed for regressions.

All nine iteration-1 Critical and Warning findings are resolved in the current code, not just claimed: the drain no longer re-stashes an unreachable batch, `_eof` is emitted once and applied once, concurrent sends share one spawn, failed snapshots clear the label and stash, the sender check is exact at a separator, every guest load goes through `BrowserHost.navigate()` with the allow-list, visits are counted without the stale title, tabs are capped and only the active tab may open them, and a failed send restores the prompt and drops the pending row.

The fixes exposed or left five residual issues, all Warnings and all in the live-chat lifecycle or the browser allow-list seam:

- The "released panes stay inert" guarantee from CR-01 holds only after omp has spawned. If `open()` (another session) or `close()` runs while `startTransport` is still awaiting `transport.start()` or the handshake writes, the in-flight start finishes on the detached pane: an omp process is spawned with no owner, a 16 ms flush timer leaks, one stray batch goes out under the old batcher's seq (so the new pane's own first batch is dropped as a duplicate), and `send()` dereferences the now-null transport with a `TypeError` that becomes the pane error.
- `release()` still drops session-file ownership before omp has exited, so a send inside the 2 to 10 s grace window spawns a second omp on the same session file (the single-writer rule, D-17).
- The WR-08 fix restores the text into a composer that the same error has just disabled for good; there is no path that clears a pane error, so the restored prompt cannot be re-sent.
- `chat.snapshot` carries neither `connected` nor `error`, so gap recovery loses the "ended unexpectedly" state when the dropped batch was the `_eof` batch.
- `PageControl.navigate()` calls `loadURL` directly, contradicting the new single-choke-point comment on `BrowserHost.navigate()`.

The twelve iteration-1 Info items were out of the fixer's scope and are carried forward (IN-05 is half resolved). Four new Info items were added.

## Iteration 1 findings verified

| Id | Status | Evidence |
|----|--------|----------|
| CR-01 | resolved | `stream-drain.ts:113-124` skips `<= last`, pushes `last + 1`, counts a gap and breaks on anything else; nothing is re-stashed. `session-manager.ts:209` returns from `release()` when the pane is no longer registered. Residual window during spawn is new WR-01 below. |
| WR-01 | resolved | `omp-transport.ts:102-113` emits `_eof` only from `close` behind `eofSent`; the `error` handler only rejects `start()`. `session-manager.ts:167-172` flushes once and calls `detach()`, no `close()`, no synthetic second `_eof`. |
| WR-02 | resolved | `session-manager.ts:104-112` shares `pane.starting` across concurrent sends and clears it in `finally`. The related handshake-window gap is folded into new WR-01. |
| WR-03 | resolved | `stream-drain.ts:79-84` `fail()` clears `resyncing`, the stash and the label on both the null and the rejected path. |
| WR-04 | resolved | `app-url.ts:24` requires `url === origin \|\| url.startsWith(origin + '/')`; `:26-27` appends `/` to the built renderer dir. `window.ts:6` re-exports so `handle.ts` is unchanged. |
| WR-05 | resolved | `browser-host.ts:256-272` is the single `loadURL` call site for address bar, new tab, extension `createTab` and error-card retry; `address.ts:12-19` `loadableUrl` admits `chrome-extension:` only with `fromExtension`. The remaining direct `loadURL` in `page-control.ts:41` is new WR-05. |
| WR-06 | resolved | `browser-host.ts:216` counts the visit with an empty title; `history.ts:35-38` never replaces a title with an empty one; `page-title-updated` supplies it via `history.title()`. |
| WR-07 | resolved | `browser-host.ts:30,112-117` cap at 32 with a `browser.notice`; `:161` denies window-open from a non-active tab; `browser-ipc.ts:36` and `extensions.ts:48` handle the null. `browser.notice` is in the contract (`browser.ts:100`) so the preload filter admits it. |
| WR-08 | resolved as specified | `Composer.tsx:25-29` restores the text when nothing new was typed; `session-manager.ts:115-123` drops the row and marks the remove before rethrowing; `reducer.ts:97-102` only removes unconfirmed rows. The restored text is not re-sendable, see new WR-03. |

## Warnings

### WR-01: A pane replaced or closed while `startTransport` is in flight leaks an owner-less omp process, a flush timer and a stray batch, and the pending send fails with a `TypeError`

**File:** `apps/desktop/src/main/chat/session-manager.ts:71-78`, `:104-123`, `:126-151`, `:196-209`; `apps/desktop/src/main/chat/omp-transport.ts:149-151`
**Issue:** `startTransport()` sets `pane.transport` at line 133 and then awaits `transport.start()` (which first awaits `resolveSpawnPath`, up to 3 s on the first live spawn) and two handshake writes. During that window `open()` on another file (line 77) or `close()` calls `release()`, which `detach()`es the pane (transport nulled, listeners dropped, ownership released) and then calls `t.close()`. `OmpStdioTransport.close()` finds `this.child` still null and returns `{ timedOut: false }` immediately without ever ending stdin (line 151). `start()` then continues and spawns omp anyway. Back in `startTransport`, line 147 installs a 16 ms flush timer on the detached pane, line 148 marks `connected: true` on the old batcher, and the handshake is written to a process nobody owns or will ever close (`closeAll` only walks `this.panes`). The old timer flushes `{ paneId, seq: 1, ops: [meta connected, remove sent-1] }`, which the renderer accepts because the fresh pane's `lastSeq` is 0, so the new pane's own seq-1 batch (its first prompt row and `connected: true`) is then dropped as a duplicate. Finally `send()` reaches `pane.transport!.send(...)` with `transport === null`, throws `TypeError: Cannot read properties of null (reading 'send')`, and `handle()` returns it as an `internal` error that `Composer` writes into the pane error banner. The same null dereference happens if omp exits (`_eof` -> `detach`) between lines 149 and 150. In fixture mode the window is a few milliseconds; in live mode the first spawn gives a user up to 3 s to click another session.
**Fix:** Make `startTransport` notice that it has been detached, and make `close()` honour a close requested before spawn:

```ts
// session-manager.ts
private async startTransport(pane: Pane): Promise<void> {
  // ... owners/transport/unsubscribe as today ...
  try {
    await transport.start({ sessionFile: pane.key, cwd: this.deps.cwd })
  } catch (e) { /* unchanged */ }
  const stillMine = (): boolean =>
    pane.transport === transport && this.panes.get(pane.paneId) === pane
  if (!stillMine()) {
    void transport.close({ timeoutMs: 2000 }).catch(() => undefined)
    throw new CodedError('session-closed', 'The session was closed before omp started.')
  }
  pane.timer = this.setIv(() => this.flush(pane), this.deps.intervalMs ?? 16)
  pane.batcher.markMeta({ connected: true })
  await transport.write(cmd.setAskDialog('evaos-ask')).catch(() => undefined)
  await transport.write(cmd.getState('evaos-state')).catch(() => undefined)
  if (!stillMine()) throw new CodedError('session-closed', 'The session ended while starting.')
}

async send(paneId: string, text: string): Promise<void> {
  // ... await pane.starting as today ...
  const transport = pane.transport
  if (!transport) throw new CodedError('session-closed', 'The session is not running.')
  const row = pane.reducer.sendPrompt(text)
  // ...
  await transport.send(tagged(text, this.deps.machineLabel))
}

private async release(pane: Pane, timeoutMs = 2000) {
  if (pane.starting) await pane.starting.catch(() => undefined)
  // ... existing body ...
}
```

```ts
// omp-transport.ts
async close(opts?) {
  this.closing = true
  const child = this.child
  if (!child || !this.exit) return { code: null, signal: null, timedOut: false }
  // ...
}
// and in start(), right after spawn:
if (this.closing) child.stdin!.end()
```

Add a `session-manager.test.ts` case: hold `startGate` open, call `open()` on another file, release the gate, and assert no timer remains, no batch is emitted under the old pane, the pending send rejects with a coded error (not a `TypeError`), and `transport.closeCalls === 1`.

### WR-02: `release()` drops session-file ownership before omp has exited, so a send inside the grace window spawns a second omp on the same session file

**File:** `apps/desktop/src/main/chat/session-manager.ts:176-183`, `:196-205`, `:104-112`
**Issue:** `release()` calls `detach()` first, which deletes the `owners` entry and nulls `pane.transport`, and only then awaits `t.close()` for up to 2 s (`open()`), 10 s (`close()`/`closeAll()`). Stdin EOF does not stop omp mid-turn: it finishes streaming and keeps appending to the session file until it exits. In that window `send()` on the same pane (or on a fresh pane for the same file after a quick switch back) sees no transport and no owner and spawns a second `omp --resume <same file>`. Two processes then append to one session `.jsonl`, which is exactly what the single-writer rule (D-17) and the "no destructive use of live sessions" constraint exist to prevent. Phase 1 has no close button, so the realistic trigger today is `open()` to another session and back within 2 s while a reply is streaming; `chat.close` and the quit path widen it to 10 s. (Pre-fix code had the same ordering; the CR-01 fix made it easier to hit by making `open()` a routine release path.)
**Fix:** Keep the ownership until the process is gone, and let `send()` wait for a pending close:

```ts
interface Pane { /* ... */ closing: Promise<TransportExit | null> | null }

private async release(pane: Pane, timeoutMs = 2000) {
  const t = pane.transport
  if (!t) return null
  // detach everything except ownership
  this.detach(pane, { keepOwner: true })
  const done = t.close({ timeoutMs }).catch(() => null).finally(() => {
    if (this.owners.get(pane.key) === pane.paneId) this.owners.delete(pane.key)
    pane.closing = null
  })
  pane.closing = done
  const exit = await done
  // ... existing _eof application ...
}

async send(paneId: string, text: string) {
  const pane = this.pane(paneId)
  if (pane.closing) await pane.closing
  // ... as today ...
}
```

On a `timedOut` close the owner should stay set (the process is still alive) and `send()` should reject with `already-owned` rather than start a second process.

### WR-03: Any send error disables the composer permanently, so the prompt restored by the WR-08 fix can never be re-sent

**File:** `apps/desktop/src/renderer/chat/ChatPane.tsx:43`, `:78`; `apps/desktop/src/renderer/chat/Composer.tsx:22`, `:25-29`; `apps/desktop/src/renderer/chat/chat-store.ts:144`; `packages/chat-core/src/reducer.ts:61`, `:205`
**Issue:** `ChatPane` derives `unavailable = !pane || pane.error !== null` and passes it as `disabled`; `Composer.send` returns early when `disabled`. `setError` is called with a message in exactly one place and never with `null`, and the reducer's `error` is only ever set to `EOF_ERROR`, never cleared, so once a pane has an error (a transient `spawn-failed`, EPIPE after omp exited, WR-01's `TypeError`, or an unexpected omp exit) the composer is disabled for the rest of the app lifetime. `SessionList` is only rendered while no pane exists, so there is no re-open path either. The WR-08 fix therefore puts the prompt back into a textarea the user cannot submit from. This also contradicts `SessionManager.send()`, which deliberately restarts omp when `pane.transport` is null ("the next send starts a new process"), and the placeholder text "Session is not running. Resume it to send a message." which promises a resume that does not exist in Phase 1.
**Fix:** Decouple the banner from the composer: keep showing `pane.error` but only disable the composer when there is no pane. Clear the error on the next successful send on both sides:

```tsx
// ChatPane.tsx
<Composer paneId={PANE_ID} disabled={!pane} />

// Composer.tsx
const r = await invoke('chat.send', { paneId, text: value })
if (r.ok) chatStore.getState().setError(paneId, null)
else { /* restore text, setError as today */ }
```

```ts
// reducer.ts  sendPrompt(): a new prompt supersedes a previous EOF error
sendPrompt(text: string): ChatMessage {
  this.error = null
  // ...
}
```

Because `error` is part of `snapshotMeta()`/`diffMeta()`, clearing it in `sendPrompt` needs `send()` to run `sendPrompt` through `apply`-style meta diffing, or simply `pane.batcher.markMeta({ error: null })` next to the upsert in `SessionManager.send`.

### WR-04: `chat.snapshot` omits `connected` and `error`, so gap recovery loses the stopped state and the EOF banner

**File:** `apps/desktop/src/main/chat/session-manager.ts:245-252`; `packages/chat-core/src/batcher.ts:20-25`, `:75-77`; `packages/contract/src/chat.ts:47-55`; `apps/desktop/src/renderer/chat/chat-store.ts:123-133`
**Issue:** A resync replaces the renderer's view of the pane with `{ seq, messages, meta, running }`. `connected` (which drives `stopped`) and `error` (which drives the banner) live only in `MetaPatch` ops. If the batch that was lost is the one carrying `connected: false, error: EOF_ERROR` (the `_eof` batch at `session-manager.ts:169-170`, which is also exactly the batch the e2e `dropNextBatch` hook can drop), the snapshot restores `running: false` but leaves `stopped: false` and `error: null`. The pane then looks connected and healthy although omp has exited, and the placeholder/pills never switch. `applySnapshot` even has a `stopped?: boolean` slot that nothing fills.
**Fix:** Make the snapshot a complete pane state:

```ts
// batcher.ts
export interface Snapshot { seq: number; messages: ChatMessage[]; meta: SessionMeta; running: boolean; connected: boolean; error: string | null }
// session-manager.ts
snapshot(paneId) {
  const p = this.pane(paneId)
  return { ...p.batcher.snapshot(...), connected: p.transport !== null, error: p.reducer.error }
}
// contract/chat.ts: add connected: z.boolean(), error: z.string().nullable()
// chat-store.ts applySnapshot: stopped: !snap.connected, error: snap.error
```

### WR-05: `PageControl.navigate()` loads a URL straight into the guest view, bypassing the allow-list choke point

**File:** `apps/desktop/src/main/browser/page-control.ts:40-42`; contrast `apps/desktop/src/main/browser/browser-host.ts:251-272`
**Issue:** The WR-05 fix documents `BrowserHost.navigate()` as "the one place a guest view is told to load a URL" and puts the `loadableUrl` check there. `PageControl.navigate(url)` is a second call site that goes to `wc.loadURL(url)` with no check and without updating `TabState` (`url`, `blank`, `error`). Today it is reachable only through the e2e test hook (`registerTestHook('browser', { pageControl })`), but the class is explicitly the seam for agent page control in the next phase, which is exactly the caller that will hand it untrusted URLs (`file:`, `chrome:`, `chrome-extension:` without the extension flag).
**Fix:** Route it through the host so the policy has one owner:

```ts
// page-control.ts
constructor(private readonly wc: WebContents, private readonly load: (url: string) => void) { /* ... */ }
navigate(url: string): void { this.load(url) }

// browser-host.ts
pageControl(tabId: string): PageControl {
  const t = this.tab(tabId)
  t.control ??= new PageControl(t.view.webContents, (url) => this.navigate(tabId, url))
  return t.control
}
```

If no caller needs it in Phase 1, deleting the method is equally fine.

## Info

Carried forward from iteration 1 (still present unless noted):

### IN-01: Em dash lint does not scan `apps/desktop/src/main/**`

**File:** `scripts/lint-em-dash.ts:43-46`
**Issue:** Unchanged. The WR-07 fix added another user-facing string in main (`browser-host.ts:114`, the tab-limit notice); it is clean, but still unlinted.
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

### IN-05: Dead code (half resolved)

**File:** `apps/desktop/src/main/browser/history-store.ts:15-16`
**Issue:** The `counted` set is still never read or written. The `&& pane.batcher` half was removed by the CR-01 fix.
**Fix:** Remove `counted`.

### IN-06: Unused exports

**File:** `apps/desktop/src/main/browser/extensions.ts:19` (`getExtensionHost`); `packages/chat-core/src/sessions-dir.ts:94` (`resolveLiveSessionsDir`, while `env.ts:88` hard-codes `sessions/-Eva`); `packages/chat-core/src/frames.ts:81` (`cmd.cancelUi`, reducer builds the same object at `reducer.ts:185`); `apps/desktop/src/main/chat/session-manager.ts:94` (`has`); `packages/chat-core/src/reducer.ts:84` (`stderrLines`); `packages/contract/src/result.ts:4` (`ok`)
**Fix:** Wire `resolveLiveSessionsDir` into live `resolveEnv` or delete it; use `cmd.cancelUi`; drop or phase-tag the rest.

### IN-07: `SeqBatcher` `at` is captured at mark time, not flush time

**File:** `packages/chat-core/src/batcher.ts:36-38`, `:58-65`
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

New in iteration 2:

### IN-13: The tab-limit notice can be spammed by the active guest page

**File:** `apps/desktop/src/main/browser/browser-host.ts:112-117`, `:160-176`
**Issue:** Once 32 tabs exist, every further `target=_blank` click or `window.open` from the active tab still runs `setImmediate -> createTab -> emit('browser.notice')`, and `startBrowserStore` turns each into a Mantine notification. A runaway script on the active page can raise hundreds per second; nothing is created, but the shell fills with toasts.
**Fix:** Emit the notice at most once per second (keep a `lastNoticeAt`), or only for user-initiated creations (`browser.createTab`, hotkey) and deny silently in the window-open handler.

### IN-14: Extension tabs lose their `fromExtension` status on retry and cannot navigate between their own pages

**File:** `apps/desktop/src/main/browser/browser-host.ts:187-195`, `:280-284`
**Issue:** `reload()` on an errored tab calls `navigate(id, t.state.url)` without the `fromExtension` option, so a `chrome-extension:` page that failed to load gets the "cannot be opened here" card on retry. The `will-navigate` guard also uses `LOADABLE_PROTOCOLS` alone, so a page-initiated `chrome-extension:` to `chrome-extension:` navigation (an extension options page linking to another of its pages) is blocked even in a tab the extension host opened. Hash-routed extension UIs (Bitwarden's popout) are unaffected, which is why the e2e passes.
**Fix:** Remember `fromExtension` on the `Tab`, pass it from `reload()`, and let `guard` accept `chrome-extension:` when `tab.fromExtension` is set.

### IN-15: A stale `clearLabel` timer can clear the label of a later resync, and fires after `dispose()`

**File:** `apps/desktop/src/renderer/chat/stream-drain.ts:72-77`, `:86-92`
**Issue:** `clearLabel` schedules `setReconnecting(paneId, false)` after `minReconnect`. If a second gap starts a new resync before that timer fires, the old timer takes the new resync's label down early; after `dispose()` the timer still calls into the store. Cosmetic.
**Fix:** Guard the deferred clear with `if (disposed || resyncing.has(paneId)) return`.

### IN-16: Login-shell PATH probe takes the whole stdout, including anything the rc files print

**File:** `apps/desktop/src/main/chat/shell-path.ts:12-21`
**Issue:** `$SHELL -ilc 'echo -n "$PATH"'` runs the interactive rc files; any `echo`, banner or tool that prints during startup lands in `stdout` ahead of the path and becomes the first PATH entries for every omp spawn. The research notes in CLAUDE.md suggest the same probe, so this is a note for robustness rather than a deviation.
**Fix:** Use the last line of stdout (`stdout.trim().split('\n').pop()`), or run with `-lc` and fall back to `-ilc` only when the result lacks the expected omp directory.

---

_Reviewed: 2026-10-15T06:23:39Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
_Iteration: 2_
