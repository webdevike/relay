# Phase 2 verification checklist

Evidence map for VERIFICATION.md. Specs live in `apps/desktop/e2e/`, unit tests next to their sources under `apps/desktop/src` and in `packages/*/src`. Screenshots are in this folder and were each captured after the matching state assertion passed (`shell-proof.spec.ts`).

## ROADMAP success criteria

| # | Criterion | Evidence | State assertion | Status |
|---|-----------|----------|-----------------|--------|
| 1 | Three-column shell over a footer, draggable edges, reset, persisted widths, fold at 760 by 720 | `shell-frame.spec.ts` (widths and fold vectors, grips drag and reset, relaunch, malformed layout), `shell-dark-1280x800.png`, `shell-folded-dark-760x720.png` | sidebar 272, panel 420, folded state, panel 320 at 760 | agent-verified |
| 2 | Sidebar pages and sub-pages with Back and Esc, tabs, every hotkey through one router | `sidebar.spec.ts`, `tabs.spec.ts`, `hotkeys.spec.ts`, `sidebar-subpage-settings.png`, `sidebar-subpage-chats.png`, `tabs-pinned-menu.png` | action ring buffer holds every chord, Esc ladder order | agent-verified (terminal yield: Vitest `router.test.tsx`, `scopes.test.ts`; no terminal exists until Phase 6) |
| 3 | Live recolor without remount, entrance once and disable-able, quit prompt | `theme.spec.ts`, `motion.spec.ts`, `quit-guard.spec.ts`, `appearance-live-switch.png` | same sidebar node and element count, fade 150 ms once, dialog copy and button ids | agent-verified |
| 4 | Running app and `proof/phase-2/` screenshots with matching assertions | `shell-proof.spec.ts` (12 PNGs), gate packaged smoke | every capture follows its assertion | agent-verified |

## Requirements

| ID | Evidence | State assertion | Status |
|----|----------|-----------------|--------|
| SHEL-01 | `shell-frame.spec.ts`; `shell-dark-1280x800.png`, `shell-light-1280x800.png`, `shell-folded-dark-760x720.png`, `shell-folded-light-760x720.png`, `shell-wide-dark-1440x900.png`, `shell-wide-light-1440x900.png` | widths, fold, card adjacency, minimum window | agent-verified |
| SHEL-02 | `shell-frame.spec.ts` (grips drag, reset, relaunch) | widths in `layout.json`, unknown keys kept | agent-verified |
| SHEL-03 | `sidebar.spec.ts`; `sidebar-subpage-settings.png`, `sidebar-subpage-chats.png` | nav rows, counts, Recent filter, sub-page level, Back, Esc, account menu, appearance | agent-verified |
| SHEL-04 | `tabs.spec.ts`; `tabs-pinned-menu.png` | tab list, history, pin rules, relaunch persistence, browser view hidden under the menu | agent-verified |
| SHEL-05 | `hotkeys.spec.ts` (every chord logged, effects, native edit chords untouched, Esc ladder, guest forwarding via real `sendInputEvent`) | ring buffer entries, `defaultPrevented` false on an idle Esc | agent-verified |
| SHEL-06 | `pages.spec.ts` (scroll memory, fades, contained overscroll) | per-page scroll offsets restored | agent-verified |
| SHEL-07 | `motion.spec.ts` (fade 150 ms delay 0, finishes under 2 s, once per launch, `EVAOS_NO_MOTION`, live reduced motion) | `data-eva-motion`, animation state and start time unchanged after navigation | agent-verified; feel and smoothness of the 220 ms slide and the entrance timeline on real hardware: still-needs-isaac (a human must judge motion quality) |
| SHEL-08 | `quit-guard.spec.ts` (stubbed `showMessageBox`: copy, Cancel, "and 1 more", Save, nothing dirty, window close) | recorded dialog options, window not destroyed on Cancel | agent-verified |
| SETT-01 | `settings.spec.ts`, `sidebar.spec.ts`, `settings-chat.png`, `sidebar-subpage-settings.png` | three section rows, titles, descriptions, tab titles | agent-verified |
| THEM-01 | `theme.spec.ts`, `shell-dark-1280x800.png` | 139 `--eva-c-*` properties, no remount | agent-verified |
| THEM-02 | `theme.spec.ts`, `settings.spec.ts`, `shell-light-1280x800.png`, `settings-theme-light.png`, `appearance-live-switch.png` | `data-resolved`, `--eva-c-background` is `#f3f3f1` in light, OS follow | agent-verified |

## Still needs Isaac

| Item | Reason |
|------|--------|
| Real macOS traffic-light placement over the window chrome in a normal (non-test) window | Playwright cannot render the native title bar controls; the e2e only proves the toggle clears x >= 80 |
| Feel of the 220 ms sidebar slide and the entrance fade timeline on real hardware | Smoothness is a human judgement |
| Import of Isaac's Rust `layout.json` | Deliberately not built (D-02) and not required |

## Deliberate deviations discovered in the phase

- `IconFlame` stands in for the missing `IconTimer` on Habits.
- Browser tab testids were renamed `browser-tab-*` so the main tab strip owns `tab-*`.
- Entrance budget is 2.0 s instead of 3.95 s.
- Tab history uses `back` and `forward` stacks instead of a cursor.
- The e2e fixture opens a chat first by default (`startOnChat`), an interim default until the Phase 3 dashboard owns launch.
- A finished `animation-fill: both` fade stays listed in `getAnimations()`, so motion specs judge `playState`, not list length.

## Re-run

- Proof: `EVAOS_PROOF=1 pnpm -C apps/desktop exec playwright test shell-proof.spec.ts`
- Gate: `bash scripts/gate.sh`

## Final gate result

`bash scripts/gate.sh` exited 0: install check, typecheck, eslint, prettier, em-dash lint, Vitest (64 files, 408 tests), build, e2e (84 passed), sentinel, packaged smoke (1 passed). Twelve screenshots present.
