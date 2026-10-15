---
phase: 01-foundation-harness-and-the-two-spikes
reviewed: 2026-10-15T05:55:23Z
depth: standard
files_reviewed: 101
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
  critical: 1
  warning: 8
  info: 12
  total: 21
status: issues_found
---

# Phase 1: Code Review Report

**Reviewed:** 2026-10-15T05:55:23Z
**Depth:** standard
**Files Reviewed:** 101
**Status:** issues_found

## Summary

All 101 listed files were read in full. The trust boundaries called out for this phase hold up well: the IPC `handle()` wrapper validates input with Zod and checks the sender frame; the preload exposes one `window.eva` object and filters channels; guest views run sandboxed in `persist:browser` with every permission denied; `resolveInsideSessionsDir` does a correct realpath-plus-separator containment check; the omp transport never signals the child; Arc cookie values are never logged or persisted outside the guest session; `eva-core` write containment and the runtime write trap are sound; no em dash appears in any UI string.

The defects found are concentrated in the live-chat sequencing path (the phase's core value) and in a few hardening gaps around the browser panel:

- **Critical:** the renderer stream drain can enter an unbounded resync loop whenever a batch arrives whose `seq` is greater than the seq of the snapshot it then fetches. The session manager produces exactly such a batch when a pane is reopened on a different file while an omp process is still live (the old batcher flushes late under the same `paneId`).
- **Warnings:** double `_eof` emission on spawn failure (verified: Node emits `error` and then `close` for ENOENT), a send-during-spawn race that bricks the pane, a resync path that never clears the "Reconnecting" label, two prefix checks in `isAppUrl` without a separator, an address-bar bypass of the guest protocol allow-list, stale titles persisted into browser history, no cap on guest-created tabs, and prompt text lost on a failed send.
- **Info:** mostly dead code, unused forward-looking exports, a lint scope gap, and small robustness notes.

Deliberate Phase 1 stubs (no reopen UI, no transport for other agents, EvaFs with no callers) were not reported as bugs.

## Critical Issues

### CR-01: Stream drain loops forever when a held batch's seq is ahead of the snapshot; session reopen produces exactly that batch

**File:** `apps/desktop/src/renderer/chat/stream-drain.ts:94-97` and `:128-136`; trigger in `apps/desktop/src/main/chat/session-manager.ts:69-89` and `:168-201`
**Issue:** `resync()` fetches a snapshot, applies it, then replays every stashed batch through `push()`. `push()` compares the batch seq to the snapshot seq: if `batch.seq <= last` it drops it, if `batch.seq === last + 1` it queues it, otherwise it calls `resync()` again and re-stashes the same batch. There is no retry cap and no rule that discards a batch that can never be reached. So any batch with `seq > snapshot.seq + 1` causes an infinite `requestSnapshot` IPC loop with the "Reconnecting to the stream." label stuck on.

The main process produces such a batch today. `SessionManager.open()` for a pane that already has a live transport on a different file calls `void this.release(existing)` and then replaces the pane entry with a fresh `SeqBatcher` (seq 0). `release()` keeps the old `Pane` object, awaits `t.close()` (up to 2 s), then applies `_eof` to the old reducer and calls `this.flush(pane)`, which emits a batch under the **same `paneId`** with the **old** batcher's seq (for example 57). The renderer has just run `openPane` (lastSeq 0), receives seq 57, resyncs, gets a snapshot from the new batcher (seq 0), replays seq 57, and loops. Phase 1 has no UI for reopening a live pane, but `chat.open` is a public IPC channel and the e2e harness calls it directly, so this is reachable.

**Fix:**

In `session-manager.ts`, make a released pane inert once it is no longer the registered pane for its id, and never let its batcher emit:

```ts
private async release(pane: Pane, timeoutMs = 2000): Promise<TransportExit | null> {
  const t = pane.transport
  if (!t) return null
  // ... existing teardown ...
  const exit = await t.close({ timeoutMs }).catch(() => null)
  // Only the pane still registered under this id may apply _eof and emit.
  if (this.panes.get(pane.paneId) !== pane) return exit
  if (exit && !exit.timedOut) {
    // ... existing _eof application and flush ...
  }
  return exit
}
```

In `stream-drain.ts`, make a gap unrecoverable-by-replay drop the batch instead of re-stashing, and bound retries:

```ts
.then((snap) => {
  // ...
  const held = (stash.get(paneId) ?? []).sort((a, b) => a.seq - b.seq)
  stash.delete(paneId)
  for (const b of held) {
    if (b.seq <= snap.seq) continue           // already in the snapshot
    if (b.seq === snap.seq + 1) { push(b); continue }
    // A held batch the snapshot cannot reach means main restarted its seq; drop it.
    statsOf(paneId).gaps += 1
    break
  }
})
```

Add a unit test in `stream-drain.test.ts` that pushes `{seq: 57}` against a snapshot `{seq: 0}` and asserts `requestSnapshot` is called once.

## Warnings

### WR-01: `_eof` emitted twice on spawn failure and applied twice on normal exit; `release()` races the `startTransport` failure path

**File:** `apps/desktop/src/main/chat/omp-transport.ts:98-117`; `apps/desktop/src/main/chat/session-manager.ts:150-154`, `:183-199`
**Issue:** For a spawn that fails (ENOENT, EACCES), Node emits `error` and then `close` (verified locally: `error -> close:-2`). The transport emits `_eof` from the `error` handler (`code: null`) and again from the `close` handler (`code: -2`, with `framer.end()`). The first `_eof` is delivered synchronously while `onFrame` is still subscribed (the `catch` in `startTransport` runs on a later microtask), so the reducer sets `EOF_ERROR`, a batch is flushed, and `release()` is kicked off concurrently with `startTransport`'s own cleanup. The renderer then receives both an "ended unexpectedly" banner and a `spawn-failed` IPC error that overwrites it. On a normal exit, `onFrame` applies `_eof` once and then `release()` applies a second synthetic `_eof` (expected: true) and flushes a second batch; harmless today only because the reducer happens to be idempotent for that frame.
**Fix:** Emit `_eof` from one place only. In `start()`, drop the `this.emit({ type: '_eof' ... })` from the `error` handler (the `close` handler already covers it), or set a `eofSent` flag checked by both. In `SessionManager.onFrame`, when the frame is `_eof`, call a `detach(pane)` that clears the timer, unsubscribes and drops the owner without calling `t.close()` or re-applying `_eof`:

```ts
if (frame.type === '_eof') {
  pane.batcher.markMeta({ connected: false, running: false })
  this.flush(pane)
  this.detach(pane) // timer, unsubscribe, transport = null, owners.delete; no close(), no second _eof
}
```

### WR-02: Second `send` during spawn hits a null child and bricks the pane

**File:** `apps/desktop/src/main/chat/session-manager.ts:101-107`; `apps/desktop/src/main/chat/omp-transport.ts:55-74`, `:120-126`
**Issue:** `startTransport` assigns `pane.transport` before `await transport.start()`. `start()` first awaits `resolveSpawnPath()` (up to 3 s in live mode on the first spawn) before it spawns. A second `chat.send` arriving in that window sees `pane.transport` set, skips `startTransport`, and calls `transport.send()`; `write()` finds `this.child` null and rejects with "The session is not running." That becomes an `internal` IPC error, `Composer` calls `setError`, and `ChatPane` disables the composer permanently (`unavailable = pane.error !== null`) with no recovery UI. The first prompt's unconfirmed row also stays in the list.
**Fix:** Keep a `starting: Promise<void> | null` on the pane and await it:

```ts
async send(paneId: string, text: string): Promise<void> {
  const pane = this.pane(paneId)
  if (!pane.transport) pane.starting ??= this.startTransport(pane).finally(() => { pane.starting = null })
  await pane.starting
  // ...
}
```

### WR-03: Resync leaves `reconnecting: true` forever and leaks the stash when the snapshot fails or returns null

**File:** `apps/desktop/src/renderer/chat/stream-drain.ts:78-101`
**Issue:** When `requestSnapshot` resolves `null` (`chat.snapshot` returned `ok: false`, for example `no-session`) the code returns before `setReconnecting(paneId, false)`; when it rejects, the `.catch` only clears `resyncing`. In both cases the "Reconnecting to the stream." label stays on and `stash.get(paneId)` is never drained or deleted, so stashed batches accumulate until the next successful resync.
**Fix:** Clear the label and the stash on every exit path:

```ts
.then((snap) => { if (disposed) return; resyncing.delete(paneId); if (!snap) { fail(paneId); return } /* ... */ })
.catch(() => { resyncing.delete(paneId); fail(paneId) })
// where
const fail = (paneId: string): void => { stash.delete(paneId); opts.store.getState().setReconnecting(paneId, false) }
```

### WR-04: `isAppUrl` prefix checks have no separator, so sibling paths and look-alike hosts pass

**File:** `apps/desktop/src/main/window.ts:9-14`
**Issue:** `url.startsWith(new URL(dev).origin)` accepts `http://localhost:5173.evil.example/...` (origin is `http://localhost:5173` with no trailing slash), and `url.startsWith(pathToFileURL(rendererDir).href)` accepts `file:///.../out/renderer-anything/x.html` because the href has no trailing `/`. This function is the sender check for every IPC handler and the `will-navigate` guard for the shell. Exploitability is low today (only the shell has the preload, and the shell cannot navigate away), but it is the one gate that protects the IPC surface and should be exact.
**Fix:**

```ts
export function isAppUrl(url: string | undefined): boolean {
  if (!url) return false
  const dev = process.env.ELECTRON_RENDERER_URL
  if (dev) { const o = new URL(dev).origin; return url === o || url.startsWith(o + '/') }
  const base = pathToFileURL(rendererDir).href + '/'
  return url.startsWith(base)
}
```

### WR-05: Address bar and extension `createTab` bypass the guest protocol allow-list

**File:** `apps/desktop/src/main/browser/browser-host.ts:171-179` (guard) vs `:233-243` (`navigate`); `apps/desktop/src/main/browser/browser-ipc.ts:12-18`, `:33-36`; `apps/desktop/src/main/browser/extensions.ts:44-49`; `packages/browser-core/src/address.ts:10`
**Issue:** `ALLOWED_PROTOCOLS` (`http:`, `https:`, `about:`) is enforced only on `will-navigate` / `will-redirect`, which fire for page-initiated navigations. `host.navigate()` calls `loadURL` directly, and `normalize()` returns any input containing `://` verbatim, so typing `file:///Users/ike/Eva/memory/facts.md` or `chrome://settings` into the address bar loads it inside the guest view (in the partition that will hold imported Arc cookies). The extension `createTab` callback likewise passes `details.url` with no check. The result is an inconsistent policy: a link to `file://` on a page is blocked, the same URL typed in the bar is loaded.
**Fix:** Apply the allow-list in `navigate()` and `createTab()` (the single choke points), and surface a `blank`/error state instead of loading:

```ts
navigate(tabId: string, url: string): void {
  const t = this.tab(tabId)
  let proto = ''
  try { proto = new URL(url).protocol } catch { /* fallthrough */ }
  if (!ALLOWED_PROTOCOLS.has(proto)) {
    t.state.error = { host: hostOf(url), code: -300 } // ERR_INVALID_URL
    this.changed(); return
  }
  // ...
}
```

### WR-06: `did-navigate` records history with the previous page's title

**File:** `apps/desktop/src/main/browser/browser-host.ts:194-202`; `packages/browser-core/src/history.ts:34-38`
**Issue:** `nav(url, true)` calls `this.history.visit(url, s.title)` at `did-navigate` time, when `s.title` still holds the **previous** page's title (`page-title-updated` fires later). `addVisit` replaces the stored title whenever the incoming title is non-empty, so every navigation first writes the wrong title for the new URL. It is corrected only if `page-title-updated` fires with a non-empty title; pages that set no title, or an immediate `flush()` (500 ms timer, or `dispose()` on quit), persist the wrong title into `browser-history.json`, and `suggest()` then matches the new URL against the old page's words.
**Fix:** Count the visit with an empty title and let `page-title-updated` supply it:

```ts
if (counted) this.history.visit(url, '')
```
and reset `s.title = ''` in `nav()` so the tab strip does not show the old title during load.

### WR-07: No cap on tabs a guest page can create

**File:** `apps/desktop/src/main/browser/browser-host.ts:145-160`; `packages/contract/src/browser.ts:3`
**Issue:** Every `foreground-tab` / `background-tab` disposition with an http(s) URL becomes a new `WebContentsView` via `setImmediate`. A hostile page (or a runaway script clicking `target=_blank` anchors) can create an unbounded number of views, each a full renderer process; the shell receives a `browser.tabs` snapshot per creation. There is no upper bound and no per-page rate limit. Separately, `TabIdSchema` is `^t[0-9]{1,6}$`, so after a million tab ids the renderer can no longer address tabs; harmless in practice but the two limits are unrelated.
**Fix:** Add a `MAX_TABS` (for example 32) checked in `createTab()`, and in the window-open handler only honour openers that are the active tab:

```ts
if (this.order.length >= MAX_TABS) return { ...currentActiveState }
```
and in `setWindowOpenHandler`: `if (tab.id !== this.activeId) return { action: 'deny' }`.

### WR-08: A failed send loses the prompt text and leaves an unconfirmed row behind

**File:** `apps/desktop/src/renderer/chat/Composer.tsx:20-26`; `apps/desktop/src/main/chat/session-manager.ts:104-106`
**Issue:** `Composer.send` calls `setText('')` before awaiting `chat.send`; on `!r.ok` the user's text is gone and only a banner is shown. On the main side, `send()` pushes the unconfirmed row and marks it for upsert before `transport.send()`; if the write rejects (EPIPE after omp exited, or WR-02), the row stays in the reducer forever because nothing removes it on that path.
**Fix:** Clear the field only after success (`if (r.ok) setText('')` or restore on failure), and in `SessionManager.send` wrap the transport write:

```ts
try { await pane.transport!.send(tagged(text, this.deps.machineLabel)) }
catch (e) { pane.reducer.dropUnconfirmedRow(row.id); pane.batcher.markRemove(row.id); throw e }
```

## Info

### IN-01: Em dash lint does not scan `apps/desktop/src/main/**`

**File:** `scripts/lint-em-dash.ts:43-46`
**Issue:** Renderer-facing strings live in main too (`ALREADY_OWNED` in `session-manager.ts:19`, Arc failure reasons in `arc-import.ts`, "The session is not running." in `omp-transport.ts:125`). They are currently clean, but the project rule is unenforced there.
**Fix:** Add `fs.globSync('apps/desktop/src/main/**/*.ts')` to the file list.

### IN-02: IPC output validation only runs in dev, and `.parse` strips unknown keys

**File:** `apps/desktop/src/main/ipc/handle.ts:35`
**Issue:** In dev the output passes through `entry.output.parse(value)`, which strips unknown object keys; packaged builds return the raw handler value. Tests therefore exercise a slightly different payload shape than what ships.
**Fix:** Either validate in both modes (cost is small at these payload sizes) or use `safeParse` for a dev-only assertion and always return `value`.

### IN-03: Address input text is overwritten by any URL change, including in-page navigation

**File:** `apps/desktop/src/renderer/browser/AddressRow.tsx:98-99`
**Issue:** `useEffect(() => setText(url), [url])` resets what the user is typing whenever the page changes its hash or pushes state.
**Fix:** Skip the reset while the input is focused (`document.activeElement === input.current`).

### IN-04: `CodedError` is defined twice

**File:** `apps/desktop/src/main/chat/transcript-ipc.ts:8-15`; `apps/desktop/src/main/chat/session-manager.ts:10-17`
**Issue:** Identical class in two modules; the first is not exported.
**Fix:** Import `CodedError` from `session-manager.ts` (or move it to `ipc/handle.ts`).

### IN-05: Dead code

**File:** `apps/desktop/src/main/browser/history-store.ts:15-16` (`counted` set is never read or written); `apps/desktop/src/main/chat/session-manager.ts:183` (`&& pane.batcher` is always true)
**Fix:** Remove both.

### IN-06: Unused exports

**File:** `apps/desktop/src/main/browser/extensions.ts:19` (`getExtensionHost`); `packages/chat-core/src/sessions-dir.ts:94` (`resolveLiveSessionsDir`, the env resolver hard-codes `sessions/-Eva` instead); `packages/chat-core/src/frames.ts:81` (`cmd.cancelUi`, the reducer builds the same object inline at `reducer.ts:177`); `apps/desktop/src/main/chat/session-manager.ts:91` (`has`); `packages/chat-core/src/reducer.ts:84` (`stderrLines`, stderr is collected but never surfaced); `packages/contract/src/result.ts:4` (`ok`)
**Issue:** Some are forward stubs for later phases; `resolveLiveSessionsDir` in particular duplicates the Rust `omp_sessions_dir` logic that `env.ts:88` ignores, so the live sessions dir may differ from what the Rust app uses.
**Fix:** Either wire `resolveLiveSessionsDir` into `resolveEnv` for live mode or delete it; use `cmd.cancelUi` in the reducer; drop the rest or mark them with a phase reference.

### IN-07: `SeqBatcher` `at` is captured at mark time, not flush time

**File:** `packages/chat-core/src/batcher.ts:36-38`, `:58-65`; `apps/desktop/src/main/chat/session-manager.ts:143-147`
**Issue:** `at` is the row index when `markUpsert` ran. If a later frame in the same 16 ms window removes a row **before** that index, the renderer inserts the new row one slot too late. Today this cannot happen because the reducer only removes tail rows (unconfirmed prompts) and owned rows are stable, but that invariant is not stated anywhere and the core value is "no reordered tokens".
**Fix:** Recompute `at` for new ids at `flush()` time from the reducer (pass an `indexOf` callback), or document the append-only invariant next to `markUpsert`.

### IN-08: Guest favicons load in the privileged shell renderer on the default session

**File:** `apps/desktop/src/renderer/browser/TabStrip.tsx:34`; `apps/desktop/src/renderer/index.html` CSP `img-src ... http: https:`
**Issue:** `<img src={t.favicon}>` fetches a guest-controlled URL from the shell's (default) session, so the request carries no guest cookies but does reveal the shell to the remote host and decodes remote images in the app's renderer process.
**Fix:** Have main fetch the favicon in the guest session and hand the renderer a `data:` URL, or serve it through a custom protocol; then drop `http: https:` from `img-src`.

### IN-09: Preload surface is wider than the comment claims

**File:** `apps/desktop/src/preload/index.ts:7-8`
**Issue:** `injectBrowserAction()` exposes electron-chrome-extensions' own `contextBridge` object and IPC channels in addition to `window.eva`. The comment "nothing else is added to the bridge" is inaccurate, and those channels are not covered by the `isAppUrl` sender check in `handle.ts`.
**Fix:** Correct the comment and note in the threat model that the extension library's browser-action IPC is a second, library-owned bridge.

### IN-10: Recording scrubber rewrites `id` but not `toolCallId`

**File:** `scripts/scrub-recording.mjs:32`
**Issue:** Every `id` key becomes `fixture-id` while `toolCallId` is untouched, so a recorded turn that used tools would have tool rows whose results never attach. Current recordings use `--no-tools`, so this is latent.
**Fix:** Scrub `id` only on frame objects (`type` present), or map `id`/`toolCallId` through the same per-value table.

### IN-11: Gate tooling side effects and hard-coded paths

**File:** `scripts/check-metrics.ts:52-55` (a "check" script rewrites `metrics.json`); `scripts/sentinel.ts:11` (absolute `/Users/ike/...` repo list)
**Fix:** Move the note injection to the writer in `e2e/helpers/metrics.ts`; derive the sentinel repo list from `EVAOS_EVA_ROOT` / `os.homedir()`.

### IN-12: `tabId` is referenced before its declaration

**File:** `apps/desktop/src/renderer/browser/AddressRow.tsx:72-76` vs `:100`
**Issue:** `go()` closes over `tabId`, which is declared 28 lines later. It is TDZ-safe because `go` only runs after render, but it reads as a bug.
**Fix:** Move `const tabId = tab?.id` above `go`.

---

_Reviewed: 2026-10-15T05:55:23Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
