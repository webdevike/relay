# Phase 3: Dashboard, Workspaces, Jobs, Habits and Meetings - Context

**Gathered:** 2026-10-15
**Status:** Ready for planning
**Mode:** Smart discuss, all recommended answers accepted (unattended run)

<domain>
## Phase Boundary

Users see and act on their Eva data (workspaces, todos, jobs, habits, meetings) from the new app. Every write to the Eva checkout goes through one `EvaFs` write layer. Covers DASH-01..08, JOBS-01..03, HABT-01..03, MEET-01..03. Chat list, chat parity, side panel tools and search are other phases.
</domain>

<decisions>
## Implementation Decisions

### Ports and data layer
- Behavior is a port of the read-only Rust app (`/Users/ike/Eva/apps/evaos/src`: `dashboard.rs`, `workspace.rs`, `jobs.rs`, `jobs_view.rs`, `gate.rs`, `habits_view.rs`, `meetings.rs`, `meetings_view.rs`, `watch.rs`, plus the README) into Electron-free parsers in `packages/eva-core`, unit-tested with Vitest against fixtures copied (read-only) into the repo. Never write under `/Users/ike/Eva/apps/evaos`.
- All filesystem writes to the Eva checkout go through `EvaFs` in `eva-core` (temp file then rename, `appendFile` for append-only files, re-read check before write, refusal when the file's mtime or content changed since opened). The existing `write-scan.test.ts` guard is extended so no other module writes under the Eva root.
- Parsing is line-oriented for `memory/todos.md` and `memory/journal.md`; frontmatter via the hand-rolled splitter plus `yaml`. Jobs edits change only the edited lines.
- Main process reads and watches (chokidar on narrow explicit paths, plus reload on window focus); renderer gets typed IPC calls with Zod-validated payloads and zustand stores. A fixture Eva root is selectable with `EVAOS_EVA_ROOT` for tests; tests never touch the real checkout.

### Dashboard and workspaces
- Dashboard hero with rotating banners, summary line, New Todo and All Workspaces buttons; filters All / Active / Has Todos / Quiet; Recent Workspaces (two most recent) charts via `@mantine/charts` with 7D / 30D / 90D, hatched current week, daily bars; workspace grid with compact and wide card layouts.
- Reload on window activation, the refresh button and `⌘R` (replacing the Phase 2 sidebar-only refresh action, which stays wired).
- Workspace is a navigable place (`workspace(id)` already in the tab model): chips, New Todo preselecting the workspace, Open File (opens in the default app via `shell.openPath`), activity bars, merged Timeline with Show all, open todos, `##` sections.
- Entrance cue classes from Phase 2 (`.eva-cue-*`) are attached to Dashboard cards.
- New Todo (`⌘N`, hero button, top bar) opens an `EvaModal` with workspace select; next id computed from both todos files; row appended after the last open row with the `(added date)` suffix.

### Jobs and habits
- Jobs page lists `jobs/<name>/job.md` with schedule, enabled switch, last run, run state, next due. Create/edit form with inline validation of names and durations. Run now spawns `bun .omp/tools/job-run.ts <name>` detached (never killed by the app); open last session; delete after confirmation. A test seam `EVAOS_JOB_RUN_BIN` replaces the spawn target in e2e so no real job runs.
- Habits read `habit-gate.ts status --json` on launch, every 4 s while the window is visible, on page open, on activation and `⌘R`. Edits go through the habit-gate CLI subcommands (not direct file writes). A seam `EVAOS_HABIT_GATE_BIN` points e2e at a fake gate script.
- Locked gate overlay is a near-opaque layer covering the window that hides the browser view (via `useOccludeBrowser`) and offers Start, countdown, Done, Choose photo (native file dialog, stubbed in e2e) and Override with a required typed reason.

### Meetings
- Meetings sidebar sub-page body (filled from the Phase 2 placeholder) lists `work/meetings/<stem>.json` newest first grouped by day, test calls folded, title search (`⌘F` focuses). Meeting Home summary line; Detail place `meeting(stem)` shows title, time, attendees, Open Notes, proposals. Accept appends a todo via `EvaFs`; Dismiss writes the record's `status` field via `EvaFs`.

### Proof and verification
- Playwright for Electron specs against fixture roots with screenshots under `proof/phase-3/`; unit tests for every parser and writer; app must build and launch.

### Claude's Discretion
Component structure, store shapes, icon choices, chart styling details, banner copy (no em dashes in UI strings), exact fixture contents, and plan slicing.
</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `packages/eva-core` (fs, sidebar readers `countOpenTodos`, `countScheduledJobs`, journal Recent), `packages/shell-core` (tabs, fit, hotkeys), `packages/theme-core`.
- Renderer: `renderer/overlay` (`EvaModal`, `EvaMenu`, ...), `renderer/pages`, `renderer/sidebar`, `renderer/tabs`, `renderer/hotkeys`, `renderer/ui` ScrollArea, `useOccludeBrowser`.
- Main: `eva-ipc.ts`, `write-queue.ts`, `config-store.ts`, `test-hooks.ts`.

### Established Patterns
- Typed Zod IPC contract in `packages/contract`; `{ok,value|error}` results; zustand stores; Mantine overlays only through wrappers.

### Integration Points
- Sidebar nav (Dashboard, Jobs, Habits, Meetings, Tasks), tab `place` model, `⌘N` and `⌘R` stub actions in the hotkey router, Phase 2 cue classes, browser occlusion hook.
</code_context>

<specifics>
## Specific Ideas

Match the Rust app's README behavior and `proof/` conventions from earlier phases.
</specifics>

<deferred>
## Deferred Ideas

Calendar, Tasks board, Memory and Files pages (later phases); Inbox (Phase 7); chat list bodies (Phase 4).
</deferred>
