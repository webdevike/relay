---
phase: 02-shell-navigation-and-theme-tokens
plan: 07
subsystem: renderer-theme
tags: [theme, css-variables, appearance, motion, mantine, vitest, playwright]
requires: [02-04, 02-05, 02-06]
provides:
  - "renderer/theme: applyTheme, reportBackground, themeStore, initTheme, setAppearance, useAppearance, ThemeBridge, createStaticColorSchemeManager, bootstrapTheme, AppearanceControl, initMotion, useEntrance, resolveMotionOff"
  - "styles/tokens.css aliases of kit variables; styles/motion.css entrance cues and off switch"
affects: [02-08, 02-10, 02-11, 02-12]
key-files:
  created:
    - apps/desktop/src/renderer/theme/{applier,theme-store,color-scheme-manager,bootstrap,motion}.ts
    - apps/desktop/src/renderer/theme/{ThemeBridge,AppearanceControl}.tsx
    - apps/desktop/src/renderer/theme/appearance.css
    - apps/desktop/src/renderer/theme/{theme.test.tsx,AppearanceControl.test.tsx,motion.test.ts}
    - apps/desktop/src/renderer/styles/{motion.css,aliases.test.ts}
    - apps/desktop/e2e/theme.spec.ts
  modified:
    - apps/desktop/src/renderer/{main.tsx,theme.ts,styles/tokens.css,test-setup.ts}
    - apps/desktop/src/renderer/hotkeys/e2e-hooks.ts
    - apps/desktop/vitest.config.mts
key-decisions:
  - "Mantine MantineColorSchemeManager in 9.7.2 has get, set, subscribe, unsubscribe, clear (as assumed); the static manager is a no-op for all of them"
  - "Theme is applied imperatively before createRoot; React only mirrors the resolved mode into Mantine through ThemeBridge"
duration: 45min
completed: 2026-10-15
---

# Phase 2 Plan 07: Live theme, aliases, entrance motion Summary

The 139 `--eva-c-*` kit variables plus 7 shape variables are written imperatively onto `<html>`; Light, Dark and System switch live with no React remount, every apply reports the sidebar background to main, Phase 1 tokens are aliases of kit keys, and the 12-cue entrance timeline with its off switches and the Appearance control are ready for the sidebar and Settings.

## Tasks

| Task | Commit |
| ---- | ------ |
| 1 ThemeApplier, store, bootstrap, no-remount bridge | a0267e1 |
| 2 Token aliases, motion.css, motion.ts, AppearanceControl | c51cb03 |
| 3 Live theme e2e | 4aa2ddc |

## Deviations from Plan

**1. [Rule 3 - Blocking] Task 1 commit did not build on its own.** main.tsx imports `./styles/motion.css` (per plan) which Task 2 creates, so the Task 1 commit alone fails `vite build`; Task 2's commit restores it. The working tree at the end builds.

**2. [Rule 3 - Blocking] jsdom lacks ResizeObserver** (Mantine SegmentedControl uses FloatingIndicator). Added a no-op stub to `test-setup.ts`.

**3. [Rule 3 - Blocking] Style tests read CSS via `?raw`** (web tsconfig has no node types); vitest blanked CSS, so the renderer project got `css: { include: [/\.css(\?.*)?$/] }`.

**4. [Rule 3 - Blocking] Playwright `colorScheme` option does not reach `_electron.launch`**, and `nativeTheme.themeSource` does not change the renderer's `prefers-color-scheme` under test. The spec drives the OS scheme with `page.emulateMedia` instead (verified working), and does not assume the launch scheme.

No Phase 1 e2e spec needed color-related fixes: all 31 specs pass (3 skipped as before).

## Verification

- Vitest: 55 files, 345 tests pass. `pnpm -r typecheck`, eslint, prettier, em-dash lint clean.
- `pnpm -C apps/desktop build` succeeds. Playwright: 31 passed, 3 skipped (including theme.spec.ts: 139 variables, no remount of `[data-testid=rail]`, `#f3f3f1` background, theme.json `app.appearance`/`lastBackground` persisted, BaseWindow background `#eeeeeb`, System follows emulated scheme live).

## Known Stubs

None. `useEntrance` and the `.eva-cue-*` classes are not attached to any element yet; 02-10 attaches the sidebar cue and Phase 3 the rest, as planned.

## Threat Flags

None beyond the plan's threat model (T-02-11, T-02-20, T-02-28 mitigated; T-02-29 accepted).

## Requirements

THEM-01, THEM-02 and SHEL-07 are not marked complete: the variables, switching and cue CSS exist, but the user-visible entrance (sidebar) and in-app Appearance placement land in 02-10 and 02-11, and the proof screenshots in 02-12.

## Self-Check: PASSED
