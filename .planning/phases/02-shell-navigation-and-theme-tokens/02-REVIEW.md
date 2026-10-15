---
phase: 02-shell-navigation-and-theme-tokens
reviewed: 2026-10-15T00:00:00Z
depth: standard
files_reviewed: 94
files_reviewed_list:
  - (see /tmp/p2r.txt; 94 .ts/.tsx files across apps/desktop/src/main, apps/desktop/src/renderer, packages/shell-core, theme-core, eva-core, contract)
findings:
  critical: 2
  warning: 7
  info: 3
  total: 12
status: issues_found
---

# Phase 2: Code Review Report

**Reviewed:** 2026-10-15
**Depth:** standard
**Files Reviewed:** 94

## Summary

Priority files were read in full (main process, IPC handler, quit guard, config store, write queue, layout/theme/settings IPC, hotkey router, scopes, chord, tabs reducer, tabs/layout/theme/dirty/sidebar/settings stores, browser host, Grip, TabBar). Remaining presentational components were skimmed. The IPC trust boundary (sender URL check, Zod input validation, no ipcRenderer leak) is sound. The main defects are in the quit guard (fail-open data loss), silent persistence failures, and destructive reads of corrupt config files.

## Critical Issues

### CR-01: Quit guard fails open and can discard unsaved edits silently

**File:** `apps/desktop/src/main/quit-guard.ts:124-129` (with `packages/contract/src/app.ts:25-52`, `apps/desktop/src/renderer/dirty/dirty-store.ts:33-35`)
**Issue:** `askEdits` resolves to `[]` after 2000 ms and `run()` treats `[]` as "nothing dirty", so quit proceeds. Three ways this loses data:
1. The renderer's reply is rejected by the contract (`label`/`id` `.max(200)`, `entries` `.max(100)`). `listDirty()` does not truncate labels or cap entries, so a long label or more than 100 dirty entries yields `invalid-input`, the reply never resolves the registry, and after 2 s the app quits without prompting.
2. A busy or hung renderer (long main-thread task) misses the 2 s window with the same result.
3. For the save path, a failure entry with `label` or `id` over 200 chars is rejected and surfaces as a 30 s "Save timed out", which is misleading.
**Fix:** Fail closed. Distinguish timeout from empty: `request` should resolve to `null` on timeout, and the guard should treat `null` as "unknown, ask the user" (show the confirm dialog with a generic detail, or cancel the quit). Truncate in the renderer before replying:
```ts
const entries = listDirty().slice(0, 100).map(e => ({ id: e.id.slice(0,200), label: e.label.slice(0,200) }))
```
Apply the same truncation to `saveAllDirty` failures (id and label).

### CR-02: Corrupt config JSON is read as `{}` and then overwritten, destroying user data

**File:** `apps/desktop/src/main/config-store.ts:26-32`, `theme-ipc.ts:16-25`, `settings-ipc.ts:16-33`
**Issue:** `readJson` swallows every error (parse errors, EACCES, EIO) and returns the fallback. `patchApp` and `saveSettings` then merge into that empty object and write it back. A momentarily unreadable or hand-edited-invalid `theme.json` or `settings.json` loses every other key (theme edits, unknown keys the Rust app owns) on the next appearance toggle or background report. `app.setBackground` runs on every theme apply, so this triggers at launch with no user action. `readText` already distinguishes ENOENT; `layout-ipc` only discards a bad file deliberately and surfaces `reset`.
**Fix:** In the merge-write paths, use `readText`; on ENOENT start from `{}`, on a parse error back up the file (`theme.json.bad`) or refuse to write and surface an error. Do not let `readJson` fallbacks feed writers.

## Warnings

### WR-01: Tab persistence failures are silent and unbounded tabs can never save

**File:** `apps/desktop/src/renderer/tabs/tabs-store.ts:80-88`, `packages/contract/src/shell.ts:21-24`
**Issue:** `invoke` returns a `Result` and never rejects, so the `.catch` that resets `lastSaved` never fires. A `{ok:false}` reply is ignored, `lastSaved` stays equal to the unsaved JSON, and the save is never retried. `SavedTabsSchema` caps `list` at 100 and each place `page` at 200, while `openNewChat` and `loadTabs` are unbounded, so after 100 tabs (or a long saved layout) every save is rejected silently. `layout.save` `sidebarWidth`/`panelWidth` calls in `layout-store.ts:110-123` also ignore the result.
**Fix:** Check `r.ok` and reset `lastSaved = ''` on failure (and retry on next change); cap tabs in `openNewChat` or truncate in `saveTabs`/`loadTabs` to match the schema.

### WR-02: Pending tab changes are lost on quit (250 ms debounce, no flush)

**File:** `apps/desktop/src/renderer/tabs/tabs-store.ts:91-96`
**Issue:** A tab change made within 250 ms of Cmd+Q or window close is never written; the timer dies with the renderer. Nothing registers a flush on `beforeunload` or in the quit bridge.
**Fix:** Flush synchronously (fire `layout.save`) from the quit bridge's `app.unsavedEdits.request` handler or `pagehide`, or register the pending tab save as a dirty entry.

### WR-03: Held chords auto-repeat in the renderer router

**File:** `apps/desktop/src/renderer/hotkeys/router.ts:94-102`, `packages/shell-core/src/chord.ts:58-61`
**Issue:** `chordOfInput` drops `isAutoRepeat`, but the renderer path uses `chordOf`, which ignores `e.repeat`. Holding Cmd+T opens tabs continuously, Cmd+W closes tabs until none remain, Cmd+[ walks history. The guest path (main) correctly drops repeats, so behaviour differs by focus.
**Fix:** In `onKeyDown`: `if (e.isComposing || e.repeat) return` (keep repeat for no chord, but never dispatch repeats).

### WR-04: Grip leaves the body stuck in resizing state if unmounted mid-drag

**File:** `apps/desktop/src/renderer/shell/Grip.tsx:18-51`
**Issue:** `eva-resizing` class and `userSelect = 'none'` are reset only inside `up`. If the grip unmounts during a drag (Cmd+B hides the sidebar so `state !== 'open'`, or any navigation that unmounts the shell), the effect cleanup removes listeners but never resets those, leaving text selection disabled app-wide and the resize cursor active. `useOccludeBrowser` also depends on cleanup, which does run, but the DOM state does not.
**Fix:** Reset `document.body.style.userSelect` and remove the class in the effect cleanup as well.

### WR-05: Window may never be shown if the renderer fails to load

**File:** `apps/desktop/src/main/window.ts:47-52`
**Issue:** Outside e2e the window is `show: false` and shown only on `did-finish-load`. If `loadFile`/`loadURL` fails (bad build, dev server down), `did-finish-load` never fires; the app runs as an invisible process with no dock window and no error, and `loadURL` rejections are voided.
**Fix:** Handle `did-fail-load` (show window and an error, or `dialog.showErrorBox` and exit) and add a fallback show timer.

### WR-06: Startup failure after env load leaves a windowless app

**File:** `apps/desktop/src/main/index.ts:39-80`
**Issue:** The `whenReady` callback has no error handling. `createConfigStore` (`mkdirSync`), `writeJson('app-state.json')`, or any `register*` throwing (unwritable config dir) rejects an unhandled promise after `bootstrap` already considered startup fine; the process stays alive without a window or IPC.
**Fix:** Wrap the body in try/catch mirroring the `loadEnv` handling (`dialog.showErrorBox`, `app.exit(2)`).

### WR-07: Pinned tabs can be closed from the context menu while every other path protects them

**File:** `apps/desktop/src/renderer/tabs/TabBar.tsx:237-243` (cf. `tabs.ts:217-220`, `TabBar.tsx:96`)
**Issue:** `closeActive` and middle click refuse pinned tabs; the context menu "Close tab" calls `close(menuTab.id)` unconditionally, and `closeTab` has no pinned guard. Inconsistent and a likely accidental-loss path.
**Fix:** Disable the menu item (or hide it) when `menuTab.pinned`, or enforce the guard in a single place (`closeTab` caller).

## Info

### IN-01: Saved tab and place extra fields are dropped on write

**File:** `packages/shell-core/src/place.ts:105-112`, `tabs.ts:116-126`
**Issue:** The contract uses `.passthrough()` and the comment says layout.json stays interchangeable with the Rust app, but `placeToJson`/`saveTabs` emit only known fields, so keys the Rust app adds to tabs or places are erased the first time EvaOS saves.
**Fix:** Carry unknown fields through the `Tab`/`Place` model or document the loss as accepted.

### IN-02: `Env.arcExportCmd` typed nullable but never null

**File:** `apps/desktop/src/main/env.ts:10,51-62`
**Issue:** `parseArcCmd` returns `DEFAULT_ARC_CMD` or an array or throws; `null` is unreachable, so callers carry dead null branches. Also `EVAOS_SESSIONS_DIR` and `EVAOS_OMP_BIN` are not covered by the real-root guard that protects `evaRoot` in dev/test.
**Fix:** Tighten the type to `string[]`; apply an equivalent real-path refusal to sessions dir in non-live mode.

### IN-03: Startup and boot paths lack error containment

**File:** `apps/desktop/src/renderer/main.tsx:15-32`, `apps/desktop/src/renderer/tabs/tabs-store.ts:98-113`
**Issue:** `void start()` has no catch (a throw in `initTheme` leaves a blank window). A user navigation made before `layout.load` resolves is overwritten when saved tabs arrive.
**Fix:** `start().catch(...)` rendering a minimal fallback; merge or skip loaded tabs if the user has already navigated.

---

_Reviewed: 2026-10-15_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
