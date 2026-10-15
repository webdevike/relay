---
phase: 3
slug: dashboard-workspaces-jobs-habits-and-meetings
status: draft
shadcn_initialized: false
preset: none
created: 2026-10-15
---

# Phase 3 - UI Design Contract

> Visual and interaction contract for Dashboard, Workspace page, Jobs, Habits (with the gate overlay), Meetings (sidebar body, Home, Detail) and the New Todo modal.
> Extends `02-UI-SPEC.md` (which extends `01-UI-SPEC.md`). Anything not restated keeps its Phase 2 value: tokens (`--eva-c-*`, `--eva-space-*`), four type sizes (12, 14, 16, 20), two weights (400, 600), overlay wrappers, ScrollArea, cue classes, focus rule, motion-off switch.
> Provenance: [CTX] 03-CONTEXT.md (locked), [README] / [rust:file] Rust EvaOS (read-only visual target), [P2] Phase 2 UI-SPEC, [auto] default chosen unattended.
> Copy rule: no em dashes (U+2014) in any string, sentence case for new copy, no exclamation marks. The Rust app's middle dot separators are replaced by a comma or " / ". Rust Title Case labels named in CONTEXT or README (New Todo, All Workspaces, Recent Workspaces, Open File, Show all) are kept as written there.

---

## Design System

| Property | Value |
|----------|-------|
| Tool | none (Mantine fixed; shadcn not applicable) [P2] |
| Preset | not applicable |
| Component library | Mantine 9.7 primitives only through the Phase 2 rules: `Box`, `Group`, `Stack`, `Button`, `ActionIcon`, `Badge`, `Switch`, `SegmentedControl`, `TextInput`, `NumberInput` (not used; durations are text), `Textarea`, `Select`, `Tooltip`, `Kbd`, `Progress`. Modals, menus, popovers only through `renderer/overlay` (`EvaModal`, `EvaMenu`, `EvaPopover`). Charts through `@mantine/charts` (`AreaChart`, `BarChart`) wrapped in `ui/ActivityChart`. |
| Icon library | `@tabler/icons-react`, stroke 1.5, 16 px chrome and buttons, 14 px inline, 24 px in empty-state tiles [P2] |
| Font | `var(--eva-font-ui)` and `var(--eva-font-code)` [P2] |
| Charts | `@mantine/charts` + `recharts`; colors are CSS variables only (see Color) |

---

## Spacing Scale

Unchanged: xs 4, sm 8, md 16, lg 24, xl 32, 2xl 48, 3xl 64 (`--eva-space-*`). Page content column is centered, `max-width: 1120px` (Dashboard, Jobs, Habits, Workspace), `padding: var(--eva-space-lg)`; section gap 24; card inner padding 16; card-to-card gap 16 (wide) and 8 (compact); label-to-control gap 4; row padding 12 by 16 is NOT used, rows use `padding: 8px 16px`.

Exceptions (layout constants, all multiples of 4): the values below are not spacing tokens; each is a declared layout constant (component or breakpoint geometry) that stays on the 4-point grid, so they are intentional and not ad hoc spacing.

| Constant | Value | Notes |
|----------|-------|-------|
| Hero height | 160 (wide), 192 (compact, because actions wrap) | `data-testid="dash-hero"` |
| Hero text inset | 24 | Left inset; banner image fades to card color at its left edge |
| Compact threshold | main card inner width below 760 | Driven by `ResizeObserver` on the page root, sets `data-compact="true"`; never `window.innerWidth` |
| Wide two-column | left 1fr, right 320 | Recent Workspaces left, Open Todos and Quick Stats right |
| Workspace grid | wide: `repeat(auto-fill, minmax(280px, 1fr))`; compact: `repeat(2, 1fr)` below 760, `1fr` below 520 | Card min-height 144 |
| Chart height | 160 (wide), 128 (compact) | |
| Table row height | 48 (Jobs, Habits), 36 (history, today's breaks) | |
| Filter chip height | 28 | |
| Detail form width | 480 inside `EvaModal` (Job and Habit forms) | Jobs form is a modal, not a page |
| Gate overlay content column | `max-width: 480px` | |
| Meeting row | 48 high, day heading 28 high | Sidebar sub-page |
| Icon tile | 48 by 48 (empty states) | Same as P2 |

Browser slot rule from Phase 1 is unchanged: every overlay in this phase (gate overlay, `EvaModal`, `EvaMenu`) calls `useOccludeBrowser()`.

---

## Typography

Exactly 4 sizes and 2 weights (unchanged). Phase 3 mapping:

| Role | Size | Weight | Line height | Phase 3 usage |
|------|------|--------|-------------|---------------|
| Body | 14px | 400 | 1.5 | Descriptions, row text, todo text, form inputs, summary line, meeting titles, timeline entries |
| Label | 12px | 600 (400 for secondary metadata) | 1.4 | Hero eyebrow "WELCOME BACK" (uppercase, letter-spacing 0.08em, 600), chips, filter chips, column headers (dim, 600), count badges, "Last active" and "Updated" metadata (400), todo ids (`T12`, mono, 400), chart axis and legend text, Kbd, tooltips, status badges |
| Heading | 16px | 600 | 1.2 | Section titles ("Recent Workspaces", "Workspaces", "Open Todos", "Quick Stats", "Timeline", "Today's breaks", "History", "Waiting on you"), workspace card names, modal titles, gate overlay heading |
| Display | 20px | 600 | 1.2 | Page titles ("Dashboard" in hero, "Jobs", "Habits", workspace name, meeting title, "Meetings" home), Quick Stats numbers, gate countdown (tabular-nums) |

Rules: Rust H3 22px maps to Display 20. Stat numbers and the countdown use `font-variant-numeric: tabular-nums`. No new sizes: chart text is 12. Mono (todo ids, job names, cron-like durations `10m`, `2h`) uses `--eva-font-code` at Label 12.

---

## Color

Roles are inherited from Phase 2 (dominant `--eva-c-background`, secondary `--eva-c-sidebar-background` and `--eva-c-secondary-background`, accent `--eva-c-primary-background`). No new tokens and no raw hex in component files.

| Role | Variable | Phase 3 usage |
|------|----------|---------------|
| Dominant 60% | `--eva-c-background` | Page body, hero card base, chart cards |
| Secondary 30% | `--eva-c-secondary-background` | Cards (stat, workspace, job rows container, habit table container), form fields, code and mono chips |
| Hover | `--eva-c-accent-background` | Card hover, row hover, filter chip hover, tooltip-free hover states |
| Border | `--eva-c-border` | Card borders, table dividers, chart gridlines at 50% via `color-mix` |
| Dim text | `--eva-c-muted-foreground` | Secondary metadata (Updated, Last active, column headers, empty-state body); 12px and up, never the only copy of an action |
| Accent 10% | `--eva-c-primary-background` | Reserved list below |
| Success | `--eva-c-success-background` | Job enabled dot, Done check icon, running dot, "Unlocked" state strip |
| Warning | `--eva-c-warning-background` | Job run state "failed or stale" dot, "Time's up" countdown strip, changed-on-disk banner |
| Destructive | `--eva-c-danger-background` | Delete job and Remove habit confirm buttons, inline validation errors (text uses `foreground`, red bar or icon carries the color), Override button outline |

Accent reserved for (exhaustive for Phase 3, in addition to the Phase 2 list; the list is numbered 1 to 4 below):
1. Primary buttons: "New Todo" (hero and modal submit "Add todo"), "New job" / "Create job" / "Save job", "Add habit" / "Save habit", "Start break" and "Mark break done" on the gate overlay, "Accept todo" on a meeting proposal. At most one accent button per visible surface.
2. Current-day bar and the series line stroke in the Recent Workspaces chart (one series per workspace card, line and current-week hatch use accent at 100% and 35% respectively; past bars use `--eva-c-muted-foreground` at 40%).
3. Active Switch track when a job or habit is enabled (P2 rule 5 extended).
4. Gate overlay countdown ring or bar fill.

Note (not accent): the selected filter chip (All / Active / Has Todos / Quiet) and the selected chart range segment (7D / 30D / 90D) use `--eva-c-tab-active-background` and weight 600, matching the Appearance control. Accent is NOT used for these.

Never accent: card titles, icons in rows, borders, hover fills, count badges, links in body text (links use `foreground` with underline on hover).

Hatched current week: SVG `<pattern>` of 45 degree lines, stroke accent at 35%, 4px period, 1px stroke, drawn as a `ReferenceArea` over the current ISO week (Monday to today) behind the daily bars. Not distinguished by color alone: a "This week" label (Label 12 dim) sits at the area's top-left.

Contrast: same rules as Phase 2. Status is always icon or text plus color, never color alone.

Banner overlay: the hero banner image (see Dashboard) is covered by a left-to-right gradient `linear-gradient(to right, var(--eva-c-background) 0%, color-mix(in srgb, var(--eva-c-background) 70%, transparent) 45%, transparent 100%)` so text on the left always sits on 4.5:1 `foreground` over `background`.

Gate overlay surface: `color-mix(in srgb, var(--eva-c-background) 96%, transparent)` (near opaque), no blur.

---

## Layout and Visual Hierarchy

All pages render inside the Phase 2 page `ScrollArea` (`data-testid="page-scroll"`) with the Phase 2 scroll memory keyed `page:<slug>`, `workspace:<id>`, `meeting:<stem>`. Placeholder bodies from Phase 2 for Dashboard, Jobs, Habits and Meetings are replaced. Roots keep `data-testid="page-dashboard" | "page-jobs" | "page-habits" | "page-meetings"` and add `data-testid="page-workspace"` and `data-testid="page-meeting"` for the Detail places.

### Dashboard (`page-dashboard`)

Order top to bottom (wide):

1. **Hero card** (`dash-hero`): full width, height 160, `border-radius: var(--eva-radius-lg)`, 1px `--eva-c-border`, `overflow: hidden`, `position: relative`. Layers: four banner `<img>` (mountains, canyon, redwoods, coast; `-light` or `-dark` by resolved mode, copied from the Rust app's `images/banners/` into `apps/desktop/src/renderer/assets/banners/`; if an asset is missing, fall back to a flat `--eva-c-secondary-background` fill, no error). Banners stay mounted; active one at opacity 1, incoming crossfades 1400ms ease-out-cubic over the outgoing, rotation every 9 s ([rust:dashboard.rs] constants). Rotation is paused while `document.hidden`, when `html[data-eva-motion="off"]` (shows the first banner only, no timer), and under reduced motion. Foreground content inset 24, vertically centered, left aligned, max text width 480:
   - Eyebrow "WELCOME BACK" (Label 12/600, dim, uppercase).
   - Title "Dashboard" (Display 20/600).
   - Summary line (Body 14, `foreground`, `data-testid="dash-summary"`): "{W} workspaces, {T} open todos, {U} updates this week" (singular forms for 1: "1 workspace", "1 open todo", "1 update this week").
   - Action row, gap 8: primary "New Todo" (`IconPlus` 16, `Kbd` "⌘N" inside at 70% opacity, `data-testid="dash-new-todo"`) and secondary "All Workspaces" (`IconFolder` 16, variant default, scrolls the page to the grid and clears the filter to All, `data-testid="dash-all-workspaces"`). Compact: actions wrap to a second row, gap 8.
   - Top right of the hero: "Updated {h:mm AM/PM}" (Label 12 dim, `data-testid="dash-updated"`) and a refresh `ActionIcon` 28 (`IconRefresh` 16, tooltip "Reload from the Eva repo" + `Kbd` "⌘R", `aria-label` the same, `data-testid="dash-refresh"`). While reloading the icon spins 600ms linear per rotation (static under motion-off) and the button is `aria-busy`.
   - Banner dots are not shown (Rust shows none).
2. **Main grid** below the hero, gap 16. Wide: two columns (1fr and 320). Compact: single column, Recent Workspaces first, then Open Todos, then Quick Stats.
   - **Left column**
     - Section header row (`IconActivity` 16 + "Recent Workspaces" Heading 16/600) with at right the range `SegmentedControl` 28 high: "7D", "30D", "90D" (`data-testid="dash-range"`, segments `range-7`, `range-30`, `range-90`, default 7D, in-memory). Label 12.
     - Two **workspace chart cards** (`dash-chart-card`) stacked (wide: stacked, gap 16; compact: stacked, gap 8). Card padding 16, secondary background, 1px border, radius `--eva-radius`. Header: workspace name (Heading 16, truncates, click navigates to the workspace), "Active {Today | Yesterday | 5d ago | Sep 14}" (Label 12 dim, right aligned), open todo chip. Chart 160 high: smoothed `AreaChart` line (`curveType="monotone"`, stroke accent, fill none, strokeWidth 2, dots off) of updates per day layered on `BarChart` daily bars (width 60% of the band, radius 2) with the hatched current week. X axis labels at Label 12 dim (weekday initials for 7D, "Sep 14" at weekly ticks for 30D and 90D); Y axis hidden; gridlines horizontal only. Tooltip (Mantine chart tooltip, themed popover surface) shows date and "N updates". The chart has `role="img"` and `aria-label` "Activity for {name}: {n} updates in {range}" with a visually hidden table of the same numbers for screen readers.
     - Cards use `.eva-cue-first-card`/`first-chart` for the first and `second-card`/`second-chart` for the second [P2 cue table]. Zero-activity workspace: chart shows flat baseline and a centered dim label "No activity in this range".
   - **Section "Workspaces"** (`IconFolder` + "Workspaces"), full width under the two columns (spans both columns on wide), with:
     - Filter row (`dash-filters`, `role="radiogroup"` `aria-label` "Filter workspaces"): chips "All", "Active", "Has Todos", "Quiet" (28 high, Label 12/600, `padding 0 12`, radius 999; unselected transparent with 1px border, hover `--eva-hover`; selected `tab-active` fill, weight 600). Each chip shows a count after the label in Label 12 400 ("Active 4"). Right of the chips: meta text "{n} shown" (Label 12 dim), wraps under chips in compact.
     - Grid of **workspace cards** (`ws-card-<id>`, a `<button>`): padding 16, secondary background, border, radius `--eva-radius`, hover `--eva-hover`, `cursor: pointer`, focus-visible outline [P2]. Content: name (Heading 16/600, one line truncate), tagline (Body 14 dim, 2 lines clamp, "No tagline" when absent in dim), latest journal title or thread (Body 14, 2 lines clamp; empty: "No updates yet" dim), footer row (Label 12): "Active {when}" on the left (dim) and open todo chip on the right (`IconListCheck` 14 + count, `foreground`, hidden at 0). Built-in Eva workspace has an `Eva` badge (Label 12). Click navigates the active tab to `workspace(id)` [CTX]; `⌘`-click opens a new tab [P2 D-10]. Cards get `.eva-cue-grid-cards` with `--i` = index (capped at 11).
     - Empty filter result: row, centered, Body 14 dim "No workspaces match this filter." Footer line when everything shows: "Every matching workspace is shown above." (Label 12 dim).
   - **Right column (wide) or below (compact)**
     - "Open Todos" section (`IconListTodo` + "Open Todos", `.eva-cue-aside-title`): up to 6 rows (`.eva-cue-aside-rows`), each 40 high: id `T12` (mono Label 12 dim), todo text (Body 14, one line truncate, title attribute), workspace chip (Label 12, dim border). Empty: "Nothing open." (Body 14 dim). Footer link "Show all in Tasks" (Label 12/600) opens the Tasks place.
     - "Quick Stats" section (`.eva-cue-stats-title`): 2 by 2 grid of stat cards (`.eva-cue-stat-cards`, padding 16): number (Display 20/600) over label (Label 12 dim): "Workspaces", "Open todos", "Updates, 7 days", "PRs to review". PRs to review shows "0" with dim label until Phase 7 supplies data (never hidden so the grid shape is stable).
3. **Digest** strip (Rust shows an Inbox digest card): omitted in Phase 3 (Inbox is Phase 7 and the card is deferred). No placeholder is shown.

Entrance animation: Phase 2 cue classes attach as named above. The `hero` cue sits on the hero card, `sections` on the section header rows. Played once per launch; navigating back shows the settled page [P2].

Loading state: a single page-level skeleton (hero at height, two chart cards, grid of 6 cards) using `--eva-c-secondary-background` blocks with a 1.2 s opacity pulse (0.6 to 1.0; static under motion-off), `data-testid="dash-loading"`. It is shown only until the first `eva.dashboard` result; reloads keep the old content visible and only spin the refresh icon.

Reload triggers (DASH-06): window activation (`focus`), refresh button, `⌘R` action `reload` (replaces the Phase 2 sidebar-only refresh and still refreshes the sidebar counts). Debounced to one in-flight request; a trigger during flight queues exactly one follow-up.

### Workspace page (`page-workspace`, place `workspace(id)`)

Tab title is the workspace name with `IconFolder`. Column `max-width: 960px`, padding 24, gap 24.

1. Header: back-less (navigation is the tab history). Name (Display 20/600) with an `Eva` badge for the built-in workspace; tagline (Body 14 dim). Chips row (Label 12, 28 high, border, radius 999): status chip "Active" / "Quiet" (dot success or dim), "Last active {when}", "{n} open todos", plus aliases ("Tags: a, b" as one chip each, dim). Action row, gap 8: primary "New Todo" (preselects this workspace in the modal), secondary "Open File" (`IconExternalLink` 16, `shell.openPath` on the workspace markdown; disabled with tooltip "No file for this workspace" when it has none; failure toast "Could not open {path}. Check that the file exists, then try again.").
2. Activity: card with the same chart as the dashboard (daily bars, hatched week, 7D/30D/90D switch, height 160), titled "Activity".
3. Two columns on wide (1fr / 1fr, gap 16), stacked on compact:
   - **Timeline** (`ws-timeline`): merged journal entries and dated `## Threads` bullets, newest first, grouped by day heading (Label 12/600 dim: "Today", "Yesterday", "Sep 14"). Entry row: icon (`IconNotebook` for journal, `IconMessages` for thread, 14), title Body 14 (2 lines clamp), source Label 12 dim. Shows 8 entries; when more exist a "Show all {n}" text button (Label 12/600) toggles to "Show fewer"; state in memory, `aria-expanded`. Empty: "No updates yet" (Body 14 dim).
   - **Open todos** (`ws-todos`): rows as in the dashboard (id, text, no workspace chip since it is implied). Empty: "Nothing open."
4. **Sections** (`ws-sections`): each `##` heading of the workspace file as a Heading 16/600 title with the section body rendered as plain text paragraphs (Body 14, `white-space: pre-wrap`, links not interpreted; list lines keep their markers). Sections are collapsed after the first three: each has a disclosure button (`aria-expanded`) with a chevron. Empty file: "This workspace file has no sections."

Missing workspace (deleted while open): centered state "Workspace not found" (Heading 16) + "It may have been removed from the Eva repo. Go back to the Dashboard." + button "Open Dashboard". The tab keeps its history.

### New Todo modal (`EvaModal`, width 480, `data-testid="new-todo-modal"`)

Triggers: `⌘N` (action `new-todo`, global scope; ignored when another overlay is open or a text input in a modal has focus), hero button, workspace page button, and the top bar. Accepted decision: the hero button and `⌘N` satisfy the "top bar" trigger in DASH-07; no `+` button is added to the Phase 2 tab strip [auto].

Fields, gap 16:
- "Workspace" `Select` (searchable, `data-testid="new-todo-workspace"`), options all workspaces plus "Eva"; preselected from context (workspace page) else last used else Eva.
- "Todo" `Textarea` autosize 2 to 5 rows, `data-testid="new-todo-text"`, placeholder "What needs doing", required, trimmed, single logical line (newlines are collapsed to a space on submit with an inline hint "Line breaks become spaces." shown only when pasted text had them).
- Preview line (Label 12 dim, mono): `T{next} [{workspace}] {text} (added {YYYY-MM-DD})`, updated live; shows exactly the row that will be appended; `data-testid="new-todo-preview"`.
- Footer: secondary "Discard todo", primary "Add todo" (disabled until text is non-empty; `Kbd` "⌘↵" submits from the textarea).
Behavior: submit calls the `EvaFs` append-after-last-open-row writer; the modal shows "Adding" on the button while pending. On success: close, toast "Added T{n} to {workspace}." (success accent bar), reload the dashboard data, focus returns to the trigger. On changed-file refusal or write failure: the modal stays open, inline error (danger icon + text, `role="alert"`): "Could not add the todo. memory/todos.md changed while you were typing or could not be written. Review the preview and try again." and the preview re-reads the next id.

### Jobs page (`page-jobs`)

Header row (`padding-bottom 16`): title "Jobs" (Display 20/600), count badge ("{n} scheduled", Label 12 dim), right: secondary refresh `ActionIcon` and primary "New job" (`IconPlus`, `data-testid="jobs-new"`).

Table card (secondary background, border, radius): header row 36 high with columns (Label 12/600 dim): Name, Schedule, Last run, Next due, Enabled (right). Rows 48 high, divider 1px, hover `--eva-hover`, the row is a button opening the edit modal (`job-row-<name>`). Cells:
- Name: mono Label 12/600 via `--eva-font-code`, truncating, with the first description line under it (Label 12 400 dim) when present.
- Schedule: Body 14 ("Every 2h", "Daily 08:30", "Manual"), as the Rust `Schedule` formatter.
- Last run: relative time (Body 14) and the run state badge (Label 12/600, with icon and text, never color alone: `IconCheck` + "ok" success, `IconAlertTriangle` + "failed" warning, `IconLoader2` + "running" success-pulse, `IconMinus` + "never run" dim).
- Next due: absolute local time ("Today 2:30 PM", "Tomorrow 8:30 AM", "Sep 14, 8:30 AM"), "Not scheduled" dim when disabled or manual, "Overdue" with warning icon when past due and enabled.
- Enabled: Mantine `Switch` (size md per P2 spec) with `aria-label` "Enable {name}" (tooltip "Enabled" / "Disabled" like Rust). Toggling writes only the `enabled` line through `EvaFs` immediately, optimistic with revert and toast on refusal.
Row click ignores clicks on the switch.

Empty: icon tile + "No jobs yet" (Heading 16) + "Create a job to have Eva run steps on a schedule." + primary "New job". Loading: "Loading jobs" dim line. Read error: "Could not read the jobs folder. Check that jobs/ exists in the Eva repo, then press the refresh shortcut." with a retry button.

**Job form** (`EvaModal`, width 560, `data-testid="job-form"`), title "New job" or the job name:
- Name `TextInput` (create only; read-only in edit, mono), validation inline (Label 12, danger icon, `aria-describedby`): "Use lowercase letters, numbers and hyphens, starting with a letter." and "A job named {name} already exists."
- "Schedule" (`SegmentedControl`: "Every" / "Manual") and when Every: "Every" `TextInput` placeholder "Manual (e.g. 10m, 2h, 1d)" hint reused for the field label "Interval"; validation "Use a number followed by m, h or d, like 30m, 2h or 1d."
- "Max run" duration text input, validation same duration copy; "Keep" integer input ("Keep the last {n} runs"), validation "Keep must be a whole number of 1 or more."
- "Enabled" Switch row.
- "Steps" `Textarea` (mono, autosize 6 to 16 rows, `data-testid="job-steps"`), the body of `job.md`.
- Footer left: "Run now" (tooltip "Starts job-run.ts now; the saved job.md is what runs"), "Open last session" (disabled with tooltip "No run yet" when none), "Delete" (danger outline, edit mode only). Footer right: "Discard changes", primary "Create job" (create) or "Save job". "Save job" is disabled until valid and dirty; the form registers with the dirty registry so quit guard lists "Job {name}".
- Delete confirmation: inline confirm panel replaces the footer (not a second modal): "Delete jobs/{name} and everything in it?" with "Keep" (default focus) and danger "Delete job". Body copy under it (Label 12 dim): "This removes the folder from the Eva repo. Running processes are not stopped."
- Changed-on-disk refusal: warning banner at the top of the form (`role="alert"`, warning left bar, `foreground` text): "jobs/{name}/job.md changed on disk since you opened it. Your edits were not saved." with buttons "Reload from disk" and "Keep editing". Save stays disabled until one is chosen.
- Success toasts (from Rust): "Saved jobs/{name}/job.md.", "Started {name}.", "Deleted jobs/{name}.". Run now spawn failure: "Could not start {name}. Check that bun is installed and try again."

### Habits page (`page-habits`)

Header row: "Habits" (Display), refresh `ActionIcon`, primary "Add habit" (`habits-add`). Under it, a **gate status strip** (`habit-gate-strip`, full width, 48 high, padding 16, border, radius): locked: `IconLock` + "Locked: finish a habit to unlock AI tools." (warning left bar 4px); unlocked: `IconLockOpen` + "Unlocked. {Next break at 2:30 PM. | No more breaks today.}" (success left bar). Plus plan source badge at right: "From your calendar" / "Evenly spaced (calendar unavailable)" / "Planned".

Sections (each: section title Heading 16 with icon, then a card):
1. **Habits** (`IconActivity`): table, columns Habit, Minutes, Proof, Streak (header Label 12/600 dim; Minutes and Proof 90 wide, Streak 110). Rows 48, click opens the habit form. Proof cell badge "Photo" or "Honor". Streak cell: "{n} days" or "None yet" dim. Empty: "No habits yet. Add one to have something to pick at a break."
2. **One-time tasks** (`IconListTodo`): rows 48, name, minutes, "Remove task" `ActionIcon` (`IconX`, tooltip "Remove task"). An inline add row at the top: name input (placeholder "Something you keep putting off") + minutes input (placeholder "Minutes (optional)") + "Add task" button; validation "Say what the task is." and "Minutes must be a whole number from 1 to {max}." Empty: "No open tasks."
3. **Today's breaks** (`IconClock`): rows 36 with state icon: `IconCircleCheck` + "Done" (success), `IconClock` + "Upcoming" (dim); time, habit name, "Task" badge when a task, overridden rows show "Overridden: {reason}". Empty: "No breaks planned for today yet."
4. **History** (`IconClock`): rows 36 grouped by day ("Today", "Yesterday", "Sep 14"), entry name, time, "Task" badge, proof photo `ActionIcon` (`IconPhoto`, tooltip "Open the proof photo", opens through `shell.openPath`). Empty: "Nothing finished yet."

Habit form (`EvaModal`, width 480, title "New habit" or the habit name): "Name" (placeholder "Stretch", validation "Give the habit a name."), "Minutes" (validation as above), "Photo proof" Switch row ("Ask for a photo when this break is done"). Footer: "Discard changes", "Remove" (danger outline, edit only), primary "Add habit" or "Save habit". Remove confirmation inline like jobs: "Remove {title}? Its history stays." with "Keep" and danger "Remove habit". Success toast "Saved {name}." Edits run the habit-gate CLI; a CLI failure shows inline `role="alert"`: "Could not save the habit change. The habit gate said: {first stderr line}. Fix it and try again."

States: loading "Loading habits"; read error (card with retry): "Could not read the habit gate" body "Check that .omp/tools/habit-gate.ts runs in the Eva repo, then try again." with button "Try again". Polling every 4 s while the window is visible updates content in place with no spinner and no scroll jump; a stale-error (previous data kept, latest poll failed) shows a small Label 12 dim "Showing the last status. Retrying." under the strip.

### Gate overlay (HABT-03, `data-testid="gate-overlay"`)

Mounted at the shell root (above everything, `z-index: 400`, above overlay wrappers at 300), covering the whole window including sidebar, footer and panel. Present only while the gate status is locked; unlocking removes it (120ms fade; none under motion-off). It calls `useOccludeBrowser()` for its lifetime so the native browser view is hidden. Not dismissible by Esc (it is not on the dismiss stack); the hotkey router suppresses every page and global chord except `⌘Q` while it is up. Focus is trapped (`role="dialog"`, `aria-modal="true"`, `aria-labelledby` the heading); initial focus lands on the primary action.

Surface: near-opaque (see Color), content column `max-width: 480px`, centered vertically and horizontally, gap 16, text left aligned:
- Icon tile 48 with `IconLock`; heading "Time for a break" (Display 20/600); body (Body 14 dim): "Eva's AI tools are locked until you finish a habit."
- **No active timer**: a list of habit choices (`gate-pick-<id>`, radio rows 48 high, name + "{n} min" + proof badge "Photo" or "Honor"; tasks show "Task, {m} min"), selection by click or arrow keys; primary **Start** (`gate-start`, disabled until a row is selected, preselects the first).
- **Timer running**: large countdown (Display 20/600 tabular-nums, `gate-countdown`, format `mm:ss`) with a `Progress` bar (accent fill, 4px tall, track `--eva-c-border`), instruction line: "Go do it. Mark break done unlocks when the timer ends." When the timer ends the line becomes "Time's up. Mark break done to unlock." with a warning left bar. Primary **Mark break done** (`gate-done`, disabled until the timer ends; when the habit needs a photo it is also disabled until a photo is chosen, helper "Photo proof required"). **Choose photo** (`gate-photo`, secondary, `IconPhoto`, opens the native file dialog filtered to images with button label "Use photo"; once chosen the label becomes "Change photo" and the file name shows as a Label 12 chip; the native dialog is stubbed in e2e).
- **Override** (`gate-override`, tertiary text button at the bottom, `IconPlayerSkipForward`): expands an inline form (not a modal): label "Why skip this break?" `Textarea` (required, min 3 characters, placeholder "Why skip this break?"), validation "Give a reason to override.", buttons "Keep gate locked" and danger "Override gate" (disabled until valid). The reason is passed to the CLI and appears in Today's breaks as "Overridden: {reason}".
- Failure from the CLI: `role="alert"` line above the buttons: "Could not update the gate. The habit gate said: {first stderr line}. Try again."

All gate actions go through the habit-gate CLI [CTX]; the overlay re-polls immediately after each action.

### Meetings

**Sidebar sub-page body** (`sidebar-sub-meetings`, replaces the P2 placeholder line; header, back row, title button and search box from P2 unchanged; the title button now opens Meeting Home, `data-testid="meetings-home"` link role):
- `ScrollArea` list, grouped by day. Day heading (28 high, Label 12/600 dim, sticky within the scroll area on `--eva-chrome`): "Today", "Yesterday", "Sep 14", "Undated". Meeting row (`meeting-row-<stem>`, 48 high, `padding 4px 12px`, radius `--eva-radius`): title (Body 14, one line truncate), meta (Label 12 dim: "{h:mm AM} to {h:mm AM}, {n} attendees"), a status dot at the left for proposals waiting (`IconCircleDot` 14, `foreground`, with `aria-label` "Waiting on you"). Hover `--eva-hover`; active (the active tab is `meeting(stem)`) uses nav active fill and 600 weight [P2]. Click replaces the active tab's place with `meeting(stem)`; `⌘`-click opens a new tab.
- Test calls fold: a disclosure row at the end of each day or at list end (`meetings-tests`): "Test calls ({n})" with `IconChevronDown` 14, collapsed by default, `aria-expanded`; rows inside are dim.
- Search: title filter, case-insensitive substring, 0 ms. `⌘F` focuses it while the sub-page is visible [P2]. Empty states: "No meetings yet." (no records), "No meetings match." (search), loading "Loading meetings".

**Meeting Home** (`page-meetings`): column `max-width: 720px`, padding 24, gap 24. Display "Meetings" with summary line (Body 14 dim, `meetings-summary`): "{n} meetings, {k} waiting on you" ("1 meeting", singular for 1). Sections (Heading 16 with a divider-free spacing):
- "Waiting on you": proposal rows (meeting title Label 12 dim, proposal text Body 14, "From {source}" Label 12 dim, **Accept todo** primary-small and **Dismiss proposal** secondary-small; same behavior as Detail). Empty: "Nothing waiting on you."
- "Who's out": rows only when present (attendee, dates).
- "Recent decisions": up to 5 decisions with their meeting titles; "Show all {n}" / "Show fewer" toggle.

**Meeting Detail** (`page-meeting`, place `meeting(stem)`, tab title is the meeting title with `IconUsers`): column `max-width: 720px`, padding 24, gap 24.
- Header: title (Display 20/600), time (Body 14 dim, "Sep 14, 2:30 PM to 3:15 PM"), attendees chips (Label 12, 28 high, up to 6 then "+{n}"), "Open Notes" secondary button (`IconExternalLink`, opens the notes file with `shell.openPath`; failure toast "Could not open {path}. Check that the file exists, then try again.").
- Tabs row (`role="tablist"`, Label 12/600): "Overview" and "Transcript". Overview sections (Heading 16): "Summary" (Body 14 paragraphs; empty "The notes have no summary."), "Decisions", "Open questions", "Attendees", "For you" (proposal rows with Accept and Dismiss), "Remembered" (rows already accepted or dismissed, dim, with a status badge "Accepted" / "Dismissed"). Transcript: filter input "Filter transcript", lines as speaker (Label 12/600) + text (Body 14); empty "The notes have no transcript." and "No lines match." Test-call meetings show the single line "Eva skipped this as a test call." Notes loading "Loading notes"; missing "Notes file not found".
- Accept todo: appends a todo via `EvaFs` with the proposal text and the meeting's workspace (or Eva), toast "Added T{n} to {workspace}."; the row moves to Remembered as "Accepted". Dismiss proposal: writes `status` via `EvaFs` with no confirmation (reversible by editing the file, and non-destructive), toast "Dismissed.". Both buttons are disabled while pending; refusal (changed on disk) shows the inline `role="alert"` under the row: "{file} changed on disk. Reload the meeting and try again." with a "Reload" button.

---

## Interaction States and Keyboard

- Focus-visible: 2px `--eva-c-primary-background` outline, offset 2px, everywhere [P2]. Tab order inside pages follows reading order; filter chips are a radiogroup with arrow-key roving; the range control and workspace cards use plain tab order; rows that open forms are buttons.
- Hover `--eva-hover`; pressed no scale; disabled opacity 0.4 with `aria-disabled` and a tooltip explaining why for non-obvious cases.
- Hotkeys added in this phase (routed through the P2 router): `⌘N` opens New Todo; `⌘R` reloads the active page's data (dashboard, workspace, jobs, habits, meetings) and sidebar counts; `⌘F` focus as in P2; `⌘↵` submits any form modal; `Esc` follows the P2 dismiss stack (modal first). While the gate overlay is up all of these are suppressed except `⌘Q`.
- Toasts through `@mantine/notifications`, bottom-right, 4 s, theme popover surface, 4px left accent bar in the status color; never used as the only error channel for forms.
- Reduced and off motion: banner rotation stops, crossfade 0, spinner static, skeleton pulse static, overlay fade 0.
- Loading and optimistic updates never cause layout shift; list rows keep stable keys (job name, habit id, meeting stem, todo id).

---

## Copywriting Contract

| Element | Copy |
|---------|------|
| Primary CTA (phase) | New Todo (hero, workspace page), Add todo (modal submit), New job, Add habit |
| Hero eyebrow / title | WELCOME BACK / Dashboard |
| Hero summary | {W} workspaces, {T} open todos, {U} updates this week |
| Hero secondary | All Workspaces |
| Refresh | Tooltip and aria-label: Reload from the Eva repo. Metadata: Updated {h:mm AM} |
| Section titles | Recent Workspaces, Workspaces, Open Todos, Quick Stats, Activity, Timeline, Today's breaks, History, One-time tasks, Habits |
| Chart range labels | 7D, 30D, 90D |
| Filter labels | All, Active, Has Todos, Quiet |
| Quick stat labels | Workspaces, Open todos, Updates, 7 days, PRs to review |
| Last active format | Today, Yesterday, {n}d ago, Sep 14; none: No activity |
| Dashboard empty (no workspaces) heading | No workspaces yet |
| Dashboard empty body | Add a workspace file under workspaces/ in the Eva repo and it will appear here. |
| Filter empty | No workspaces match this filter. |
| Filter footer | Every matching workspace is shown above. |
| Card without update | No updates yet |
| Open todos empty | Nothing open. |
| Chart empty | No activity in this range |
| Dashboard error | Could not read the Eva repo. Check that the Eva folder exists and is readable, then press the refresh shortcut. (inline card with "Try again" button) |
| Workspace buttons | New Todo, Open File |
| Workspace timeline | Show all {n} / Show fewer; empty: No updates yet |
| Workspace sections empty | This workspace file has no sections. |
| Workspace missing | Workspace not found / It may have been removed from the Eva repo. Go back to the Dashboard. / Open Dashboard |
| New Todo modal | Title: New Todo; fields: Workspace, Todo (placeholder What needs doing); buttons: Discard todo, Add todo |
| New Todo success | Added T{n} to {workspace}. |
| New Todo error | Could not add the todo. memory/todos.md changed while you were typing or could not be written. Review the preview and try again. |
| Jobs title and CTA | Jobs / New job |
| Jobs empty | No jobs yet / Create a job to have Eva run steps on a schedule. |
| Jobs columns | Name, Schedule, Last run, Next due, Enabled |
| Job form labels | Name, Schedule, Interval, Max run, Keep, Enabled, Steps |
| Job form buttons | Create job, Save job, Discard changes, Run now, Open last session, Delete |
| Job validation | Use lowercase letters, numbers and hyphens, starting with a letter. / A job named {name} already exists. / Use a number followed by m, h or d, like 30m, 2h or 1d. / Keep must be a whole number of 1 or more. |
| Job toasts | Saved jobs/{name}/job.md. / Started {name}. / Deleted jobs/{name}. |
| Job run failure | Could not start {name}. Check that bun is installed and try again. |
| Job changed on disk | jobs/{name}/job.md changed on disk since you opened it. Your edits were not saved. (buttons: Reload from disk, Keep editing) |
| Job delete confirmation | Delete job: Delete jobs/{name} and everything in it? This removes the folder from the Eva repo. Running processes are not stopped. (buttons: Keep, Delete job) |
| Jobs read error | Could not read the jobs folder. Check that jobs/ exists in the Eva repo, then press the refresh shortcut. |
| Habits title and CTA | Habits / Add habit |
| Habits strip | Locked: finish a habit to unlock AI tools. / Unlocked. Next break at {h:mm AM}. / Unlocked. No more breaks today. |
| Plan source | From your calendar / Evenly spaced (calendar unavailable) / Planned |
| Habits columns | Habit, Minutes, Proof, Streak |
| Habits empty states | No habits yet. Add one to have something to pick at a break. / No open tasks. / No breaks planned for today yet. / Nothing finished yet. |
| Habit form | New habit; labels Name, Minutes, Photo proof; placeholders Stretch, Something you keep putting off, Minutes (optional) |
| Habit validation | Give the habit a name. / Say what the task is. / Minutes must be a whole number from 1 to {max}. |
| Habit remove confirmation | Remove habit: Remove {title}? Its history stays. (buttons: Keep, Remove habit) |
| Habits read error | Could not read the habit gate / Check that .omp/tools/habit-gate.ts runs in the Eva repo, then try again. (Try again) |
| Habits stale | Showing the last status. Retrying. |
| Gate heading and body | Time for a break / Eva's AI tools are locked until you finish a habit. |
| Gate actions | Start break, Mark break done, Choose photo, Change photo, Use photo (dialog button), Override |
| Gate timer lines | Go do it. Mark break done unlocks when the timer ends. / Time's up. Mark break done to unlock. / Photo proof required |
| Gate override | Why skip this break? / Give a reason to override. / buttons Keep gate locked, Override gate |
| Gate error | Could not update the gate. The habit gate said: {first stderr line}. Try again. |
| Meetings home | Meetings; summary {n} meetings, {k} waiting on you; sections Waiting on you, Who's out, Recent decisions |
| Meetings empty | No meetings yet. / No meetings match. / Nothing waiting on you. / Loading meetings |
| Meetings test folder | Test calls ({n}) |
| Meeting detail | Open Notes, Overview, Transcript, Summary, Decisions, Open questions, Attendees, For you, Remembered, Accept todo, Dismiss proposal |
| Meeting notes states | Loading notes / Notes file not found / The notes have no summary. / The notes have no transcript. / No lines match. / Eva skipped this as a test call. / Filter transcript (placeholder) |
| Meeting toasts and errors | Added T{n} to {workspace}. / Dismissed. / {file} changed on disk. Reload the meeting and try again. |
| Destructive confirmations | Delete job (inline confirm, see above); Remove habit (inline confirm); Override gate (typed reason required); Dismiss proposal (no confirmation, reversible); all other actions are non-destructive |

Accessibility copy: every icon-only control has `aria-label` equal to its tooltip (refresh, remove task, proof photo, switches `Enable {name}`). Charts have text alternatives as specified. Status is never conveyed by color alone. The gate overlay is `role="dialog"` with `aria-modal`. Page roots have a visible heading as `aria-labelledby`.

---

## Test and Proof Contract

New `data-testid` hooks (in addition to the roots named above):

| Group | IDs |
|-------|-----|
| Dashboard | `dash-hero`, `dash-summary`, `dash-new-todo`, `dash-all-workspaces`, `dash-refresh`, `dash-updated`, `dash-range`, `range-7`, `range-30`, `range-90`, `dash-chart-card`, `dash-filters`, `filter-all`, `filter-active`, `filter-todos`, `filter-quiet`, `ws-card-<id>`, `dash-todos`, `dash-stats`, `dash-loading`; the root carries `data-compact` |
| Workspace | `ws-header`, `ws-new-todo`, `ws-open-file`, `ws-timeline`, `ws-timeline-toggle`, `ws-todos`, `ws-sections` |
| New Todo | `new-todo-modal`, `new-todo-workspace`, `new-todo-text`, `new-todo-preview`, `new-todo-submit` |
| Jobs | `jobs-new`, `job-row-<name>`, `job-enabled-<name>`, `job-form`, `job-steps`, `job-run-now`, `job-open-last`, `job-delete`, `job-delete-confirm`, `job-save` |
| Habits | `habits-add`, `habit-gate-strip`, `habit-row-<id>`, `task-row-<id>`, `habit-form`, `habit-save`, `habit-remove`, `breaks-today`, `habit-history` |
| Gate | `gate-overlay`, `gate-pick-<id>`, `gate-start`, `gate-countdown`, `gate-done`, `gate-photo`, `gate-override`, `gate-override-reason`, `gate-override-submit` |
| Meetings | `meetings-home`, `meeting-row-<stem>`, `meetings-tests`, `meetings-summary`, `meeting-accept-<id>`, `meeting-dismiss-<id>`, `meeting-open-notes`, `meeting-tab-overview`, `meeting-tab-transcript` |

Proof screenshots under `proof/phase-3/` (dark and light for the first three): dashboard wide with hero, charts and grid; dashboard compact (window 800 wide) with stacked layout; each filter selected; workspace page; New Todo modal with preview; Jobs list and Job form with a validation error and the changed-on-disk banner; Habits page; Gate overlay locked (with the browser view asserted `visible=false`); Meetings sidebar list with folded test calls; Meeting Detail. Each is paired with a state assertion (rects, `data-compact`, row counts, file content for the appended todo). Entrance cues and banner rotation are disabled in e2e (`html[data-eva-motion="off"]`), with one motion-on assertion that hero opacity starts below 1 and reaches 1 within 2.0 s.

---

## Registry Safety

| Registry | Blocks Used | Safety Gate |
|----------|-------------|-------------|
| shadcn official | none (shadcn not used) | not applicable |
| Third-party | none | not applicable |

---

## Checker Sign-Off

- [ ] Dimension 1 Copywriting: PASS
- [ ] Dimension 2 Visuals: PASS
- [ ] Dimension 3 Color: PASS
- [ ] Dimension 4 Typography: PASS
- [ ] Dimension 5 Spacing: PASS
- [ ] Dimension 6 Registry Safety: PASS

**Approval:** pending
