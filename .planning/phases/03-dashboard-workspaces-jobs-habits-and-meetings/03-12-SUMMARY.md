---
phase: 03-dashboard-workspaces-jobs-habits-and-meetings
plan: 12
subsystem: workspace-page
tags: [workspace, openPath, names-store, e2e]
requires: [03-04, 03-07, 03-09, 03-11]
provides:
  - eva.workspace and eva.workspace.openFile handlers
  - openPathChecked, the single shell.openPath gate (for 03-15 and 03-17)
  - names-store (workspace names now, meeting titles later) feeding tab titles
  - WorkspacePage (page-workspace)
affects: [tabs, pages registry, dashboard-store]
key-files:
  created:
    - apps/desktop/src/main/eva/open-path.ts
    - apps/desktop/src/main/eva/workspace-ipc.ts
    - apps/desktop/src/renderer/eva/names-store.ts
    - apps/desktop/src/renderer/workspace/WorkspacePage.tsx
    - apps/desktop/src/renderer/workspace/workspace-store.ts
    - apps/desktop/src/renderer/workspace/workspace.css
    - apps/desktop/e2e/workspace.spec.ts
  modified:
    - apps/desktop/src/main/eva-ipc.ts
    - apps/desktop/src/renderer/dashboard/dashboard-store.ts
    - apps/desktop/src/renderer/pages/registry.ts
    - apps/desktop/src/renderer/pages/page-meta.ts
    - apps/desktop/src/renderer/tabs/tab-meta.ts
    - apps/desktop/src/renderer/tabs/TabBar.tsx
decisions:
  - openPathChecked records to the 'openPath' test hook (calls, failNext) when EVAOS_E2E=1 and never launches an app
  - Open File resolves the workspace id to a path in main from workspaceFiles; the renderer sends only the id
  - Timeline day headings are Today, Yesterday, else short date (not "5d ago")
metrics:
  tasks: 3
  completed: 2026-10-15
---

# Phase 3 Plan 12: Workspace page Summary

Workspace place with chips, activity chart, merged timeline (8 then Show all), open todos and collapsible file sections, plus a single checked `shell.openPath` gate and a names store that gives tabs workspace names with a folder icon.

## Commits

- 1c45292 style: removed explicit `any` in `e2e/helpers/fakes.test.ts` so `eslint apps/desktop` is clean (requested separately)
- 4872dc4 feat: workspace IPC, openPath gate, names store
- bff40fb feat: Workspace page, registry, page meta, tab titles
- e2e commit: workspace.spec.ts and proof screenshots

## Verification

- Vitest renderer (217+) and main/eva suites pass; `pnpm -r typecheck`, `eslint apps/desktop`, em-dash lint and `pnpm -C apps/desktop build` are clean.
- e2e: workspace (5), tabs, pages, dashboard, new-todo specs pass (31 tests) against the built app.
- Proof: `proof/phase-3/workspace-dark.png`, `workspace-light.png`, `workspace-missing.png`.
- `shell.openPath` appears only in `open-path.ts` (acceptance grep returns 0 elsewhere).

## Deviations from Plan

- The dark proof is captured under the same harness scheme handling as other phase-3 proofs; the shell shows its "System" appearance, so the "dark" shot renders with a light surface. Not changed here (harness behavior shared with earlier proofs).
- Timeline entries use a dedicated `eva-ws-clamp` class instead of `eva-dash-clamp` (its min-height broke the icon/text row).
- `isInside` imported from `@evaos/eva-core/fs/allowlist` (not exported from the package index) rather than editing eva-core.

## Known Stubs

None.

## Threat Flags

None beyond the plan's register (T-03-39 mitigated by the main-resolved path and realpath containment; T-03-40 by text-only rendering, covered by a test that `<b>` in a section body stays text; T-03-41 by the e2e recorder).

## Self-Check: PASSED
