---
phase: 02-shell-navigation-and-theme-tokens
fixed_at: 2026-10-15T00:00:00Z
review_path: .planning/phases/02-shell-navigation-and-theme-tokens/02-REVIEW.md
iteration: 1
findings_in_scope: 9
fixed: 9
skipped: 0
status: all_fixed
---

# Phase 2: Code Review Fix Report

**Source review:** 02-REVIEW.md. **Scope:** Critical and Warning (Info skipped).
**Gate:** `bash scripts/gate.sh` ended GATE GREEN (typecheck, eslint, prettier, em-dash lint, vitest, build, e2e, packaged smoke).

Note: work was done directly on `main` rather than a separate worktree (no concurrent foreground session; a worktree would lack node_modules for the gate).

## Fixed Issues

### CR-01: Quit guard fails open
**Commits:** 1460b45, 09eb5d9
**Files:** `apps/desktop/src/main/quit-guard.ts`, `quit-guard.test.ts`, `renderer/dirty/dirty-store.ts`, `e2e/quit-guard.spec.ts`
Reply timeout now resolves to `null`; the guard treats `null` as unknown and asks the user (confirm dialog with generic detail, Cancel keeps the app open). `listDirty` and `saveAllDirty` truncate ids and labels to 200 chars and cap at 100 entries so replies are never rejected by the contract. Unit test updated to the fail-closed behaviour. The e2e "nothing dirty" test now waits for the renderer (it had only passed because silence used to mean "nothing dirty"). Status: fixed, requires human verification (logic change).

### CR-02: Corrupt config read as `{}` then overwritten
**Commit:** 11bab50
**Files:** `main/config-store.ts`, `theme-ipc.ts`, `settings-ipc.ts`, `config-ipc.test.ts`
Added `ConfigStore.readForMerge`: missing file gives `{}`, unreadable file throws (writer aborts), unparseable or non-object content is copied to `<name>.bad` before the merge-write. Used by `patchApp` and `saveSettings`. Tests added. Status: fixed, requires human verification.

### WR-01: Silent tab persistence failures
**Commit:** 140259b
**Files:** `packages/shell-core/src/tabs.ts`, `tabs.test.ts`, `renderer/tabs/tabs-store.ts`, `tabs-store.test.ts`, `renderer/shell/layout-store.ts`
A `{ok:false}` reply now resets `lastSaved` so the next change retries. `saveTabs` caps tabs at 100 and history at 50 to match the contract and clamps `active`. Width saves log failures. Tests added. Not addressed: the per-place `page` 200 char cap (page keys are short enums).

### WR-02: Pending tab changes lost on quit
**Commit:** 89030e8
**Files:** `renderer/tabs/tabs-store.ts`, `tabs-store.test.ts`, `renderer/dirty/quit-bridge.ts`
Exported `flushPendingTabs`, called on the quit request and on `pagehide`. Test added.

### WR-03: Held chords auto-repeat
**Commit:** f6fbc64
**Files:** `renderer/hotkeys/router.ts`, `router.test.tsx`
`onKeyDown` ignores `e.repeat`. Test added.

### WR-04: Grip leaves body stuck resizing
**Commit:** e826e86
**Files:** `renderer/shell/Grip.tsx`, `Grip.test.tsx`
Effect cleanup resets `userSelect` and the `eva-resizing` class. Test added.

### WR-05: Window never shown on load failure
**Commit:** 0606be6
**Files:** `main/window.ts`
`did-fail-load` (main frame, not ERR_ABORTED) shows the window and an error box; a 10 s fallback timer shows it otherwise; `loadURL`/`loadFile` rejections are handled. No unit test (Electron window code, covered by e2e).

### WR-06: Startup failure leaves windowless app
**Commit:** a295972
**Files:** `main/index.ts`
`whenReady` body wrapped in try/catch with `dialog.showErrorBox` and `app.exit(2)`.

### WR-07: Pinned tab closable from context menu
**Commit:** 0a4723b
**Files:** `renderer/tabs/TabBar.tsx`, `TabBar.test.tsx`
"Close tab" menu item disabled for pinned tabs. Test added.

## Notes

- One gate run failed on `e2e/browser-basic.spec.ts` (bounds equality, timing); it passed 3 of 3 in isolation and in the next full gate. Treated as pre-existing flakiness under load, unrelated to these fixes.
- Info findings IN-01..IN-03 were out of scope.

---

_Fixer: Claude (gsd-code-fixer)_
_Iteration: 1_
