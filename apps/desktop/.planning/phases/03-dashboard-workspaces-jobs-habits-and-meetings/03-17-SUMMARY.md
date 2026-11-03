---
phase: 03-dashboard-workspaces-jobs-habits-and-meetings
plan: 17
subsystem: meetings read path
tags: [meetings, sidebar, ipc, zustand, e2e]
requires: [03-03, 03-06, 03-08, 03-12, 03-15]
provides:
  - meetings.list, meetings.get, meetings.openNotes main handlers
  - meetings store (single flight, per-stem detail cache, ref-counted reloader)
  - Meetings sidebar list, Meetings Home, Meeting Detail, ProposalRow (actions slot for 03-18)
affects: [03-18 accept and dismiss]
key-files:
  created:
    - apps/desktop/src/main/eva/meetings-ipc.ts
    - apps/desktop/src/main/eva/meetings-ipc.test.ts
    - apps/desktop/src/renderer/meetings/meetings-store.ts
    - apps/desktop/src/renderer/meetings/MeetingsList.tsx
    - apps/desktop/src/renderer/meetings/MeetingsHome.tsx
    - apps/desktop/src/renderer/meetings/MeetingPage.tsx
    - apps/desktop/src/renderer/meetings/ProposalRow.tsx
    - apps/desktop/src/renderer/meetings/meetings.css
    - apps/desktop/e2e/meetings.spec.ts
  modified:
    - apps/desktop/src/main/eva-ipc.ts
    - apps/desktop/src/renderer/sidebar/SubPages.tsx
    - apps/desktop/src/renderer/pages/registry.ts
    - apps/desktop/src/renderer/pages/page-meta.ts
    - apps/desktop/src/renderer/tabs/tab-meta.ts
    - apps/desktop/e2e/pages.spec.ts
decisions:
  - "Sidebar meta shows only the start time; the contract summary has no end or attendee count (D16)"
  - "Home summary reads '{n} meetings this week, {k} waiting on you' (OQ2)"
  - "Sub-page title button test id is now meetings-home (was sidebar-sub-title for meetings)"
metrics:
  tasks: 3
  tests-added: 24 unit plus 4 e2e
completed: 2026-10-15
---

# Phase 3 Plan 17: Browse meetings Summary

Meetings are browsable end to end: a day-grouped sidebar list with folded test calls and title search, Meeting Home (summary, waiting, who is out, recent decisions) and Meeting Detail (overview, filterable transcript, Open Notes through the checked opener), with meeting titles in tabs.

## Commits
- 90952e4 feat(03-17): meetings read channels and meetings store
- a1b04a4 feat(03-17): meetings sidebar list, home and detail pages
- feat(03-17): meetings e2e and proof (this plan's final task commit)

## Deviations from Plan
- Pre-existing TDD note: tests and implementation were committed together per task, so no separate test(...) commits.
- Detail for an unknown stem shows "This meeting was not found." (not specified in the plan).
- Sidebar test invoke mock was extended to answer meetings.list so the new list body does not read an undefined payload.

## Verification
Renderer vitest (277), main meetings tests, pnpm -r typecheck, eslint, em-dash lint, desktop build, and meetings, sidebar and pages e2e (18 passed) all green. Proof PNGs in proof/phase-3: meetings-sidebar, meeting-detail-dark, meeting-detail-light, meeting-transcript, meetings-home.

## Known Stubs
None. ProposalRow has an intentionally empty actions slot; 03-18 adds Accept and Dismiss.

## Self-Check: PASSED
