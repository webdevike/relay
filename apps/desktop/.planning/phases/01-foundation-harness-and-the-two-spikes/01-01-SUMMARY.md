---
phase: 01-foundation-harness-and-the-two-spikes
plan: 01
subsystem: infra
tags: [electron, electron-vite, pnpm, zod, vitest, playwright, mantine]
requires: []
provides:
  - pnpm 12 workspace (apps/desktop + packages contract, chat-core, eva-core, browser-core) with the full Phase 1 dependency set locked
  - BaseWindow + sandboxed shell WebContentsView rendering the three-column spike layout
  - Typed Zod IPC contract (app.info) with senderFrame check and CJS preload bridge
  - EVAOS_* environment contract, atomic ConfigStore, test hooks, seams for chat/browser/write-guard
  - Vitest projects, Playwright _electron skeleton spec, pnpm gate (GATE GREEN)
affects: [01-02, 01-03, 01-05, 01-07, 01-08, 01-09, 01-10]
tech-stack:
  added: [electron 44.7.2, electron-vite 6.0.0, vite 8.3.4, react 19.3.1, mantine 9.7.2, zod 4.6.7, vitest 5.0.4, playwright 1.64.1, pnpm 12.11.2]
  patterns: [feature-owned contract files, subpath package exports, Result values over IPC, repo-local corepack shim]
key-files:
  created:
    - pnpm-workspace.yaml
    - scripts/env.sh
    - scripts/gate.sh
    - scripts/lint-em-dash.ts
    - packages/contract/src/index.ts
    - apps/desktop/src/main/index.ts
    - apps/desktop/src/main/env.ts
    - apps/desktop/src/main/ipc/handle.ts
    - apps/desktop/src/main/window.ts
    - apps/desktop/src/preload/bridge.ts
    - apps/desktop/e2e/skeleton.spec.ts
  modified:
    - package.json
key-decisions:
  - "BaseWindow + shell WebContentsView works with Playwright firstWindow(); no BrowserWindow fallback needed (D-06)"
  - "pnpm 12 uses allowBuilds in pnpm-workspace.yaml instead of onlyBuiltDependencies (D-03 wording obsolete)"
  - "Preload bridge split into bridge.ts (pure, testable) and index.ts (contextBridge call)"
requirements-completed: [FOUND-01, FOUND-02, FOUND-04, FOUND-05, FOUND-07, FOUND-08]
duration: 40min
completed: 2026-10-15
---

# Phase 1 Plan 01: Walking Skeleton Summary

**pnpm workspace with an electron-vite app that opens a BaseWindow + sandboxed shell view, round-trips a Zod-validated `app.info` IPC call, and passes a green `pnpm gate` (typecheck, eslint, prettier, em-dash lint, Vitest, build, Playwright e2e).**

## Accomplishments
- Workspace installed once with the full Phase 1 dependency set (exact pins verified resolvable with `npm view`), `node_modules/.bin/gsd-sdk` preserved.
- Skeleton e2e (shell visible, `window.eva.invoke` is a function, `app.info` returns fixture root and temp config dir, `app-state.json` written, one BaseWindow, zero console errors in renderer and main) passes.
- Vitest projects run: contract, main, preload, renderer, scripts (plus empty packages with passWithNoTests).
- `pnpm dev` smoke-checked for 15 s: dev server and electron start with no errors.

## Task Commits
1. Task 1: workspace, toolchain, deps, failing e2e - `21d25b4`
2. Task 2: BaseWindow shell, env, config store, app.info round trip - `3e78f7a`
3. Task 3: em-dash lint and gate - `3eebbe7`

## Decisions Made
- BaseWindow outcome (D-06): works as expected, Playwright `firstWindow()` returns the shell page; no fallback.
- `allowBuilds: { electron-winstaller: false }` replaces D-03's `onlyBuiltDependencies`. Electron 44 needs no entry. pnpm auto-wrote `minimumReleaseAgeExclude`: `@playwright/test@1.64.1`, `electron-vite@6.0.0`, `playwright-core@1.64.1`, `playwright@1.64.1`, `react-dom@19.3.1`, `react@19.3.1`.
- All version pins resolved as specified (no D-02 deviations). `@types/node` pinned `^24` to match the Electron Node runtime.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Placeholder app sources in Task 1**
- **Found during:** Task 1 verification (plan expects `electron-vite build` to pass before app code exists)
- **Fix:** committed minimal stubs for main, preload and renderer index.html, replaced in Task 2. The e2e is still red for the right reason (app quits, no window).

**2. [Rule 1 - Bug] ESLint failures on the skeleton**
- **Found during:** Task 3 gate run
- **Fix:** `eslint.config.mjs` now allows `_`-prefixed unused args/vars and Playwright's empty object fixture pattern.

**3. [Rule 1 - Bug] Dev dependency scan could not resolve the renderer input**
- **Found during:** `pnpm dev` smoke
- **Fix:** renderer `input` made absolute with `resolve(__dirname, ...)` in `electron.vite.config.ts`.

**4. [Rule 2 - Missing critical] Dev-only CSP relaxation plugin**
- Strict CSP stays in `index.html`; a small Vite `transformIndexHtml` plugin relaxes script/connect sources only under the dev server.

**5. Root `package.json` gets `"type": "module"`**
- Plan said no `type` field for the root; added so `node scripts/lint-em-dash.ts` does not emit a module-type warning. `apps/desktop` has no `type` field (CJS preload requirement holds: `out/preload/index.js`).

**6. Preload split into `bridge.ts` + `index.ts`**
- Lets the channel guard be unit-tested without Electron.

## Known Stubs
- `registerChat`, `registerBrowser`, `installWriteGuard`, `chatInvoke/browserInvoke` maps, ChatPane and BrowserPanel bodies are intentional empty seams, filled by plans 01-02, 01-03, 01-05, 01-07..01-09. The skeleton does not render the Test overlay button yet (UI-SPEC rail item for D-08); plan 01-07/08 adds it.

## Next Phase Readiness
Seams are ready for 01-02 (write guard, sentinel) and the chat and browser slices. Gate sentinel/packaged-smoke markers are in `scripts/gate.sh`.

## Self-Check: PASSED
