---
phase: 03-dashboard-workspaces-jobs-habits-and-meetings
plan: 07
subsystem: ui
tags: [charts, recharts, mantine, chokidar]
requires: []
provides:
  - "ui/ActivityChart (bars, smoothed line, hatched current week)"
  - "pinned @mantine/charts 9.7.2, recharts 3.10.1, react-is 19.3.1, chokidar 5.0.0 (devDependencies)"
affects: [03-10, 03-12]
key-files:
  created:
    - apps/desktop/src/renderer/ui/ActivityChart.tsx
    - apps/desktop/src/renderer/ui/ActivityChart.test.tsx
    - apps/desktop/src/renderer/ui/activity-chart.css
  modified:
    - apps/desktop/package.json
    - apps/desktop/src/renderer/main.tsx
    - pnpm-lock.yaml
    - pnpm-workspace.yaml
decisions:
  - "Hatch spike: Path B (Recharts ComposedChart primitives plus Mantine ChartTooltip)"
requirements-completed: [DASH-04]
completed: 2026-10-15
---

# Phase 3 Plan 07: Chart spike and ActivityChart Summary

Pinned chart and watcher deps, toasts bottom-right, and a tested ActivityChart that hatches the current week with an SVG pattern behind daily bars and a monotone line.

## Hatch decision (Path B)
Evidence in installed `@mantine/charts/esm/CompositeChart/CompositeChart.mjs`: referenceAreas (line 164-170) force fillOpacity .2 and a stroke, bars take one series color (no per-cell fill for the accent today bar), and ResponsiveContainer measures 0 in jsdom. So ActivityChart uses Recharts primitives directly with Mantine `ChartTooltip` and the charts stylesheet. Recorded in the header comment too. This deviates from "via @mantine/charts" as research Alternatives Considered sanctioned.

## Commits
- d6eb88a chore(03-07): install packages, toasts bottom-right, charts stylesheet
- Task 2 commit: feat(03-07): ActivityChart

## Deviations
- `pnpm-workspace.yaml`: added `react-is@19.3.1` to `minimumReleaseAgeExclude` (required for the install to pass the release-age gate, same as the other pinned React packages). [Rule 3]
- `Bar minPointSize={1}` so zero-count days still render a bar shape (hairline baseline).
- Provenance: all four tarballs come from registry.npmjs.org; repo URLs match mantinedev/mantine, recharts/recharts, paulmillr/chokidar. react-is reports `github.com/react/react` rather than `facebook/react` (the same React-team repo under its current org name); accepted.
- Test 5 reads source via `?raw` import instead of fs.

## Verification
vitest ui (10 tests, 5 new), typecheck, eslint, em-dash lint and desktop build all pass; install with frozen lockfile ok.

## Known Stubs
None.

## Self-Check: PASSED
