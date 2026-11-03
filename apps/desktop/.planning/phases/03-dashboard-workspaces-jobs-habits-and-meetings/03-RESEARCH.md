# Phase 3: Dashboard, Workspaces, Jobs, Habits and Meetings - Research

**Researched:** 2026-10-15
**Domain:** Electron port of read-mostly Eva-data pages (line-oriented parsers, a guarded write layer, CLI-backed habit gate, detached job runs, chart rendering)
**Confidence:** HIGH on behavior (read from the Rust source and the live Eva files), MEDIUM on chart hatching and chokidar details (not proven in this repo yet)

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Ports and data layer**
- Behavior is a port of the read-only Rust app (`/Users/ike/Eva/apps/evaos/src`: `dashboard.rs`, `workspace.rs`, `jobs.rs`, `jobs_view.rs`, `gate.rs`, `habits_view.rs`, `meetings.rs`, `meetings_view.rs`, `watch.rs`, plus the README) into Electron-free parsers in `packages/eva-core`, unit-tested with Vitest against fixtures copied (read-only) into the repo. Never write under `/Users/ike/Eva/apps/evaos`.
- All filesystem writes to the Eva checkout go through `EvaFs` in `eva-core` (temp file then rename, `appendFile` for append-only files, re-read check before write, refusal when the file's mtime or content changed since opened). The existing `write-scan.test.ts` guard is extended so no other module writes under the Eva root.
- Parsing is line-oriented for `memory/todos.md` and `memory/journal.md`; frontmatter via the hand-rolled splitter plus `yaml`. Jobs edits change only the edited lines.
- Main process reads and watches (chokidar on narrow explicit paths, plus reload on window focus); renderer gets typed IPC calls with Zod-validated payloads and zustand stores. A fixture Eva root is selectable with `EVAOS_EVA_ROOT` for tests; tests never touch the real checkout.

**Dashboard and workspaces**
- Dashboard hero with rotating banners, summary line, New Todo and All Workspaces buttons; filters All / Active / Has Todos / Quiet; Recent Workspaces (two most recent) charts via `@mantine/charts` with 7D / 30D / 90D, hatched current week, daily bars; workspace grid with compact and wide card layouts.
- Reload on window activation, the refresh button and `⌘R` (replacing the Phase 2 sidebar-only refresh action, which stays wired).
- Workspace is a navigable place (`workspace(id)` already in the tab model): chips, New Todo preselecting the workspace, Open File (opens in the default app via `shell.openPath`), activity bars, merged Timeline with Show all, open todos, `##` sections.
- Entrance cue classes from Phase 2 (`.eva-cue-*`) are attached to Dashboard cards.
- New Todo (`⌘N`, hero button, top bar) opens an `EvaModal` with workspace select; next id computed from both todos files; row appended after the last open row with the `(added date)` suffix.

**Jobs and habits**
- Jobs page lists `jobs/<name>/job.md` with schedule, enabled switch, last run, run state, next due. Create/edit form with inline validation of names and durations. Run now spawns `bun .omp/tools/job-run.ts <name>` detached (never killed by the app); open last session; delete after confirmation. A test seam `EVAOS_JOB_RUN_BIN` replaces the spawn target in e2e so no real job runs.
- Habits read `habit-gate.ts status --json` on launch, every 4 s while the window is visible, on page open, on activation and `⌘R`. Edits go through the habit-gate CLI subcommands (not direct file writes). A seam `EVAOS_HABIT_GATE_BIN` points e2e at a fake gate script.
- Locked gate overlay is a near-opaque layer covering the window that hides the browser view (via `useOccludeBrowser`) and offers Start, countdown, Done, Choose photo (native file dialog, stubbed in e2e) and Override with a required typed reason.

**Meetings**
- Meetings sidebar sub-page body (filled from the Phase 2 placeholder) lists `work/meetings/<stem>.json` newest first grouped by day, test calls folded, title search (`⌘F` focuses). Meeting Home summary line; Detail place `meeting(stem)` shows title, time, attendees, Open Notes, proposals. Accept appends a todo via `EvaFs`; Dismiss writes the record's `status` field via `EvaFs`.

**Proof and verification**
- Playwright for Electron specs against fixture roots with screenshots under `proof/phase-3/`; unit tests for every parser and writer; app must build and launch.

### Claude's Discretion
Component structure, store shapes, icon choices, chart styling details, banner copy (no em dashes in UI strings), exact fixture contents, and plan slicing.

### Deferred Ideas (OUT OF SCOPE)
Calendar, Tasks board, Memory and Files pages (later phases); Inbox (Phase 7); chat list bodies (Phase 4).
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| DASH-01 | Workspaces from `workspaces/<id>.md` or `<id>/<id>.md` + built-in Eva, tag aliases | "Parsing rules: workspaces", `workspaceFiles`, `canonicalTag`, aliases table |
| DASH-02 | Activity from journal headings + archive + dated Threads bullets; open todos | "Parsing rules: journal, threads, todos"; real-file findings (Threads bullets exist in 8 of 19 files) |
| DASH-03 | Hero, banners, summary, buttons, filters | "Dashboard computations" (filters 14/30 days, summary), banner assets path, 9 s / 1400 ms constants |
| DASH-04 | Recent Workspaces charts, 7D/30D/90D, hatched week | `dailyActivity` port, Mantine `CompositeChart` + `referenceAreas`, hatch spike |
| DASH-05 | Grid cards, compact/wide | Rust semantics (grid excludes the two recent cards), ResizeObserver compact rule from UI-SPEC |
| DASH-06 | Reload on activation, refresh button, `⌘R` | Existing `registerAction('reload')` stub in `sidebar-store.ts`; single-flight + one queued follow-up |
| DASH-07 | New Todo append with next id from both files, re-read check | `appendTodo` port with exact algorithm, real-file next id = T79, EvaFs gap (no re-read check yet) |
| DASH-08 | Workspace page | `timeline`, sections, `shell.openPath`, place string `workspace:<id>` |
| JOBS-01 | Jobs list with schedule, last run, run state, next due | `jobs.rs` rules, `.runs` layout verified on real files, lock/status states |
| JOBS-02 | Create/edit, inline validation, minimal line edits, atomic, refuse stale | `JobDoc` port, byte-identical round trip, validation discrepancies (keep is a duration) |
| JOBS-03 | Run now detached, open last session, delete | `run_command` port, `EVAOS_JOB_RUN_BIN` seam, session file lives under `sessions/-Eva` |
| HABT-01 | `status --json` reads and polling | CLI contract below, generation counter pattern, `remainingSeconds` |
| HABT-02 | Add/edit/remove habits and tasks via CLI | Exact argv for each subcommand, flag parsing traps |
| HABT-03 | Gate overlay | Overlay behavior from `habits_view.rs`, `useOccludeBrowser`, hotkey suppression |
| MEET-01 | Meetings list, grouping, test calls folded, search | `list` ordering, `isSkipped`, `day_label` |
| MEET-02 | Home summary and Detail | `digest`, `parseProtocol`, protocol file shape |
| MEET-03 | Accept appends todo, Dismiss writes status | `accept`/`setStatus` port, JSON key-order finding |
</phase_requirements>

## Summary

Phase 3 is a behavior port plus a UI build. Every rule that matters lives in nine Rust files plus two Eva tools (`.omp/tools/habit-gate.ts`, `.omp/tools/job-run.ts`), and all of them were read in full for this research. The data layer is small and pure (line parsers, a frontmatter-line editor, a JSON status editor), so most of the risk is not in parsing. The risk is in five places: (1) the UI-SPEC disagrees with the real runner on job `keep`, job names and duration units, so following the UI-SPEC literally would write job files the runner reads differently; (2) `EvaFs` today has only whole-file atomic writes and no re-read or mtime refusal, which CONTEXT requires; (3) Recharts/Mantine charts need real layout, so jsdom cannot validate them; (4) the fixture Eva root is too small and shared, and e2e needs a dated, copy-per-spec fixture plus a fake gate and fake job-run; (5) several places where Phase 2 code must change (page registry dispatch by slug, `pages.spec.ts` placeholder assertions, tab titles for workspaces, toast position).

The live checkout confirms most formats but corrects some assumptions: `work/meetings/` does not exist in `/Users/ike/Eva` today (no real meeting record to copy; shape comes from `meeting-memory.ts` and the Rust tests); 8 of 19 workspace files have `## Threads` bullets but several (for example `personal.md`, `eva-interface.md`) use `###` dated headings which the Rust parser ignores, so a literal port matches the Rust app, not the files' full content; `memory/todos.md` has a real next id of T79 (todos max 75, done max 78); real jobs include `script:` jobs, which the Jobs page must preserve as unknown frontmatter keys.

**Primary recommendation:** Build `packages/eva-core` modules (`workspaces`, `journal`, `todos`, `jobs`, `habit-gate`, `meetings`) as exact ports with the Rust unit tests translated 1:1 plus real-file snapshot tests, extend `EvaFs` with a read-stamp/`edit` primitive before any UI writes, and drive all dates through one injectable clock. Follow the runner (not the UI-SPEC) wherever they disagree, and record each deviation in the plan.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Parse workspaces/journal/todos/jobs/meetings | Main process (via `eva-core`, Electron-free) | Renderer (formatting only) | Filesystem access is main-only; parsers stay pure so Vitest `node` runs them |
| Compute dashboard model (activity, filters, stats) | `eva-core` pure functions called in main, results shipped over IPC | Renderer applies filter and range locally | Range (7/30/90) and filter are in-memory UI state; ship per-day arrays for 90 days once |
| Write todos, job.md, meeting status, delete job | Main process via `EvaFs` only | Renderer sends intent, never paths | Single guarded writer; write trap enforces |
| Habit gate reads/writes | Main process spawns `bun habit-gate.ts` | Renderer polls through IPC, owns countdown display | CLI owns `habits.yml` and `~/.config/eva/gate.json`; app never writes them |
| Run job now | Main process detached spawn | Renderer shows toast and reloads | Detached process group, never killed by app |
| Gate overlay and browser occlusion | Renderer (overlay) + `browser.setOccluded` via existing `useOccludeBrowser` | Main hides the WebContentsView | Native view sits above DOM; occlusion already built in Phase 1/2 |
| Charts | Renderer (Mantine charts / Recharts SVG) | none | Pure presentation of main-supplied arrays |
| Open File / Open Notes / proof photo | Main (`shell.openPath`) | none | Allow-list to paths under Eva root or `~/.config/eva/habit-photos` |
| Change detection | Main chokidar (narrow paths) + renderer focus event | none | Locked in CONTEXT |
| Date/"today" | One injectable clock in main and renderer | none | Deterministic e2e |

## Standard Stack

Everything already installed in the repo is reused: Electron 44.7.2, React 19.3.1, Mantine 9.7.2 (`core`, `hooks`, `notifications`), zustand 5.0.15, Zod 4.6.7, Vitest 5.0.4, Playwright 1.64.1, Tabler icons 3.49.0 [VERIFIED: `apps/desktop/package.json`].

### New dependencies (apps/desktop devDependencies; bundled by Vite)
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| @mantine/charts | 9.7.2 | `CompositeChart` (bars + monotone line + `referenceAreas`) for activity | Locked by CONTEXT and project stack; peer `@mantine/core 9.7.2`, `recharts >=3.2.1`, react ^19.2 [VERIFIED: npm view] |
| recharts | 3.10.1 | Engine for Mantine charts; fallback to use directly for `ReferenceArea` + SVG `<pattern>` | Project stack pins it explicitly; `latest` = 3.10.1 [VERIFIED: npm view] |
| react-is | 19.3.1 | Peer of recharts (`react-is ^16.8 \|\| ... \|\| ^19`); pnpm strict peers will otherwise warn or fail to resolve | Matches React 19.3.1 [VERIFIED: npm view react-is version] |
| chokidar | 5.0.0 | Narrow-path change watch in main (locked in CONTEXT) | ESM-only, node >=20.19, one dep `readdirp ^5`, no postinstall script [VERIFIED: npm view] |

Not needed (do not add): `yaml` (CONTEXT mentions it, but no Phase 3 file needs a YAML parse: workspace files are parsed line by line like Rust, job frontmatter is edited line by line, habits.yml is owned by the CLI and read through `status --json`), `date-fns` (use `Intl.DateTimeFormat` plus a small tested helper module), `@mantine/spotlight` (search is another phase), `dnd-kit`.

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `CompositeChart` with `referenceAreas` for the hatched week | Recharts `ComposedChart` + `ReferenceArea fill="url(#hatch)"` + `<defs><pattern>` | Mantine docs confirm `referenceAreas` (flat `color`) and, on BarChart, `children` for `<defs>`; hatching via `url(#id)` colour is not confirmed for CompositeChart. Spike first; if flat colour only, wrap Recharts directly inside `ui/ActivityChart` (still satisfies "wrapped in ui/ActivityChart"). [CITED: mantine.dev/charts/bar-chart, mantine.dev/charts/composite-chart] |
| chokidar | `fs.watch` | CONTEXT locks chokidar |
| Renderer-driven gate polling | main `setInterval` | Renderer knows `document.hidden`; main dedupes in-flight. Use renderer timer, main single-flight |

**Installation:**
```bash
pnpm -C apps/desktop add -D @mantine/charts@9.7.2 recharts@3.10.1 react-is@19.3.1 chokidar@5.0.0
# styles: import '@mantine/charts/styles.css' in renderer main.tsx after '@mantine/core/styles.css'
```

## Package Legitimacy Audit

`slopcheck` could not be installed here (`pip` is not available on this machine). Per protocol, packages found only through non-authoritative discovery would be `[ASSUMED]`. These four are named in the project's own locked stack (CLAUDE.md "Recommended Stack", `@mantine/charts`, `recharts`, `chokidar`) or are a direct peer of one (`react-is`), and registry facts were checked with `npm view`.

| Package | Registry | Age | Downloads | Source Repo | slopcheck | Disposition |
|---------|----------|-----|-----------|-------------|-----------|-------------|
| @mantine/charts | npm | multi-year (9.7.2 modified 2026-10-11) | not measured | github.com/mantinedev/mantine | unavailable | Approved by project stack [CITED: CLAUDE.md]; planner adds one `checkpoint:human-verify` only if lockfile shows an unexpected tarball source |
| recharts | npm | multi-year (3.10.1 modified 2026-10-13) | not measured | github.com/recharts/recharts (well known) | unavailable | Approved by project stack [CITED: CLAUDE.md] |
| react-is | npm | multi-year (React team) | not measured | github.com/facebook/react | unavailable | Approved; peer of recharts [ASSUMED] that pnpm needs it explicit |
| chokidar | npm | multi-year, 5.0.0 | not measured | github.com/paulmillr/chokidar | unavailable | Approved by project stack [CITED: CLAUDE.md]; `scripts.postinstall` empty [VERIFIED: npm view] |

**Packages removed due to slopcheck [SLOP]:** none (tool unavailable)
**Packages flagged [SUS]:** none known

## Architecture Patterns

### System Architecture Diagram

```
 window focus / refresh button / ⌘R / chokidar change (debounced 250 ms)
                    |
                    v
 renderer eva-store.reload()  --single flight + one queued follow-up-->  IPC eva.dashboard
                                                                              |
 MAIN                                                                         v
  env.evaRoot (fixture in tests) --> eva-core readers:
     workspaces/*.md , workspaces/*/<id>.md  --> workspaceFrom()
     memory/journal.md + memory/archive/*.md --> parseJournal()   --> dashboard model
     memory/todos.md (## Open)               --> parseOpenTodos()      (per-day activity,
                                                                         filters inputs,
 renderer stores (zustand): dashboard, jobs, habits, meetings            stats, todos)
   |  UI: Dashboard, Workspace, New Todo modal, Jobs, Habits, Meetings
   |
   |-- New Todo / Accept -----> IPC eva.todo.add ---> EvaFs.edit('todo-append', memory/todos.md)
   |                                                      read stamp -> pure appendTodo() -> re-stat -> atomic rename
   |-- Dismiss ---------------> IPC eva.meeting.setStatus -> EvaFs.edit('meeting-status', work/meetings/<stem>.json)
   |-- Job save / toggle -----> IPC eva.job.save|setEnabled -> EvaFs.edit('job-md', ...) (expected-text check)
   |-- Job delete ------------> IPC eva.job.delete -> EvaFs.remove('job-delete')
   |-- Run now ---------------> spawn detached: bun <root>/.omp/tools/job-run.ts <name>   (or EVAOS_JOB_RUN_BIN)
   |-- Habit read/edit/gate --> IPC habit.run(args) -> spawn bun habit-gate.ts <args> --json (or EVAOS_HABIT_GATE_BIN)
   |                              stdout JSON {status} | {error}; generation counter drops stale reads
   `-- Gate overlay (locked) -> useOccludeBrowser -> browser.setOccluded -> native view hidden
```

### Recommended Project Structure
```
packages/eva-core/src/
├── fs/                      # EvaFs (extend: stamp, edit, appendLine) - only place with write APIs
├── model/                   # NEW pure parsers (no electron, no DOM)
│   ├── tags.ts              # canonicalTag, TAG_ALIASES
│   ├── plain.ts             # plain() markdown stripper, display name, tagline
│   ├── journal.ts           # parseJournal / parseJournalHeading (distinct from sidebar/journal.ts)
│   ├── todos.ts             # parseOpenTodos, maxTodoId, appendTodo (pure string -> string)
│   ├── workspaces.ts        # workspaceFiles reader, workspaceFrom, dailyActivity, timeline
│   ├── dashboard.ts         # buildDashboard(): filters, stats, per-day arrays
│   ├── jobs.ts              # JobDoc, validate, nameError, nextDue, runState reader, labels
│   ├── gate.ts              # Status types (Zod), streak, parseOutput, clock()
│   └── meetings.ts          # list, digest, parseProtocol, setStatus (pure), todoText
├── clock.ts                 # now()/today() with EVAOS_NOW override
packages/contract/src/eva.ts # new channels (dashboard, workspace, todo.add, jobs.*, habit.*, meetings.*)
apps/desktop/src/main/
├── eva-ipc.ts               # extend; split eva/jobs-ipc.ts, eva/habit-ipc.ts, eva/meetings-ipc.ts
├── eva/watch.ts             # chokidar narrow paths -> emit 'eva.changed'
├── eva/spawn.ts             # bun/habit-gate/job-run spawn helpers (PATH resolution via chat/shell-path.ts)
apps/desktop/src/renderer/
├── dashboard/ workspace/ jobs/ habits/ meetings/ todo/ ui/ActivityChart.tsx
├── pages/registry.ts        # dispatch by slug for kind 'page'
fixtures/eva-p3/             # NEW richer fixture (do not mutate fixtures/eva-root)
fixtures/fake-gate/fake-gate.mjs , fixtures/fake-job-run/fake-job-run.mjs
```

### Pattern 1: Pure transform plus guarded writer
`appendTodo(todosText, doneText, tag, text, today) -> { id, next }` is pure and unit-tested; `EvaFs.edit` supplies the freshest text and refuses if the file changed between read and rename. Same shape for `JobDoc.apply`, `setProposalStatus`.

### Pattern 2: Single-flight reload with one queued follow-up
```typescript
// DASH-06: one request in flight; a trigger during flight queues exactly one follow-up.
let inflight = false, queued = false
export async function reload(): Promise<void> {
  if (inflight) { queued = true; return }
  inflight = true
  try { await fetchAll() } finally {
    inflight = false
    if (queued) { queued = false; void reload() }
  }
}
```
(`refreshSidebar` in `sidebar-store.ts` already does single flight; copy and add the queue.)

### Pattern 3: Generation counter for the gate (port of `habits_view.rs`)
A command bumps `generation` before and after; a poll that started under an older generation, or while `busy`, is dropped. Prevents a stale poll from overwriting the status a write just returned.

### Anti-Patterns to Avoid
- **Parsing job.md with `yaml` and re-serialising.** Destroys comments, quotes and unknown keys. Edit lines in place (JobDoc).
- **Writing `habits.yml` or `gate.json` from the app.** Only the CLI writes them.
- **Shell string commands.** Always `spawn(bin, argv[])`, never `exec`/`shell:true`.
- **Reading `window.innerWidth` for compact mode.** UI-SPEC requires `ResizeObserver` on the page root.
- **Using `readline`-style IO for the gate JSON.** Use `execFile`-like buffering (output is a single pretty-printed JSON document, not lines).

## Exact Rules (port these; each tagged with its Rust source)

### Eva root and aliases [VERIFIED: eva.rs]
- `TAG_ALIASES`: `goodword -> goodops`, `eva-app -> eva-interface`.
- `canonicalTag(tag)`: take text before first `/` (so `eva/e3` -> `eva`), trim, lowercase, then alias map.

### Workspaces [VERIFIED: eva.rs `workspace_files`, `workspace_from`]
- Files: for each entry in `workspaces/`: directory `<stem>` counts only if `<stem>/<stem>.md` is a file (id = stem, path = nested); a plain `<stem>.md` file counts (id = stem). Everything else ignored (so `workspaces/ecardsystems/roadmap-2026-10-14.md` is not a workspace; `workspaces/bambee/bambee.md` is). Live checkout: 10 root `.md` files, `bambee/bambee.md`, `goodops/`, `personal/` nested dirs; `hexagon/` has no `hexagon.md` so it is not a workspace.
- Built-in Eva workspace: if no workspace has id `eva`, add one from the constant text `# Eva\n\nEva's own hub: identity, workflows, memory, jobs, and apps like EvaOS.\n` with `path = null`.
- `name`: first line starting `# `; `display_name`: cut at first `" — "` (em dash with spaces), then at first `" ("`, trim. Fallback = id. (Source-level em dash literal is fine in a parser; UI strings must not contain one.)
- `tagline`: lines after the first `# ` line, trimmed, skip leading blanks, take until blank/`#`/`|`, join with space; strip leading `- `; `plain()`; drop a leading label `"Word: "` when the label is <=12 chars with no space; then first sentence up to and including `". "` (index of ". " inclusive of the dot) else whole text.
- `plain()`: remove `*` and backtick; remove `[`; for `](` drop through the next `)`; trim.
- `sections`: every line starting `## ` -> `plain(rest)`. (UI-SPEC needs section bodies too: extend the port to also capture the body lines between `## ` headings; Rust only had headings.)
- Threads: lines after a line equal (trimmed) to `## Threads`, until next `## `, only lines starting `- `; need first 10 chars of the rest to parse as `YYYY-MM-DD`; text = `plain(rest[10..].trimStart of chars ['/',':',' ','—','-'])`. Notes sorted newest first. **Real files:** 8 workspaces have such bullets (flo 42, bambee 50, relay 20, ecardsystems 5, goodops 5, texo 3, eve-fork 1); `personal.md`, `eva-interface.md` use `### date — title` headings and yield zero notes. Port literally; do not invent a `###` parser (parity with the Rust app and REQUIREMENTS wording "dated `## Threads` bullets") [ASSUMED: Isaac does not expect `###` threads to count].
- `activity` = thread note dates + journal entry dates with `tag == id`, newest first; `lastActive = activity[0]`.
- `latest`: if newest journal entry date >= newest note date -> entry title; else if a note exists -> note text; else entry title; else none.
- `openTodos` = count of open todos with `tag == id`.
- Sort workspaces by `lastActive` descending (none last), then `name` ascending.
- `dailyActivity(today, days)`: array length `days`, oldest first; for each activity date, `age = today - date` in whole days; if `0 <= age < days` then `counts[days-1-age]++`. Future-dated entries (age < 0) are dropped.

### Journal [VERIFIED: eva.rs `parse_journal*`; real journal.md]
- Heading regex equivalent: line starts `## `, first 10 chars after it parse as a date, then the first `[`...`]` anywhere after gives the tag (`canonicalTag`), title = `plain(text after ']')` (this trims a leading `— ` ... note the Rust title keeps any leading dash; the test strings show `## 2026-08-19 — [flo] Title` where the dash is BEFORE the tag, so the title after `]` is clean). Headings without `[tag]` (e.g. `## 2026-07-07 — Eva hub bootstrapped`, `## Digest`) are not entries.
- Body = top-level `- ` bullets only (lines starting exactly `- `; indented bullets ignored), `plain()` each, until the next `## ` line.
- Files: `memory/journal.md` plus every `memory/archive/*.md`. Live `journal.md` has a `## Digest` section of `- date [tag] title -> archive/..` lines; they are under a non-entry heading so they are ignored (the existing `sidebar/journal.ts` heading regex `^## date( [tag])? ...` is a different, looser rule used only for the Recent list; do not reuse it for activity).
- Sorted by date descending (stable).
- Existing Phase 2 `recentJournal` returns file-order-reversed entries and tolerates missing tags; leave it alone.

### Open todos [VERIFIED: eva.rs `parse_open_todos`; real todos.md]
- Start after the line whose trim is `## Open`; stop at the next line starting `## `.
- A row: `- [ ] ` prefix; id = text up to first space and must start with `T`; then a `[tag]` must exist (`find('[')` then `]`), else the row is skipped; text = trimmed remainder after `]`; if it contains `(added ` (rfind) and the 10 chars after parse as a date, set `added` and cut the text before it; `plain(text)`.
- Order is file order. Real file: 24 open rows; rows may be very long (hundreds of chars) so the UI must truncate with `title`.
- Existing `countOpenTodos` already applies the same filters; reuse the same predicate to guarantee counts agree.

### Next todo id and append [VERIFIED: eva.rs `append_todo`, `max_todo_id`]
- `maxTodoId(text)`: scan the WHOLE text for every `T` followed by digits where the previous character is not alphanumeric (so `HTTP2`, `T-rex` are ignored, but ids in prose count). Next id = `max(todos.md, todos-done.md) + 1`. Real files: todos max 75, done max 78, so next = **T79**. A regex equivalent: `/(?<![\p{L}\p{N}])T(\d+)/gu` (verified to give 75/78 on the real files with the manual scan).
- Row: `- [ ] T{n} [{tag}] {text.trim()} (added {YYYY-MM-DD})`. Tag is the workspace id (`eva` for Eva). Collapse newlines in text to spaces before building (UI-SPEC).
- Insert position: find the line equal (trim) to `## Open` (error if absent). `end` = first later line starting `## ` or EOF. Within `(open+1..end)` find the LAST line starting `- [ ] T`; insert AFTER it; if none, insert at `open + 2` (after the blank line that follows the heading). Re-join with `\n` and keep a trailing newline iff the original had one. Real todos.md has prose after the last open row (a blank line, then paragraphs under later `##` headings) so "after last open row" is the right anchor, not end of section.
- `todos-done.md` missing -> treat as empty. `todos.md` missing -> error.
- Test vector to copy: input `# Todos\n\n## Open\n\n- [ ] T6 [flo] a\n- [ ] T65 [relay] b\n\nLives in todos-done.md, cites HTTP2.\n`, done `- [x] T66 [eva] done\n`, append `goodops` `" Ship it "` on `2026-10-02` -> id `T67`, row after T65 (see `eva.rs` test).

### Dashboard computations [VERIFIED: dashboard.rs; README]
- Filters: Active = age <= 14 days; Quiet = no activity or age > 30 days; Has Todos = `openTodos > 0`; All = all. 15 to 30 days old is neither Active nor Quiet. `age = today - lastActive` in days.
- Recent Workspaces = first two of the FILTERED list (sorted by lastActive). The grid shows the REST (everything after those two). Empty grid copy: "No workspaces match this filter." when nothing is shown at all, "Every matching workspace is shown above." when only the two recent exist. UI-SPEC copy already matches this. Keep it; the filter chip counts are over all workspaces, not the rest.
- `relative(date, today)`: `None -> "No activity"`; `<=0 days -> "Today"`; 1 -> "Yesterday"; 2..13 -> `"{n}d ago"`; else `"%b %-d"`. `activeSince`: none -> `never`, <=1 day -> lowercase of relative, else relative.
- Summary line per UI-SPEC: `{W} workspaces, {T} open todos, {U} updates this week` with U = journal entries with `date >= today - 7` (Rust `entries_since`; thread notes do not count). Rust's own summary differs ("N active this week"); UI-SPEC wins.
- Open Todos aside per UI-SPEC lists up to 6 todo rows (id, text, workspace chip). Rust listed workspaces with counts, sorted by count then lastActive. UI-SPEC is the design contract: use todo rows in file order [ASSUMED: file order, not specified; "up to 6" top of file].
- Quick stats: workspaces count, open todos, updates 7 days, PRs to review fixed `0` (Phase 7 supplies).
- Hero: banners `mountains, canyon, redwoods, coast`, 9 s interval, 1400 ms crossfade; assets exist at `/Users/ike/Eva/apps/evaos/assets/images/banners/{name}-{light,dark}.png` (8 PNGs, ~1.2 to 1.7 MB each, ~11.4 MB total). Copy (read-only source) into `apps/desktop/src/renderer/assets/banners/`; Vite hashes them. Consider downscaling is out of scope; 11 MB is acceptable for a local app but note `electron-builder` asar size.

### Jobs [VERIFIED: jobs.rs; job-run.ts `loadJob`; jobs-scheduler.ts; real jobs]
- A job = `jobs/<name>/job.md`; skip dot entries, names failing `^[a-z0-9][a-z0-9-]*$`, folders without a readable `job.md`. Sorted by name. Real jobs: `evaos-electron-watch`, `furry-drop`, `habit-gate`, `job-hunt`, `local-leads`, `route-shadow`; two are `script:` jobs (`script:` key is an unmanaged key; preserve it). Real run dirs: `jobs/.runs/<name>/{last-run, job.log, <runId>/status.json}` and `jobs/.runs/<name>.lock`.
- Frontmatter split (runner): `^---\n([\s\S]*?)\n---\n?([\s\S]*)$`. `JobDoc` keeps frontmatter lines verbatim, a `closeNewline` flag, and the untrimmed body. Key line regex `^([A-Za-z_][\w-]*):\s*(.*)$`; value cleanup = trim then strip ONE leading and ONE trailing quote char; last occurrence of a key wins on read.
- Managed settings: `every`, `enabled` (only literal `false` disables; `False`, `no`, `"false"` after cleanup... note `"false"` quoted IS disabled because quotes are stripped), `max_run`, `keep`.
- `apply(settings)`: only keys whose trimmed value changed are rewritten (first occurrence replaced in place, later duplicates dropped, else appended); empty value removes the key; `set_enabled(true)` rewrites an existing `enabled` line to `true` but adds none; `set_enabled(false)` writes `enabled: false`. Untouched round trip must be byte-identical (Rust test list: JOB sample, `just steps\n`, `---\nevery: 5m\n---no newline body`, empty string).
- Duration syntax (`parse_duration`): trim; `^\d+\s*(ms|s|m|h|d)?$`; bare number = minutes. `every` valid but zero -> invalid ("Must be more than zero"); `max_run` zero invalid; `keep` may be zero. Empty = manual/default.
- **`keep` is a DURATION, default `30m`** (how long the omp session stays alive for late replies), `max_run` default `20m`. UI-SPEC's "Keep integer, keep the last n runs, whole number of 1 or more" is wrong for the runner and would write e.g. `keep: 5`, which the runner reads as 5 MINUTES. See Discrepancy D1.
- `next_due(settings, lastRun)`: none when disabled or `every` missing/invalid; else `(lastRun ?? 0) + every` (never ran -> due immediately). `enabled && every_ms` = "scheduled" (sidebar count; already implemented in `jobScheduled`).
- Labels (Rust): schedule `every {raw}` / `manual`; last run "running" while `.lock` exists, else `"{ago} · {state}"`; `ago`: `<1m just now`, `1..59 -> {m}m ago`, `60..2879 min -> {h}h ago`, else `{d}d ago`; `until`: past -> `due now`, `<1m in under a minute`, `in {span}`. UI-SPEC wants absolute times ("Today 2:30 PM"); derive from the same `next_due` epoch ms with `Intl`. "Daily 08:30" in UI-SPEC does not exist in the data model (only intervals): drop it.
- Run state read: `last-run` file = epoch ms (ignore <=0); run ids = subdirs containing `status.json` whose name matches `^\d{4}-\d{2}-\d{2}T\d{6}$` (17 chars); latest = greatest id; `status.json` fields `state` (running|done|failed|timeout|killed), `startedAt`, `endedAt`, `note`, `sessionFile` (only offered if the file exists). `locked` = `jobs/.runs/<name>.lock` exists. Real status sample: `{"state":"done","sessionFile":"/Users/ike/.omp/agent/sessions/-Eva/<ts>_<uuid>.jsonl","note":"omp exit 0",...}`. Run-state badge mapping: locked -> running; `done` -> ok; `failed|timeout|killed` -> failed (warning); none -> never run; unknown string -> show raw text with dim.
- Stale lock: the runner treats a lock as live only if its first token pid is alive (`process.kill(pid,0)`). Rust ignored this. Recommend the port also checks pid liveness so a crashed run does not show "running" forever [ASSUMED improvement; low risk].
- Writes: create = mkdir `jobs/<name>` (refuse if it exists, "jobs/<name> already exists.") then atomic write of rendered doc; body = steps with a trailing `\n` ensured; update = refuse unless current file text equals the text read when the form opened, then render and write only if changed; `set_enabled` re-reads the current file and edits only the enabled line; delete = `rm -rf jobs/<name>` (run history in `jobs/.runs` stays). Steps must be non-empty ("Write at least one step."); UI-SPEC omits this rule, add it.
- Run now: `bun <root>/.omp/tools/job-run.ts <name>`, cwd = root, stdio ignored, own process group (`detached: true` + `child.unref()` in Node; Rust used `process_group(0)`), PATH = app PATH plus bun's dir, `/opt/homebrew/bin`, `~/.local/bin` (omp lives there). bun resolution: PATH, then `/opt/homebrew/bin/bun`, then `~/.bun/bin/bun`. On this machine bun is `~/.bun/bin/bun` (1.4.2). Name must pass the name regex. job-run.ts takes an O_EXCL lock, so a second start while running is a no-op. Reload the list ~2 s after start (lock appears right after launch).
- Open last session: `latest.sessionFile`; files live in `~/.omp/agent/sessions/-Eva/`, the same dir `resolveLiveSessionsDir` returns, so the existing `chat.open` (which enforces `outside-sessions-dir`) accepts it in live mode; in fixture mode there is no such file (disabled with "No run yet" tooltip, or fixture `status.json` pointing into `fixtures/agent/sessions/-fixture`). Navigation target: open a chat place with `chat = <file>` via `openPlace(placeOf('chat', { chat: file }))`.

### Habit gate CLI contract [VERIFIED: habit-gate.ts, gate.rs, habits_view.rs, live gate.json and habits.yml]
Invocation: `bun <root>/.omp/tools/habit-gate.ts <cmd...> --json`, cwd = root, stdin ignored. Exit 0 prints the full status JSON; exit 1 prints `{"error":"<message>"}` to stdout when `--json` is present (stderr otherwise). Every successful command prints the full status, so the renderer replaces its state with the reply.

| Action | argv (before `--json`) | Notes |
|--------|------------------------|-------|
| read | `status` | |
| start | `start <id>` | already-running id keeps timer; unknown/done-task id errors |
| done | `done <id> [--photo <abs path>]` | errors if timer unfinished ("timer not finished: N min left"), if photo required and missing, if file missing; copies photo to `~/.config/eva/habit-photos/`; one-time task marked done in habits.yml |
| override | `override <reason...>` | errors if not locked or empty reason; reason is the rest joined by spaces |
| add habit | `habit add <name...> --minutes N [--photo]` | `--photo` is a switch here; id is slug of name, auto de-duplicated |
| edit habit | `habit edit <id> --name X --minutes N (--photo \| --no-photo)` | Rust always sends `--no-photo` when photo off on edit, omits it on add |
| remove habit | `habit rm <id>` | |
| add task | `task add <name...> [--minutes N]` | minutes null when omitted |
| remove task | `task rm <id>` | |

Status JSON (camelCase): `locked, lockedAt, reason, active{kind,id,startedAt,endsAt}, plan{date,breaks[{at,done}],source "calendar"|"fallback"}, history[{kind "habit"|"task"|"override", id|null, name, startedAt|null, doneAt, photo|null, override|null}], habits[{id,name,minutes,photo}], tasks[{id,name,minutes|null,done}], schedule{breaks_per_day,window,min_gap_minutes}, canFinish, remainingSeconds, blocked`. Live `~/.config/eva/gate.json` matches (history entries `kind: "habit"`, `photo: null`, `override: null`; `plan.source: "calendar"`). Parse with a lenient Zod schema (`.default()` everywhere, nullable strings -> `''` for kind/id/name as Rust `or_empty`).
- Streak (per habit): set of local dates of `doneAt` for entries with `id == habit.id && override == null`; start at today if present else yesterday; count consecutive days backward. (Test vector in `gate.rs`: walk streak 2.)
- `plan_for(today)`: plan only counts when `plan.date == today` (local). Today's breaks state: done -> Done (success), due (time <= now) and not done -> Due (lock icon, warning; Rust has it, UI-SPEC lists only Done/Upcoming: add "Due"), else Upcoming. Source labels: calendar -> "From your calendar", fallback -> "Evenly spaced (calendar unavailable)", else "Planned".
- Overlay content per Rust: picker items = habits (name, `{n} min`, photo icon) + OPEN tasks (`Task, {m} min` or `Task`); `Start` disabled without selection (UI-SPEC: preselect first). While active: countdown from `endsAt` (`m:ss`, or `h:mm:ss`), Done enabled when timer ended AND (habit photo required -> a photo chosen). The Choose photo control is shown only when the active habit requires a photo (Rust `needs_photo`; tasks never do). History row sort: by `doneAt` descending, first 30 rows; minutes = `doneAt - startedAt` in minutes; override rows show "Overridden: {reason}".
- `MAX_MINUTES = 600`; minutes input must be a whole number 1..600.
- Parser trap: the CLI's `parseArgs` treats any argument starting with `--` as a flag. A free-text override reason or habit/task name that begins with `--` would be misparsed or throw "needs a value". Trim input and reject or prefix leading `--` (for example prepend a space-less guard such as `Reason: `) in the main-process arg builder; unit-test it. Also `--name=X` form is supported by the CLI (`indexOf('=')>0`) and avoids this for habit edit.
- Time: `remainingSeconds` is a snapshot at the call; compute the visible countdown in the renderer from `active.endsAt` with a 1 s ticker (Rust did the same) so the 4 s poll does not make it jump.
- Polling policy (HABT-01): once at app launch (the gate overlay must work from any page, so the store starts in `App`, not on the Habits page), every 4 s while `!document.hidden`, immediately on page open, on window activation, on `reload` action, and right after each command. Single-flight; drop reads that start under an older generation.
- Test seam: `EVAOS_HABIT_GATE_BIN` (env.ts `resolveEnv`) replaces `bun <root>/.omp/tools/habit-gate.ts`; non-live default should be the fake gate (fixtures), so a dev or test run never executes the real gate against `~/.config/eva`. Real mode only when `live`.

### Meetings [VERIFIED: meetings.rs, meetings_view.rs, meeting-memory.ts]
- No `work/meetings/` directory exists in `/Users/ike/Eva` right now (confirmed). Record shape from the writer and Rust tests: `{ stem, title, start (ISO 8601 UTC), notes (abs path to a MeetingTranscriber .md), processed, skipped? (string like "test call (real meeting p=0.02)" or absent), memorized[{kind: availability|decision|ticket|other, text, where[], p}], proposals[{id "<stem>#N", kind todo|ticket, text, workspace?, item?, p, source, status "proposed"|"accepted"|"dismissed"}], ...extra }`. Unknown fields must survive writes.
- List: files `*.json` not starting with `.`; invalid JSON skipped; `stem` = filename stem (overrides the record's own); sorted by parsed `start` descending, undated last, ties by stem descending. `isSkipped`: absent/null/false/"" -> false, non-empty string -> true, anything else -> true. `displayTitle` = title or stem. `pending` = proposals with status `proposed`; unrecognised status reads as `proposed`.
- Grouping: day label `Today`, `Yesterday`, else Rust `Mon, Oct 5` (`%a, %b %-d`); UI-SPEC wants "Sep 14" style for the sidebar; use UI-SPEC for sidebar day headings and keep Rust style available. Undated -> "Undated". Test calls fold into a "Test calls (n)" disclosure; search matches `displayTitle` case-insensitive substring, and a non-empty query force-opens the test-call fold (Rust `open = test_calls_open || !query.is_empty()`).
- Digest (non-skipped only): `recent` = meetings with start within 7 days of now; `waiting` = every `proposed` proposal (newest meeting first); `out` = `availability` memories whose trailing `(YYYY-MM-DD)` is today or later, or, when no date, only from a recent meeting; `decisions` = recent meetings' `decision` memories. `memory_date`/`memory_text` strip a trailing `(YYYY-MM-DD)`.
- Home summary: Rust "N meetings this week. K action items waiting on you."; UI-SPEC "{n} meetings, {k} waiting on you". See Open Question OQ2 for which `n` to use.
- Protocol (`notes` file) parse: `## ` headings switch section (lowercased); `# ` and `---` lines skipped; `**Attendees:**` anywhere gives names split on commas, with an optional trailing `(Source: "...")` (only when the parenthetical contains `:`); `summary` joins wrapped lines into paragraphs split on blank lines and strips `**`; `decisions` and `open questions` are `- `/`* ` bullets with wrapped-line continuation; `full transcript` lines `[mm:ss] Speaker: text` or `[mm:ss] text`, wrapped lines append to the previous; speaker plausible if non-empty, <=40 chars, <=4 words, none of `. ? ! , " [ ]`. Copy the full Rust `PROTOCOL` test sample.
- Accept (Rust order): read record, require proposal `proposed`, append todo with text `todoText` (prefix `Draft ticket: ` for tickets, suffix ` (from meeting <title>, <local YYYY-MM-DD>)`, tag = proposal `workspace` trimmed or `eva`), THEN set status `accepted`. A second accept errors with no duplicate append. Dismiss = set status `dismissed` only. **Dismiss writes `proposals[i].status`** (the proposal, not a top-level record field; CONTEXT/REQUIREMENTS wording "record's `status` field" means that).
- JSON write format: `JSON.parse` the file, mutate, `JSON.stringify(value, null, 2) + '\n'` (this is what `meeting-memory.ts` itself writes, and `JSON.parse` keeps key order). The Rust app used `serde_json::to_string_pretty` without `preserve_order`, which alphabetises keys on rewrite; matching the writer's insertion order gives a smaller diff, and tests should compare parsed values like the Rust test does.
- Todo write is two files in sequence (todos.md then the meeting JSON); if the second write fails after the first succeeded, surface the new todo id in the error and let the UI re-read (the proposal would otherwise be re-acceptable and duplicate the todo). Do the status pre-check inside the same serialized edit queue.

## Existing Code Survey (what to reuse, what to change)

| Asset | State | Phase 3 action |
|-------|-------|----------------|
| `packages/eva-core/src/fs/eva-fs.ts` | `write(kind, rel, data)` = whole-file atomic write; `remove('job-delete')`. No stamp, no re-read, no append. | Add `readStamp`, `edit(kind, rel, fn, { expected? })` (read, apply pure fn, re-stat, atomic write, throw `code: 'changed-on-disk'`), `create(kind, rel, data)` (fail if exists), `appendLine` for later append-only files. Serialize per file path with `createWriteQueue` from `main/write-queue.ts` or a copy inside eva-core |
| `fs/allowlist.ts` | Kinds: `todo-append` (`memory/todos.md` only), `file-save`, `job-md` (`jobs/<name>/job.md`, NAME_RE allows `_`), `job-delete`, `meeting-status` (`work/meetings/<stem>.json`) | Sufficient for Phase 3. Tighten NAME_RE to `^[a-z0-9][a-z0-9-]*$` for `job-md`/`job-delete` to match the runner (underscore names would not be runnable). No kind for habits (CLI owns them) |
| `fs/write-trap.ts` + `main/eva/write-guard.ts` | Patches `fs` APIs; protected roots = evaRoot and `~/Eva`; allowed = repo, configDir, tmpdir | Child processes are unaffected (bun/habit-gate writes happen in their own process, correct). Trap has a quirk to remember: tests that copy a fixture to `os.tmpdir()` are inside allowRoots, fine |
| `write-scan.test.ts` | Regex scan of `apps/desktop/src/main` and `packages/*/src` excluding `packages/eva-core/src/fs/` and tests; only `config-store.ts` allowlisted | New main code must not call `writeFile/rename/rm/mkdirSync/appendFile` outside `eva-core/src/fs`. Extend the scan to also cover `apps/desktop/src/renderer` and `apps/desktop/src/preload` (CONTEXT asks to extend it) and make `eva-core` spawn helpers live outside the regex (spawn is not matched). `chokidar` is read-only so safe |
| `eva-core/src/sidebar/*` | `countOpenTodos`, `jobFrontmatter` (first key wins; Rust/runner last wins), `parseDurationMs`, `recentJournal` | Keep for the sidebar. New `model/jobs.ts` implements the runner's last-wins `get`. Optionally re-point `jobScheduled` at the new parser to remove the divergence (must keep Phase 2 tests green) |
| `packages/contract/src/eva.ts` | one channel `eva.sidebar` | Add channels; keep `.strict()` objects, `{ok,value|error}` via `handle()`. `handle` already maps `error.code` kebab strings to result codes: throw `Object.assign(new Error(msg), { code: 'changed-on-disk' })` |
| `main/eva-ipc.ts` | read-only handler | Extend (or split files). Keep the "reads only" comment true by routing writes through EvaFs |
| `main/env.ts` | `evaRoot`, `ompBin`, `configDir`, ... fixture defaults, refuses real root unless `EVAOS_LIVE=1` | Add `habitGateBin`, `jobRunBin`, `now` (`EVAOS_NOW`) with fixture defaults, plus tests in `env.test.ts` |
| `main/chat/shell-path.ts`, `omp-transport.ts` | resolves login-shell PATH once in live mode; runs `.mjs` via node when `node` not on PATH | Reuse for bun lookup and for spawning `.mjs` fakes (copy the `nodeOnPath` fallback: use `process.execPath` with `ELECTRON_RUN_AS_NODE=1` in the CHILD env only) |
| `main/test-hooks.ts` | `registerTestHook(name, value)` | Register `spawnLog` hooks so e2e can assert what was spawned without reading files |
| `renderer/pages/registry.ts`, `PageRouter.tsx` | `pageRegistry[meta.kind]`; kind `page` maps to `PlaceholderPage` for every nav page | Dispatch by slug for kind `page` (`dashboard`, `jobs`, `habits`, `meetings`), keep placeholders for others; `workspace` kind -> WorkspacePage; `meeting` kind -> MeetingPage. Page roots must keep `data-testid="page-<slug>"` |
| `renderer/pages/page-meta.ts`, `tabs/tab-meta.ts` | Workspace tab title = raw id; meeting title = stem; icon `IconFile` | Look up workspace name / meeting title from the stores (fallback to id/stem); add `IconFolder` / `IconUsers`. Tests in `page-meta.test.ts`, `tabs` will need updates |
| `shell-core/place.ts` | Meeting detail is `{page:'meetings', meeting: stem}` (not a separate page key); workspace is page `workspace:<id>`; scroll key `meeting:<stem>` / `workspace:<id>` | CONTEXT wording `meeting(stem)` maps to this. No place model change needed |
| `renderer/hotkeys/router.ts`, `shell-core/chord.ts` | `cmd+n -> new-todo`, `cmd+r -> reload` already in `GLOBAL_CHORDS`; `runAction` is a no-op without a registered handler | `registerAction('new-todo', open modal)`; `registerAction('reload', reloadActivePage + refreshSidebar)` (the sidebar one is registered in `startSidebar`; `runAction` calls only the LAST registered function, so the new handler must itself call `refreshSidebar()` or both must share one registration) |
| Gate overlay hotkey suppression | no mechanism | Add a "gate locked" flag consulted by `dispatchChord` before scope dispatch: while locked, only `cmd+q` passes. Note `cmd+q` is a native menu role in main; confirm the app menu keeps it |
| `renderer/overlay/*`, `useOccludeBrowser` | `EvaModal` (zIndex 300, `useOccludeBrowser`, `useDismissable`), `EvaMenu`, `EvaPopover` | Use as is. Gate overlay is NOT an EvaModal: custom root at z-index 400 calling `useOccludeBrowser(true)` while mounted, not on the dismiss stack |
| `dirty-store.ts` | registry used by quit guard | Register job form drafts (label "Job <name>") per UI-SPEC |
| `renderer/ui/ScrollArea` + scroll memory | page scroll keyed by `placeKey` | Reuse. `data-testid="page-scroll"` |
| Notifications | `<Notifications position="bottom-left" />` in `main.tsx`; `notifications.show` used in settings | UI-SPEC says bottom-right: change position (check `layout-store` usages and any e2e that assumes left) |
| `renderer/styles/motion.css` | `.eva-cue-{hero,sections,first-card,first-chart,second-card,second-chart,grid-cards,aside-title,aside-rows,stats-title,stat-cards}` with `--i` steps and per-cue delays | Attach classes; cues are disabled under `html[data-eva-motion="off"]` |
| e2e | `fixtures.ts` shares `EVA_FIXTURE_ROOT` (`fixtures/eva-root`: alpha, beta, 3 jobs, 2 todos) across specs; `proofShot` composite; `pages.spec.ts` asserts the OLD placeholder copy for dashboard/jobs/habits/meetings | Specs that write must copy a fixture to a temp dir and pass `launchEnv.EVAOS_EVA_ROOT`. Update `pages.spec.ts` (and `page-meta`/`PageRouter` unit tests) for the four pages that stop being placeholders |
| Existing fixtures | `fixtures/eva-root` is referenced by Phase 2 sidebar tests (2 todos, scheduled job count) | Do not change it. Create `fixtures/eva-p3/` (richer, includes `workspaces/`, a `###`-thread workspace, a nested `<id>/<id>.md`, `memory/archive/*.md`, `jobs/.runs/**`, `work/meetings/*.json` including a test call, `habits`-style fake gate state) |

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Charts, tooltips, axes | custom SVG chart | `@mantine/charts` `CompositeChart` (or Recharts) | locked; accessibility alt via hidden table is the only custom part |
| Atomic write + stale check | ad hoc `fs.writeFile` in handlers | `EvaFs` (extended) | write-scan and trap enforce it |
| Duration parse/format, relative time | one-off regexes per component | one `model/jobs.ts` `parseDuration` + `labels.ts` | runner syntax parity |
| Native open | `child_process.exec('open ...')` | `shell.openPath` (main) | CONTEXT; handles default apps |
| File dialog | `<input type=file>` | `dialog.showOpenDialog` in main (image filters), stubbed in e2e via `app.evaluate` | native dialogs are not intercepted by Playwright |
| Process spawn | shell strings | `spawn(bin, argv)` arrays, detached for jobs | injection safety and process-group parity |
| JSON status validation | manual field checks | Zod lenient schemas | project pattern |
| Modals/menus | raw Mantine `Modal` | `EvaModal`/`EvaMenu`/`EvaPopover` | overlay lint test fails otherwise |

**Key insight:** every "rule" here is deceptively exact (`T` ids in prose, `enabled: "false"` quoting, last-occurrence key wins, key-order preservation). Port tests first and generate the implementation to satisfy them.

## Runtime State Inventory

Not a rename/refactor phase. Omitted. (Related runtime state worth knowing: `~/.config/eva/gate.json` and `~/.config/eva/habit-photos/` are owned by the CLI; `jobs/.runs/` is owned by the runner; this phase only reads them and never writes there.)

## Discrepancies Between UI-SPEC / CONTEXT and the Real Sources (planner must resolve explicitly)

| # | UI-SPEC / CONTEXT says | Source of truth says | Recommendation |
|---|------------------------|----------------------|----------------|
| D1 | "Keep" is an integer count of runs, validation "whole number of 1 or more" | `keep` is a duration, default `30m`, minutes if bare (`job-run.ts`, `jobs.rs`) | Treat Keep as a duration field with the same syntax as Max run; label "Keep alive" or keep "Keep" with helper "How long the session stays open for replies"; accept empty = default; zero allowed |
| D2 | Name must start with a letter | runner regex `^[a-z0-9][a-z0-9-]*$` (leading digit OK; `0-nightly` is valid per Rust test) | Validate with the runner regex; copy "Use lowercase letters, numbers and hyphens, starting with a letter or number." Updates the UI-SPEC string |
| D3 | Duration copy "m, h or d" | runner also accepts `ms`, `s`, bare minutes | Accept the full runner syntax; error text may name m/h/d only. Reject zero for Interval and Max run |
| D4 | Schedule shown as "Every 2h", "Daily 08:30", "Manual" | only intervals exist | Render `Every {raw}` / `Manual`; no Daily |
| D5 | Steps validation absent | Rust requires non-empty steps | Add "Write at least one step." inline |
| D6 | Run badge `ok/failed/running/never run` | states are `running/done/failed/timeout/killed` plus the lock | Map as in Jobs rules above |
| D7 | Open Todos aside lists todo rows | Rust listed workspaces with counts | Follow UI-SPEC (todo rows) |
| D8 | Override "min 3 characters" | CLI requires non-empty trimmed | Keep 3 in the UI (stricter is harmless), CLI is the real gate |
| D9 | Today's breaks has Done / Upcoming only | Rust also has Due (locked, warning) | Add Due |
| D10 | Overridden reason shown in "Today's breaks" | Rust shows it in History rows (override entries live in `history`, not `plan.breaks`) | Show in History; Today's breaks only reflects plan break state. Note override entries do mark due breaks done via `settleBreaks`, so a break can appear Done with the reason found in History [ASSUMED acceptable] |
| D11 | `mm:ss` countdown | Rust `clock()` uses `m:ss` and `h:mm:ss` | Use Rust format for >=1 h timers (minutes can be up to 600) |
| D12 | Toasts bottom-right | `main.tsx` has bottom-left | Change to bottom-right (UI-SPEC), update any e2e relying on left |
| D13 | Dismiss "writes the record's status field" | writes `proposals[i].status` | As Rust |
| D14 | `yaml` for frontmatter (CONTEXT) | no Phase 3 YAML parse needed | Do not add `yaml` |
| D15 | Meetings sidebar: dot for proposals waiting | Rust shows the pending COUNT per row | Dot per UI-SPEC; optionally add count to aria-label |

## Common Pitfalls

### Pitfall 1: Charts render nothing in jsdom
**What goes wrong:** Recharts `ResponsiveContainer` measures 0x0 in jsdom, so component tests of charts pass vacuously or crash.
**How to avoid:** Unit-test the data prep (`dailyActivity`, series building, week-range index math) as pure functions; assert charts only in Playwright with `data-testid` plus the visually hidden accessible table the UI-SPEC requires (it carries the same numbers, so e2e can assert totals from DOM text).
**Warning signs:** snapshot tests with empty SVG.

### Pitfall 2: Hatched current week
**What goes wrong:** Mantine `referenceAreas` take a flat `color`; an SVG pattern fill may not be accepted.
**How to avoid:** Wave-0 spike in a throwaway renderer test page or Playwright: try `referenceAreas` `color="url(#eva-hatch)"` with `<defs>` supplied through `children`/`customized`; if not accepted, build `ActivityChart` on Recharts directly (`ComposedChart`, `Bar`, `Line type="monotone"`, `ReferenceArea fill="url(#hatch)"`). Decide once; do not branch per use. Colors must be CSS variables (`var(--eva-c-primary-background)`), `color-mix` allowed. Mantine theme variables vs `--eva-c-*`: charts must reference the Eva variables explicitly.

### Pitfall 3: EvaFs stale-write refusal vs concurrent Eva writes
**What goes wrong:** Eva (omp) edits `memory/todos.md` constantly. A read-then-write window of even tens of ms can clobber an edit.
**How to avoid:** in `EvaFs.edit`: read text + stat, run pure transform, `stat` again right before rename and compare `mtimeMs` and `size` (and content hash of the original); on mismatch retry once with fresh text for the append case (append is commutative), but REFUSE for job.md (user's edit basis is a form). Atomic rename cannot be made lock-free against external editors; document the residual window.
**Warning signs:** todo ids duplicated (two writers computing same next id).

### Pitfall 4: Next id scan counts ids inside prose
Use the exact whole-text scan including prose, not just `- [ ]` rows. Test with `HTTP2`, `T-rex`, ids inside done lines.

### Pitfall 5: CLI flag injection through free text
See Habit gate parser trap. Unit-test arg builders for inputs `--x`, `--photo`, `a=b`, leading/trailing spaces, unicode.

### Pitfall 6: Habit polling leaks and overlap
Polling every 4 s spawns `bun` each time (~50 to 150 ms). Single-flight, pause on `document.hidden`, drop on generation mismatch, back off is unnecessary. Kill nothing; use a 15 s timeout on `status` with SIGKILL of the child only (it is ours).

### Pitfall 7: Gate overlay and keyboard
While locked all chords except `cmd+q` are suppressed, but `TERMINAL_PASS_THROUGH` and native menu accelerators bypass the renderer router (menu roles: copy/paste are fine). Verify the Electron app menu (`menu.ts`) does not bind reload/devtools accelerators that bypass; focus trap with `role="dialog" aria-modal`. The guest browser view is hidden, so no forwarded `app.hotkey` events arrive from it; still guard `dispatchChord`.

### Pitfall 8: Time and timezones
`start` ISO strings are UTC; "day" grouping, streaks, "today" and plan dates use LOCAL dates (`NaiveDate` from `Local`). Use `new Date(iso)` + local getters; never slice the ISO string. Inject `now` (`EVAOS_NOW`) in main and expose to renderer through the dashboard payload (`today` string) so charts and labels agree; e2e fixtures generate dates relative to the real current day at test time (a fixture builder script writing into the temp copy) so the suite does not rot.

### Pitfall 9: Workspace Open File and path safety
`shell.openPath(abs)`: main must resolve the workspace id to the path itself (never accept a renderer path), then `shell.openPath`. For Open Notes, the meeting's `notes` path comes from a JSON file in the Eva checkout (untrusted-ish): require it to be absolute, `realpath` it and refuse anything that is not a regular file; for proof photos allow only paths inside `~/.config/eva/habit-photos` (or the fake gate's photo dir in tests). `shell.openPath` returns an error string (not a throw): surface the UI-SPEC toast when non-empty.

### Pitfall 10: pnpm and electron-vite builds
New deps are renderer-only except `chokidar` (main). `externalizeDeps` defaults externalise `dependencies`, bundle `devDependencies`; keep chokidar in `devDependencies` so it is bundled (ESM-only package inside electron-vite 6 main bundle is fine); do not add it to `dependencies` (packaged app only ships `electron-chrome-*` today). Verify with `pnpm -C apps/desktop build` and the packaged smoke (`gate.sh`). If chokidar bundling misbehaves, fall back to `fs.watch` on the same narrow paths behind the same interface.

### Pitfall 11: Banner images and Vite
Import banners with `new URL('./banners/mountains-dark.png', import.meta.url)` or static imports so Vite hashes them; keep all four mounted (opacity) for pre-decoding as Rust did, but `loading="eager"`. Respect `html[data-eva-motion="off"]` (first banner only, no timer) and `document.hidden` pause.

### Pitfall 12: Existing tests will break
`pages.spec.ts`, `page-meta.test.ts`, `PageRouter.test.tsx`, `sidebar.test.tsx` (meetings empty copy "Your meetings arrive in a later update."), tab title tests. Plan updates in the same plans that change behavior, not at the end.

### Pitfall 13: Native view proof screenshots
Gate overlay proof must assert the browser view is hidden (`browser.setOccluded` -> `visible=false`) because `page.screenshot` never shows native views; use the existing `proofShot` composite plus a hook assertion.

## Code Examples

### Pure todo append (port of `append_todo`)
```typescript
// Source: /Users/ike/Eva/apps/evaos/src/eva.rs append_todo (read-only reference)
export function maxTodoId(text: string): number {
  let max = 0
  for (const m of text.matchAll(/(?<![\p{L}\p{N}])T(\d+)/gu)) max = Math.max(max, Number(m[1]))
  return max
}
export function appendTodo(todos: string, done: string, tag: string, text: string, today: string) {
  const id = `T${Math.max(maxTodoId(todos), maxTodoId(done)) + 1}`
  const row = `- [ ] ${id} [${tag}] ${text.trim()} (added ${today})`
  const lines = todos.split('\n')               // keep a trailing '' when text ends with \n
  const hadFinalNewline = todos.endsWith('\n')
  const body = hadFinalNewline ? lines.slice(0, -1) : lines
  const open = body.findIndex((l) => l.trim() === '## Open')
  if (open < 0) throw Object.assign(new Error('todos.md has no ## Open'), { code: 'invalid-data' })
  let end = body.findIndex((l, i) => i > open && l.startsWith('## '))
  if (end < 0) end = body.length
  let last = -1
  for (let i = open + 1; i < end; i++) if (body[i]!.startsWith('- [ ] T')) last = i
  const at = last < 0 ? open + 2 : last + 1
  const out = [...body.slice(0, at), row, ...body.slice(at)].join('\n')
  return { id, next: hadFinalNewline ? `${out}\n` : out }
}
```
(Note: Rust's `insert_at = open + 2 + ix` where `ix` is relative to `open+1`, i.e. `last + 1` absolute; the example matches that.)

### EvaFs edit primitive (shape to implement)
```typescript
// packages/eva-core/src/fs/eva-fs.ts (new)
edit(kind: WriteKind, rel: string, fn: (current: string) => string,
     opts?: { expected?: string; retryOnChange?: boolean }): Promise<{ text: string }>
// throws EvaFsDenied (allowlist) or Error{code:'changed-on-disk'}; writes via atomicWrite inside withEvaFsWrite
create(kind: 'job-md', rel: string, data: string): Promise<void>   // refuses if jobs/<name> exists ('already-exists')
```

### Detached job spawn (port of `run_command`)
```typescript
import { spawn } from 'node:child_process'
const child = spawn(bunPath, [path.join(root, '.omp/tools/job-run.ts'), name], {
  cwd: root, env: { ...process.env, PATH: childPath }, stdio: 'ignore', detached: true,
})
child.unref() // never waited on, never killed by the app
// test seam: EVAOS_JOB_RUN_BIN -> spawn(thatBin, [name]) and registerTestHook('jobRuns', calls)
```

### Habit gate runner
```typescript
function run(args: string[]): Promise<Status> {
  return new Promise((resolve, reject) => {
    execFile(bin, [...prefixArgs, ...args, '--json'], { cwd: root, timeout: 15_000, maxBuffer: 4_000_000 },
      (e, stdout, stderr) => {
        let v: unknown; try { v = JSON.parse(stdout) } catch { v = null }
        const msg = typeof (v as any)?.error === 'string' ? (v as any).error : null
        if (msg) return reject(new GateError(msg))
        if (e) return reject(new GateError(`The habit gate failed: ${stderr.trim().split('\n').pop() || 'no output'}`))
        resolve(StatusSchema.parse(v))
      })
  })
}
```
(`execFile`, not `exec`; with `stdin` closed by default via `stdio` ignore set through `child.stdin?.end()`.)

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| gpui `BarChart`/`LineChart` drawn with canvas overlays | Mantine 9 `CompositeChart` (bar+line+area, `referenceAreas`) on Recharts 3 | Mantine 9 / Recharts 3.x [CITED: mantine.dev/charts] | one chart, no two-layer overlay |
| Rust polling `PollWatcher` for session/tree dirs (`watch.rs`) | chokidar 5 on narrow paths | decision in CONTEXT | `watch.rs` itself is not needed for Phase 3 pages (it served sessions and the inbox); Rust Dashboard reloaded only on focus/refresh, so chokidar is an enhancement for live running-state in Jobs and external todo edits |

**Deprecated/outdated:** none relevant.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `###` dated thread headings should not count as activity (literal Rust parity) | Exact Rules: Workspaces | Dashboard activity looks sparse for `personal` and `eva-interface`; easy to extend later |
| A2 | Open Todos aside shows the first 6 todos in file order | Dashboard computations | Wrong ordering preference |
| A3 | Pid-liveness check for stale `.lock` (improvement over Rust) | Jobs | Slight divergence from Rust; could show "running" for a live pid reused by another process |
| A4 | Override text shown in History rather than Today's breaks | Discrepancies D10 | UI-SPEC wording asks for Today's breaks |
| A5 | `@mantine/charts` CompositeChart can host the hatch pattern | Pitfall 2 | Fallback to Recharts direct (planned) |
| A6 | `react-is@19.3.1` needed explicitly for pnpm strict peers | Standard Stack | Harmless extra dependency if not |
| A7 | chokidar 5 bundles cleanly in electron-vite 6 main | Pitfall 10 | Fallback to `fs.watch` |
| A8 | Meeting count `n` in the home summary (see OQ2) | Meetings | Copy mismatch |
| A9 | `slopcheck` unavailable; packages approved via project stack, not tool | Package audit | Low |

## Open Questions

1. **Hatched week implementation**
   - Known: Mantine `referenceAreas` and BarChart `children` (defs) are documented; hatch via CompositeChart not confirmed.
   - Unclear: whether `color` accepts `url(#id)`.
   - Recommendation: first task of the chart plan is a 30-minute spike; fallback Recharts direct.
2. **Meetings home count `n`**
   - Known: Rust counts meetings in the last 7 days ("this week"); UI-SPEC copy drops "this week".
   - Recommendation: compute `n` over non-skipped records in the last 7 days and word it "{n} meetings this week, {k} waiting on you" (one-word UI-SPEC deviation, logged), or count all non-skipped and keep copy. Default pick: the former (Rust parity).
3. **Fixture dates**
   - Recommendation: `e2e/helpers/eva-fixture.ts` builds the temp Eva root at test time with dates relative to `EVAOS_NOW`/today; unit-test fixtures use fixed dates and an explicit `today` argument.
4. **`cmd+r` handler composition**
   - Known: `runAction` calls only the last registered handler.
   - Recommendation: one `reloadActive()` registered once at App start that calls the active page loader plus `refreshSidebar()`; remove the sidebar-only registration or make the sidebar register through the same fan-out.
5. **Habit gate default in dev mode**
   - Recommendation: non-live defaults to the fake gate (like `ompBin`). `EVAOS_LIVE=1` runs the real CLI against `~/.config/eva`. Confirm `scripts/env.sh` and dev scripts do not need the real gate.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| node | tooling, fake scripts | yes | v24.22.0 | none needed |
| bun | real habit-gate and job-run (live), Rust parity | yes | 1.4.2 at `~/.bun/bin/bun` | tests use fakes, so bun not required in CI |
| pnpm | install | via corepack (not verified here; Phase 1 used it) | 12.11.2 pinned | `corepack enable` |
| pip / slopcheck | package audit | no | none | npm registry checks done; flagged |
| Eva checkout (`/Users/ike/Eva`) | live mode only | yes | read-only | fixtures |
| `work/meetings/` data | meeting fixtures | no such directory in live checkout | none | synthetic fixture from writer shape |
| Playwright Electron | e2e | yes (Phase 1/2 specs exist) | 1.64.1 | none |

**Missing dependencies with no fallback:** none.
**Missing with fallback:** real meeting records (use synthetic), slopcheck (documented).

## Validation Architecture

`workflow.nyquist_validation` is `false` in `.planning/config.json`, but the request explicitly asked for this section, so it is included.

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest 5.0.4 (projects: `packages/*`, `apps/desktop` jsdom, `scripts`) + Playwright 1.64.1 Electron |
| Config file | `/Users/ike/Eva/work/evaos-electron/vitest.config.mts`, `packages/*/vitest.config.mts`, `apps/desktop/vitest.config.mts`, `apps/desktop/playwright.config.ts` |
| Quick run command | `pnpm exec vitest run packages/eva-core` (parsers/writers) ; `pnpm exec vitest run apps/desktop/src/renderer/<dir>` |
| Full suite command | `pnpm exec vitest run` then `pnpm -C apps/desktop build && pnpm -C apps/desktop e2e:run` ; phase gate `bash scripts/gate.sh` |

### Phase Requirements to Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| DASH-01 | workspace file discovery (flat, nested, built-in eva, aliases) | unit (fixture tree) | `pnpm exec vitest run packages/eva-core/src/model/workspaces.test.ts` | Wave 0 |
| DASH-02 | journal heading styles, archive merge, thread bullets, open todos | unit + real-file snapshot (read-only copy of excerpts) | `.../model/journal.test.ts`, `todos.test.ts` | Wave 0 |
| DASH-03 | filters 14/30 days, summary singular/plural, banner rotation timer pause | unit + component | `.../model/dashboard.test.ts`, renderer test | Wave 0 |
| DASH-04 | `dailyActivity` ranges, current-week index, chart data prep | unit; chart render via e2e | `.../model/workspaces.test.ts`; `e2e/dashboard.spec.ts` | Wave 0 |
| DASH-05 | compact/wide threshold via ResizeObserver (`data-compact`), grid excludes recent two | component + e2e | `e2e/dashboard.spec.ts` | Wave 0 |
| DASH-06 | single-flight reload with one queued follow-up; focus/⌘R/refresh triggers | unit (store) + e2e | `renderer/dashboard/dashboard-store.test.ts` | Wave 0 |
| DASH-07 | next id, insert position, trailing newline, changed-file refusal, modal flow | unit (Rust test vector) + EvaFs integration (temp dir) + e2e file content assert | `.../model/todos.test.ts`, `fs/eva-fs.test.ts` | Wave 0 / extend |
| DASH-08 | timeline merge + show all, sections, Open File call | unit + e2e (stub `shell.openPath`) | `.../workspaces.test.ts`; `e2e/workspace.spec.ts` | Wave 0 |
| JOBS-01 | list, labels, next due, run state mapping, lock | unit (`.runs` fixture tree) | `.../model/jobs.test.ts` | Wave 0 |
| JOBS-02 | byte-identical round trip, only edited lines change, validation messages, stale refusal, create exists | unit + EvaFs integration | `.../model/jobs.test.ts`, `fs/eva-fs.test.ts` | Wave 0 |
| JOBS-03 | spawn argv/cwd/detach (via seam), delete removes folder not `.runs`, open last session | unit (argv builder) + e2e with `EVAOS_JOB_RUN_BIN` log | `main/eva/spawn.test.ts`; `e2e/jobs.spec.ts` | Wave 0 |
| HABT-01 | status parse, streak, plan_for, polling policy, generation drop | unit + store test + e2e with fake gate | `.../model/gate.test.ts`, `renderer/habits/habit-store.test.ts` | Wave 0 |
| HABT-02 | argv per subcommand incl. `--`-prefixed text, error mapping | unit + e2e with fake gate recording args | `main/eva/habit-args.test.ts` | Wave 0 |
| HABT-03 | overlay shows when locked, hides browser view, Start/Done/Photo/Override, chords suppressed | component + e2e (`browser.setOccluded`, stubbed dialog) | `e2e/gate.spec.ts` | Wave 0 |
| MEET-01 | list order, grouping, folding, search, undated | unit + e2e | `.../model/meetings.test.ts`; `e2e/meetings.spec.ts` | Wave 0 |
| MEET-02 | digest, protocol parse (Rust sample), summary line | unit | `.../model/meetings.test.ts` | Wave 0 |
| MEET-03 | accept appends todo then status, no duplicate on second accept, dismiss keeps unknown fields and key order | unit + EvaFs integration + e2e file assert | `.../model/meetings.test.ts` | Wave 0 |

### Sampling Rate
- **Per task commit:** `pnpm exec vitest run <touched package or dir>`
- **Per wave merge:** `pnpm exec vitest run && pnpm -r typecheck && pnpm exec eslint .`
- **Phase gate:** `bash scripts/gate.sh` green (install check, typecheck, eslint, prettier, em-dash lint, vitest, build, e2e, packaged smoke) before verify; plus screenshots under `proof/phase-3/`.

### Wave 0 Gaps
- [ ] `packages/eva-core/src/model/*.test.ts`: translate the Rust unit tests 1:1 (`eva.rs`, `jobs.rs`, `meetings.rs`, `gate.rs` test modules are the source) plus real-file excerpt snapshots (todos T79, `###` threads, `script:` job)
- [ ] `packages/eva-core/src/fs/eva-fs.test.ts`: extend for `edit`, stale refusal, `create` exists, per-file serialization
- [ ] `fixtures/eva-p3/` + `e2e/helpers/eva-fixture.ts` (dated builder, copy to tmp, returns env)
- [ ] `fixtures/fake-gate/fake-gate.mjs` (stateful JSON file in a temp dir; implements status/start/done/override/habit/task; supports a "locked" scenario flag and records argv) and `fixtures/fake-job-run/fake-job-run.mjs` (writes a `.lock`, then `status.json`, to the fixture `.runs`; records argv)
- [ ] Env seams `EVAOS_HABIT_GATE_BIN`, `EVAOS_JOB_RUN_BIN`, `EVAOS_NOW` in `main/env.ts` + `env.test.ts`
- [ ] Extend `write-scan.test.ts` to cover renderer and preload dirs
- [ ] Update `pages.spec.ts`, `page-meta.test.ts`, `PageRouter.test.tsx`, `sidebar.test.tsx` for non-placeholder pages
- [ ] Chart spike result recorded (hatch approach) before building `ActivityChart`
- [ ] Framework install: `pnpm -C apps/desktop add -D @mantine/charts@9.7.2 recharts@3.10.1 react-is@19.3.1 chokidar@5.0.0`

Proof screenshots: use `proofShot` composite (shell page plus native views) into `proof/phase-3/` with `EVAOS_PROOF=1`; every screenshot paired with a state assertion as UI-SPEC lists (rects, `data-compact`, row counts, file content). Native file dialog stubbed with `app.evaluate` (`dialog.showOpenDialog = async () => ({canceled:false, filePaths:[...]})`). Entrance cues disabled with `html[data-eva-motion="off"]` (`EVAOS_NO_MOTION=1`) except one motion-on assertion (hero opacity starts < 1, reaches 1 within 2.0 s).

Manual-only (record as `still-needs-isaac` in VERIFICATION.md): running the real habit gate against `~/.config/eva` and the real Outlook-backed plan; Run now against a real job (CLAUDE.md forbids running live jobs unattended); feel of banner crossfade.

## Security Domain

`security_enforcement` is absent in config, so it is treated as enabled.

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | no | single-user local app |
| V3 Session Management | no | none |
| V4 Access Control | yes | IPC `handle()` already rejects non-app senders (`isAppUrl`); renderer never sends filesystem paths for writes; main resolves ids to paths |
| V5 Input Validation | yes | Zod `.strict()` inputs on every new channel; name regex `^[a-z0-9][a-z0-9-]*$`; stem regex (`STEM_RE`) and no path separators; minutes 1..600; length caps on todo text (for example 2000 chars), job steps (200 KB), reasons |
| V6 Cryptography | no | none; no secrets handled |
| V12 Files/resources | yes | `matchWrite` containment (no absolute, no `..`, symlink escape), write trap, `shell.openPath` only on main-resolved or realpath-validated regular files, photo paths limited to the habit-photos dir |

### Known Threat Patterns

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Path traversal via job/meeting names | Tampering | allowlist regexes + `contain()` realpath check in `EvaFs` (exists) |
| Argument injection into habit-gate CLI | Tampering | `spawn` with argv array, never shell; guard leading `--` in free text |
| Command injection through job name | Elevation | name regex before spawn (Rust did the same) |
| Malicious `notes` path in a meeting JSON | Information disclosure | realpath + regular-file check before `openPath`; never read arbitrary paths into the renderer beyond the parsed protocol of an allowed file (restrict reads to absolute paths ending `.md`) |
| Markdown/HTML in workspace or transcript text | Tampering (XSS) | render as React text children only (existing T-02-35 rule); no `dangerouslySetInnerHTML`, no markdown renderer in this phase |
| Stale-write clobbering Eva's files | Tampering | stamp + re-stat refusal; temp-then-rename |
| Killing processes the app did not spawn | DoS | job runs are `unref`'d and never signalled; overlay actions only call CLI |
| Live data in tests | Info disclosure | `resolveEnv` refuses the real root unless `EVAOS_LIVE=1`; fake gate default in non-live |

## Project Constraints (from CLAUDE.md)

- Isaac is asleep; never wait for input; verify instead of skipping; `human_needed` items: test with Playwright for Electron, screenshots in `proof/phase-<N>/`, record in `VERIFICATION.md` as `agent-verified` or `still-needs-isaac`; `gaps_found` after retry: defer and list under `## Deferred gaps`.
- A phase is not done unless the app builds and launches; run tests before completing.
- Read-only: `/Users/ike/Eva/apps/evaos`, `/Users/ike/Eva/work/relay`, anything outside this repo except the exact Eva data writes EvaOS performs. No global config changes, no remote, no push. Commit per completed plan on `main`.
- Browser keeps Bitwarden and Arc import (Phase 5 concern; the gate overlay must hide the browser view, which already hosts those).
- Stack fixed: Electron 44.7.2, React 19.3.1, TypeScript ~6.0.3, Mantine 9.7.2, Vite 8.3.4, pnpm, Vitest, Playwright; Zod 4.6.7; zustand 5.0.15; hand-rolled typed IPC with `{ok,value|error}`; no `electron-store`; atomic temp+rename for writes; `contextIsolation` and sandbox on; Mantine overlays only through the wrappers.
- UI text: no em dashes (U+2014) in any UI string; `scripts/lint-em-dash.ts` runs in `pnpm lint` and `gate.sh`. Parser source that matches the em dash separator in `workspace_from` and `display_name` must be written as an escape (`'—'`) so the lint does not flag source files (verified: `scripts/lint-em-dash.ts` flags U+2014 inside TS string literals, template text and JSX text, ignoring comments, so an escape in code passes).
- Do not use `yaml`/`gray-matter` for job frontmatter; line-oriented parsers for todos/journal (matches CONTEXT).
- GSD workflow: edits happen through GSD commands; this research is read-only except the RESEARCH.md output.
- Project skills: none present.

## Sources

### Primary (HIGH confidence)
- Rust sources read in full (read-only): `/Users/ike/Eva/apps/evaos/src/{eva,dashboard,workspace,jobs,jobs_view,gate,habits_view,meetings,meetings_view,watch}.rs`, `/Users/ike/Eva/apps/evaos/README.md` (dashboard, new-todo sections), banner assets under `assets/images/banners/`
- Eva tools: `/Users/ike/Eva/.omp/tools/habit-gate.ts`, `job-run.ts`, `jobs-scheduler.ts`, `meeting-memory.ts` (types and write format)
- Live Eva files (read-only): `memory/todos.md`, `memory/todos-done.md`, `memory/journal.md`, `habits.yml`, `~/.config/eva/gate.json`, `workspaces/*`, `jobs/*`, `jobs/.runs/*`
- Repo code: `packages/eva-core`, `packages/contract`, `packages/shell-core`, `apps/desktop/src/{main,preload,renderer}`, `apps/desktop/e2e`, `fixtures/`, `scripts/gate.sh`, `.planning/phases/03-*/03-CONTEXT.md`, `03-UI-SPEC.md`
- npm registry (`npm view`, 2026-10-15): `@mantine/charts` 9.7.2 (peers), `recharts` 3.10.1 (peers incl. `react-is`), `react-is` 19.3.1, `chokidar` 5.0.0 (node >=20.19, dep readdirp ^5)

### Secondary (MEDIUM confidence)
- mantine.dev/charts/bar-chart and mantine.dev/charts/composite-chart (fetched): `referenceAreas`, `children` defs on BarChart, `getBarColor`, composite series types

### Tertiary (LOW confidence)
- chokidar 5 behavior with missing paths and electron-vite 6 bundling (not exercised)
- Hatch pattern through CompositeChart (not confirmed)

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH (all but charts already installed; new versions verified against registry)
- Architecture and exact rules: HIGH (ported from source, cross-checked against live files)
- Pitfalls: HIGH for write safety, CLI traps and tests; MEDIUM for chart and chokidar items

**Research date:** 2026-10-15
**Valid until:** 2026-11-14 (Rust source and Eva tools are the moving parts; re-diff `habit-gate.ts` and `job-run.ts` if they change)
