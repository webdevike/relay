---
phase: 03-dashboard-workspaces-jobs-habits-and-meetings
plan: 18
subsystem: meetings
tags: [meetings, evafs, ipc, proposals]
requires: [03-01, 03-06, 03-11, 03-17]
provides:
  - meetings.accept and meetings.dismiss handlers (EvaFs only)
  - Accept todo and Dismiss proposal actions on Meeting Detail and Meetings Home
affects: [03-19]
key-files:
  created:
    - apps/desktop/e2e/meetings-actions.spec.ts
    - proof/phase-3/meeting-accepted.png
    - proof/phase-3/meeting-dismissed.png
  modified:
    - apps/desktop/src/main/eva/meetings-ipc.ts
    - apps/desktop/src/main/eva/meetings-ipc.test.ts
    - apps/desktop/src/renderer/meetings/meetings-store.ts
    - apps/desktop/src/renderer/meetings/meetings-store.test.ts
    - apps/desktop/src/renderer/meetings/ProposalRow.tsx
    - apps/desktop/src/renderer/meetings/meetings.test.tsx
    - apps/desktop/src/renderer/meetings/meetings.css
decisions:
  - "Todo date suffix uses the meeting's local start day (dayKey), matching todoText's documented contract; the fixture meeting starts today so it equals today"
  - "ProposalRow renders Accept and Dismiss itself for proposed, non-dim rows (the actions prop remains as an override); MeetingPage and MeetingsHome needed no change"
metrics:
  tasks: 3
  completed: 2026-10-15
---

# Phase 3 Plan 18: Meeting proposal actions Summary

Accept appends a todo then marks proposals[i].status accepted, Dismiss writes dismissed, both through EvaFs inside one per-stem queue so a double accept never duplicates a todo.

## Tasks

| Task | Commit | Notes |
| ---- | ------ | ----- |
| 1 main handlers | 6912c82 | meetingsAccept and meetingsDismiss, 6 new tests; partial-accept names the new todo id; unsafe workspace falls back to eva |
| 2 UI actions | e7f0606 | store acceptProposal and dismissProposal, toasts, inline alert with Reload, 7 new tests |
| 3 e2e and proof | see final commit | 5 specs with file assertions, proof screenshots |

## Deviations from Plan

None in behavior. The plan's frontmatter lists `MeetingPage.tsx` and `MeetingsHome.tsx` as modified; they did not need edits because the row owns the default actions. Dismiss test targets planning#2 (the only proposed proposal in that fixture).

## Verification

Vitest (main, renderer, write-scan), typecheck, eslint, em-dash lint, build, and meetings plus meetings-actions e2e all pass; proofs written to proof/phase-3/.

## Self-Check: PASSED
