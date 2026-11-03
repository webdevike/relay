# Phase 3 proof index

Captured with `EVAOS_PROOF=1 bash scripts/gate.sh` against fixtures and fakes only (fixture Eva root, fake habit gate, fake job-run). Spec files live in `apps/desktop/e2e/`.

## Screenshots

| PNG | Spec and test | Paired assertion |
| --- | --- | --- |
| dashboard-wide-dark | dashboard.spec.ts, wide dark | summary '7 workspaces, 5 open todos, 4 updates this week', 2 chart cards, 5 grid cards, 5 todo rows, hatched current week |
| dashboard-wide-light | dashboard.spec.ts, wide light | same page in the light scheme, data-resolved light |
| dashboard-compact-dark | dashboard.spec.ts, compact dark | compact card layout at the narrow width |
| dashboard-compact-light | dashboard.spec.ts, compact light | compact card layout, light |
| dashboard-filter-active | dashboard.spec.ts, each filter | Active filter shows 5 cards, footer count follows |
| dashboard-filter-todos | dashboard.spec.ts, each filter | Has Todos filter shows 4 cards |
| dashboard-filter-quiet | dashboard.spec.ts, each filter | Quiet filter shows 2 cards |
| dashboard-live-change | dashboard.spec.ts, reload triggers | external file change appears after refresh or focus |
| workspace-dark | workspace.spec.ts, card opens the page | Flo header, chips, timeline rows, 2 todos, sections |
| workspace-light | workspace.spec.ts, card opens the page | same page, light |
| workspace-missing | workspace.spec.ts, missing workspace | not found state with a way back to the dashboard |
| new-todo-modal | new-todo.spec.ts, Cmd+N | modal with row preview; row lands after the last open row, next id T16 |
| new-todo-error | new-todo.spec.ts, todos.md without ## Open | modal stays open with the error |
| jobs-list-dark | jobs.spec.ts, lists every job | 6 rows, 4 scheduled, ok/failed/never run states, Not scheduled and Due now |
| jobs-list-light | jobs.spec.ts, lists every job | same page, light |
| job-form-edit | job-form.spec.ts, edit | edit changes exactly one line of job.md |
| job-form-validation | job-form.spec.ts, create validates inline | inline name, duration and steps errors, no file written |
| job-form-changed-on-disk | job-form.spec.ts, changed on disk | save refused with the banner until the user chooses |
| habits-dark | habits.spec.ts, shows gate status | status, 2 habits, tasks, breaks, history |
| habits-light | habits.spec.ts, shows gate status | same page, light |
| habits-stale | habits.spec.ts, a failing gate | last status kept, error surfaced |
| gate-locked | gate.spec.ts, locking | overlay shown, browser view getVisible false, chords and Escape swallowed |
| gate-timer | gate.spec.ts, start and timer | countdown running |
| gate-override | gate.spec.ts, override | reason required, recorded in history |
| meetings-sidebar | meetings.spec.ts, sidebar lists by day | Today, Yesterday, dated and Undated groups, test calls folded |
| meetings-home | meetings.spec.ts, home | '2 meetings this week, 3 waiting on you' |
| meeting-detail-dark | meetings.spec.ts, detail | Daily standup notes and proposals |
| meeting-detail-light | meetings.spec.ts, detail | same page, light |
| meeting-transcript | meetings.spec.ts, transcript tab | transcript content shown |
| meeting-accepted | meetings-actions.spec.ts, accept | proposal status written through EvaFs |
| meeting-dismissed | meetings-actions.spec.ts, dismiss | proposal dismissed |
| tour-dashboard-compact | phase3-tour.spec.ts | dashboard summary at 800 by 720 inside one continuous session |
| tour-workspace-compact | phase3-tour.spec.ts | Flo workspace header at compact width |
| tour-jobs-compact | phase3-tour.spec.ts | 6 job rows at compact width |
| tour-habits-compact | phase3-tour.spec.ts | habit-row-stretch visible at compact width |
| tour-meeting-compact | phase3-tour.spec.ts | Meeting Detail 'Daily standup' at compact width |

The tour also runs the same pages at the wide default size (assertions only, no PNG) and ends by asserting every `spawnLog` entry targets the fake gate or fake job-run. Zero renderer and main console errors are asserted by the shared fixture teardown.

## Deviations settled

- D1 Keep is a duration: 03-05 (model), 03-13 and 03-14 (form).
- D2 name regex and copy: 03-05, 03-14.
- D3 full duration syntax, zero rejected: 03-05, 03-14.
- D4 Every / Manual schedule labels: 03-13.
- D5 steps required: 03-05, 03-14.
- D6 run badge mapping: 03-05, 03-13.
- D7 Open Todos aside lists todo rows: 03-09.
- D8 override minimum 3 characters in the UI: 03-06, 03-16.
- D9 Due state in Today's breaks: 03-06, 03-15.
- D10 override reason shown in History: 03-15, 03-16.
- D11 Rust m:ss and h:mm:ss countdown: 03-06, 03-16.
- D12 toasts bottom-right: 03-07.
- D13 dismiss writes proposals[i].status: 03-06, 03-18.
- D14 no yaml dependency added: 03-04.
- D15 meeting sidebar dot per proposal: 03-06, 03-17.
- D16 sidebar meta shows start time only: 03-17.
- OQ2 home summary follows Rust '{n} meetings this week, {k} waiting on you': 03-17.
- OQ4 one `reload` registration in reload/reload.ts: 03-09.

## still-needs-isaac

- Real habit gate against ~/.config/eva and the Outlook-backed plan (the fake gate proves the contract only).
- Run now against a real job (forbidden by the unattended rules; only the fake job-run was exercised).
- The feel of the banner crossfade and chart hover.
- Open File and Open Notes launching the real default apps (the openPath hook records the call only).
