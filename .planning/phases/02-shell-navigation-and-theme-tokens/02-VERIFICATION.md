---
phase: 02-shell-navigation-and-theme-tokens
verified: 2026-10-15T00:00:00Z
status: human_needed
score: 4/4 must-haves verified
overrides_applied: 0
human_verification:
  - test: "Real macOS traffic-light placement over the window chrome in a normal window"
    expected: "Traffic lights do not collide with the sidebar toggle or tabs"
    why_human: "Playwright cannot render native title bar controls"
  - test: "Feel of the 220 ms sidebar slide and the entrance fade timeline"
    expected: "Smooth, not janky"
    why_human: "Smoothness is a human judgement"
---

# Phase 2: Shell, Navigation and Theme Tokens Verification Report

**Goal:** Full EvaOS frame (sidebar, main card, right panel, footer) with tabs, hotkeys and live-themeable CSS variables.
**Status:** human_needed (all automated truths verified; two subjective items remain)

## Roadmap truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Three-column frame, grips, reset, persistence, fold at 760x720 | VERIFIED | `shell-frame.spec.ts` passed in my own gate run; screenshots `shell-dark-1280x800.png`, `shell-folded-light-760x720.png` viewed: sidebar folded, two cards over footer |
| 2 | Sidebar pages and sub-pages (Chats, Settings, Meetings) with Back/Esc; tabs; hotkeys via one router | VERIFIED | `sidebar.spec.ts`, `tabs.spec.ts`, `hotkeys.spec.ts` passed; `sidebar-subpage-settings.png`, `tabs-pinned-menu.png` viewed. Meetings sub-page exists in `SubPages.tsx` (content is a stub by design, later phase). Terminal yield covered by Vitest only, since no terminal exists until Phase 6 |
| 3 | Live Light/Dark/System recolor, 139 keys, entrance once and disable-able, quit prompt | VERIFIED | `theme.spec.ts`, `motion.spec.ts`, `quit-guard.spec.ts` passed; `keys.ts` has 139-key test |
| 4 | Running app and proof screenshots with state assertions | VERIFIED | 12 PNGs in `proof/phase-2/`; `bash scripts/gate.sh` exit 0 (typecheck, eslint, prettier, em-dash, 408 Vitest, build, 84 e2e, sentinel, packaged smoke) |

**Score:** 4/4

## Requirements

SHEL-01..08, SETT-01, THEM-01, THEM-02 all satisfied. SHEL-03, 06, 07, 08 and SETT-01 were still unticked in REQUIREMENTS.md and are now marked Complete. No orphaned requirements. No TBD/FIXME/XXX markers in source.

## Human verification items

| Item | Result |
|------|--------|
| Native traffic-light placement | still-needs-isaac: Playwright cannot render native window controls (e2e only proves toggle clears x >= 80) |
| Feel of slide and entrance motion | still-needs-isaac: smoothness is a human judgement; timing and once-per-launch are agent-verified (`motion.spec.ts`) |

## Notes (non-blocking)

- Recent list in the sidebar renders very short at 1280x800 (only a faded row visible); layout works but may deserve polish.
- Documented deviations: IconFlame for Habits, entrance budget 2.0 s, e2e `startOnChat` interim default.

## Deferred gaps

None.
