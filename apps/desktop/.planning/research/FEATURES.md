# Feature Research

**Domain:** Single-user desktop AI-assistant workbench (port of EvaOS from Rust/gpui to Electron + React + TypeScript, feature parity)
**Researched:** 2026-10-14
**Confidence:** HIGH for the feature inventory (primary source is the README, showcase.md, and the Relay widget schema, all read in full). MEDIUM for the omp RPC frame list (derived from `src/chat.rs` and the bridge, not from `omp://rpc.md`, which is not on disk). MEDIUM for T3 Code / Synara comparison (landing pages only).

Complexity key: S = under a day, M = 1-3 days, L = 3-7 days, XL = a week or more or a research-heavy rewrite.

---

## 1. Gaps and corrections to PROJECT.md found while reading the README

These matter for requirements definition. The README is the source of truth.

| Finding | Detail | Recommendation |
|---------|--------|----------------|
| Main tabs are missing from PROJECT.md | `src/tabs.rs`: main-area tabs (each tab is a place: page, chat, Settings section, meeting) with per-tab back/forward (`⌘[`, `⌘]`), `⌘T` new, `⌘W` close without stopping the chat, `⌘`-click on sidebar and search results opens a new tab, right-click Pin/Unpin/Close/Close others, pinned tabs, dedupe (a place is open in one tab at most). Saved in `layout.json`. | Add as a parity requirement (L). Global search `⌘`-Enter depends on it. |
| `diagram` fenced blocks | README Rich replies: fenced `diagram` blocks render diagram-design HTML via headless Chrome screenshot, click opens the live page in the side browser. PROJECT.md lists only `mermaid` and `ui`. | In Electron render the HTML in a sandboxed iframe or offscreen WebContents; much simpler than the Rust path. Size M. P2. |
| Chat session start path | PROJECT.md spike says `omp --mode rpc-ui --resume <file>`. That is only the "send in a past chat that is not running" path. **New chats** go through herdr (`herdr workspace create`, `herdr agent start --kind omp`) and then talk through the Relay WebSocket, not stdio. | Spike: resume path only (stdio JSON lines). Parity: add herdr+Relay new-chat path or decide to start new chats as direct `omp --mode rpc-ui` children (the Claude Code harness already does "EvaOS children, no herdr"). Needs a decision record. |
| Eregon needs a sidecar service | Eregon chats are thin clients of `.omp/eregon/server.ts` on :8860 (`/turn?chat=<id>`), started from the Eva repo if not running; uses `sox` for mic and `afplay` for speech. | The server is Eva-side TypeScript; reuse as-is. Electron needs only the client, process supervision, and mic capture (MediaRecorder or `sox`). |
| Relay widget types not in EvaOS | Relay's zod schema also has `video`, `model` (3D GLB) and `pr` widgets. `src/rich/widgets.rs` has none of the three. | Do NOT build for parity. Optional P3 since the shared schema makes them cheap to add later. |
| Writes outside the Eva checkout | Relay pairing edits `~/.config/relay/devices.json` (adds `evaos`); session pins are omp's `session-pins.json`; Bitwarden session goes to the login Keychain; habit-gate CLI writes `~/.config/eva/gate.json`. See section 7. | PROJECT.md "Out of Scope" forbids global config writes. Decide explicitly: pairing entry is required for the Relay feed; everything else is via the existing CLI. |
| Calendar, Tasks, Memory, Files, Help Center pages | README: these sidebar pages show a kit `Empty` state. | Parity means an Empty state only. Do not build pages. |

---

## 2. Feature Landscape

### Table Stakes (parity requires; missing means the app is not EvaOS)

#### 2.1 Shell, layout, navigation

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Three-column shell `[sidebar][main card][panel card]` plus footer strip under all three | Core layout | M | Main prefers 480 px; panel shrinks first (to 320), then sidebar (to 200). Sidebar auto-folds below 1016 px with a panel. Min window 760x720. CSS grid or flex with a JS width solver; the fold rule is the hard part. |
| Draggable column edges, double-click reset, widths persisted | Parity | S | `layout.json` in config dir (`$EVAOS_CONFIG_DIR`). Sidebar 200-420 (default 272), panel 320-960. |
| Sidebar nav + Recent journal titles with `⌘F` filter | Parity | M | Counts: Tasks = open todos, Jobs = enabled+scheduled, Inbox = Needs you, Meetings = open proposals. Sliding sub-pages (Chats, Settings, Meetings) with Back and Esc. |
| Account menu + Light / Dark / System | Parity | S | Bottom of sidebar; Settings, Quit. |
| Main tabs with per-tab history | See section 1 | L | Missing from PROJECT.md. |
| Per-page scroll memory and contained scroll areas with fades and thin scrollbars | Parity | M | Each page including each workspace keeps scroll position. Follow-while-pinned logic shared by Chat and Eregon. |
| Hotkeys: `⌘N ⌘R ⌘B ⌘⇧B ⌘J ⌘K ⌘F ⌘T ⌘W ⌘[ ⌘] ⌘S ⌘1-9`, Esc ladders, terminal focus isolation | Parity | M | Electron global menu accelerators will steal terminal keys; route through renderer with a focus-owner check. |
| Entrance animation (about 2 s, once per launch) | Parity (explicit in PROJECT.md) | S | Staggered: sidebar, top bar/hero, filters, line draw, bar grow, card stagger. Workspace pages never animate. |
| Native quit guard for unsaved Files edits | Data safety | S | `before-quit` and window `close` with Save / Discard / Cancel. |
| Design scale (Mantine default theme px, rem-based, theme font size drives spacing) | Whole-app look | S | Mantine gives this natively; map Typography size to root font size. |

#### 2.2 Dashboard, todos, workspaces

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Eva checkout reader | Everything depends on it | M | `workspaces/<id>.md` or `workspaces/<id>/<id>.md`; built-in `[eva]` workspace; journal headings from `memory/journal.md` + `memory/archive/*.md`; dated `## Threads` bullets; open todos from `## Open` in `memory/todos.md`; tag aliases (`goodword`→`goodops`, `eva-app`→`eva-interface`). Root: `EVA_ROOT` else search upward for `workspaces/` + `memory/todos.md`. |
| Dashboard hero, filters, Recent Workspaces charts, grid, Open Todos, Quick Stats | Parity | L | Rotating banners (4 images x light/dark; assets exist in Rust repo `assets/images/banners`, copying is a read, not a modification). Filters All / Active (14 d) / Has Todos / Quiet (30+ d). Smoothed line with hatched current week plus daily bars; 7D/30D/90D. Compact vs wide layouts. Reload on window focus, refresh button, `⌘R`. |
| PRs to review count on dashboard | Parity | S | Derived from inbox (open `ReviewRequested` on non-done rows, deduped across GitHub and Elysia). `n/a` until first GitHub poll. Depends on Inbox. |
| New Todo (`⌘N`, hero, top bar) | Parity | S | Append `- [ ] T<next> [workspace] … (added date)` after the last open row. Next id from BOTH todos files so ids stay contiguous. Hard core: id allocation and insertion point. |
| Workspace page | Parity | M | Header chips, 7D/30D/90D bars, merged Timeline (journal entry title + first 3 bullets, plus dated thread notes; 20 rows, Show all), open todos, file `##` sections, Open File in default app. |

#### 2.3 Chat (the core value)

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Session list (sidebar Chats page) | Parity | L | Read `~/.omp/agent/sessions/<dir whose sessions record repo as cwd>`; title = session title or first prompt; grouped by workspace (`workspace_of` keyword rules); collapsible groups saved to `chat.json`; running first, pinned section, newest-5 then Show N more; status subtitle (open, working, needs approval, has a question, job); search opens all groups including archived. |
| Transcript read from session file (active branch) | Parity | L | JSONL entries linked by `id`/`parentId`; follow the active branch only; tool-call runs fold to "Used 6 tools · bash, read, edit"; newest 160 first with Show earlier that preserves scroll position (prepend anchoring). |
| Live streaming of a resumed session over stdio | Spike core | L | `omp --mode rpc-ui --resume <file>`; frames in section 3. Requirement: no dropped or reordered tokens, prompt echo reconciliation. |
| Virtualized log, pinned follow, Jump to latest / New reply pills | Spike core | L | Variable-height rows with prepend anchoring and streaming growth; tanstack-virtual or similar, with measured heights. Highest-risk UI piece. |
| Live without refocus (watch session folder) | Parity | S | Poll file mtimes every 500 ms (the README says FSEvents misses writes to open files; verify chokidar behaves the same, polling is the safe default). Re-list chats and re-read open past sessions on change, including inactive side tabs. |
| Composer | Parity | L | Two-line box + toolbar. Attach png/jpg/gif/webp up to 20 MB as `images`; `⌘V` image or Finder-copied image files; model button + picker; access chip; context ring; omp account (GPT only). Enter while working steers; round button aborts. |
| Model picker | Parity | M | Icon tabs (Starred + provider logos), search, newest first with dated aliases folded, `⌘1`-`⌘9`, stars in `chat.json`, fast-mode toggle, thinking-level slider with 180 ms snap. Model list from one throwaway `omp --no-session` (`get_available_models`) on first Chat open. |
| Access modes | Parity | S | Full access (`yolo`, default), Ask before commands (`write`), Ask before edits (`always-ask`); only applied at launch via `--approval-mode`, so changing on a live idle chat restarts omp on the same session (old process exits before new starts). |
| Context ring | Parity | M | Tokens over model window; Last known retention, Unavailable (never an invented zero), per-branch history; model change keeps old reading until a compatible assistant reply. Subtle; port the rules, not just the ring. |
| Thinking and tool-details switches | Parity | M | `show_thinking` / `show_tools` in `chat.json`. Tool input 30 lines, result 16 then "… N more lines"; inputs highlighted by kind (bash, diff for edit patches, file language, else JSON); results attach by `toolCallId`. |
| Inline images and image viewer | Parity | M | Prompt images ("You") and tool-result images at aspect, max 360 px tall; viewer pages through all conversation images, zoom 1x-4x, Open in Preview. Blob store `~/.omp/agent/blobs` (`blob:sha256:`) and inline base64. |
| Question card (AskCard) | Parity | M | One question at a time; progress dots `n / N`; option rows with descriptions and Recommended tag; "Or type your own answer"; single-select advances, multi-select waits for Next; Back / Submit / Cancel. Handles `ask`, `select`, `confirm`, `input`, `editor`. |
| Background jobs strip, subagent chips + Clear done | Parity | M | Jobs from `details.async.state: running` tool results until `async-result` or `wait` snapshot; shows type, id, command, elapsed. |
| Pre-send safety prompt | Data safety | S | Continuing a past chat starts a second omp on the same session; ask first when another may be running it (file changed in last 10 min with Relay down; Relay hears it but cannot take replies). **Directly serves the constraint "never corrupt live sessions".** |
| Shared writer registry (main + side panes + Eregon links) | Parity and correctness | M | One writer per normalized session path; closing a tab does not terminate a session another pane uses. |
| Chat row actions: Rename / Pin / Archive / Delete | Parity | M | See write list. Delete refuses running chats. |
| Categories with drag and drop | Parity | M | `chat_categories`, `chat_group_order`, `chat_assignments` in `chat.json`; drag chat onto header, drag header to reorder, Move to menu. |
| Rich replies | Parity | XL | Section 4. |
| Prompt surface tag | Parity (behavioral) | S | Every prompt opens with `<surface><machine> - EvaOS</surface>` (machine from `~/.config/eva/machine` else hostname); slash commands untagged. Easy to miss; Eva's memory protocol may depend on it. |

#### 2.4 Side panel

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Panel chrome | Parity | M | `⌘⇧B`; launcher; header tabs (icon, label, close; inactive collapse to icon below 640 px; active label truncates first at 320 px); `+`, full view, close; hiding keeps tools alive. |
| Terminal | Parity | L | node-pty + xterm.js (+ fit, web-links, unicode11 addons). Per-subtab shells in Eva root; Split right/down opens in the focused shell's cwd; trash closes pane; subtab x closes both; closing tool closes all. Bracketed paste; app shortcuts yield to terminal focus; Esc stays in terminal; scrollback and Jump to latest; themed ANSI mapping from theme tokens; OSC 52 clipboard denied. Close = SIGHUP to owned process group then SIGKILL after grace; never name-match or global kill. |
| Browser | Spike core | L | WebContentsView; back/forward/reload; address bar (URL, search, bare port `3000` to `http://127.0.0.1:3000/`); subtabs; title following; copy link; open in default browser; DevTools + CDP. Must hide or resize when overlays (search, dialogs, gate overlay, Eregon window, history list) cover it; WebContentsView sits above renderer DOM, the same z-order problem as wry, only milder (setBounds/setVisible from layout state). |
| Browser address suggestions | Parity | M | Up to 6 from history; every typed word matches URL or title; prefix matches first, then most visited; Up/Down/Enter/Esc. History source: pages opened in EvaOS plus Arc's `History` DB (read once per launch from a copy via sqlite3). |
| Files explorer and editor | Parity | XL | Lazy folders-first tree; path search (first 500, cancellable); `.git` and `node_modules` hidden; `secrets` and every symlink listed locked; no-follow descriptor-relative IO; editor with Saved/Edited, `⌘S`; conflict detection (refuse save if changed since load, Reload offers disk version); Source/Preview for Markdown; binary, non-UTF-8, over 2 MB get explicit no-preview message; Open with default/VS Code/Zed/Xcode; copy abs/rel path; reveal in Finder; guard on switch/close/quit. Use CodeMirror 6 or Monaco. The secure IO layer is the hard core (Node lacks `openat`; use `fs.realpath` + `lstat` containment checks, accept TOCTOU risk or a small native helper). |
| Side chats | Parity | L | Independent panes, each with own selection, draft, attachments, model choice, question-card progress, follow-scroll; tab states: spinner, warning dot (question/approval), accent dot (unread); new tab starts own session on first send. Reuses Chat; cost is mostly pane-state isolation. |
| iOS Simulator tool | Parity (listed in PROJECT.md) | L | `xcode-select`/`simctl list --json` probes off UI thread; setup checklist with copyable commands; `xcodebuild -downloadPlatform iOS` only after confirm; boot/shutdown; Open Simulator / Open DeviceHub (Xcode 27 `Contents/Applications/DeviceHub.app`); save PNG via save dialog; appearance toggle; screenshots refreshed about every 3 s (`simctl io screenshot`), no video; cancellable, bounded child commands. Never create/erase/delete devices. Low value, high macOS-version risk: schedule last. |

#### 2.5 Inbox (largest self-contained subsystem)

Phases per `work/notif-proposal/`. Suggested requirement split below.

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Phase 1: store and model | Foundation | XL | `Item`, `Subject` (Session, Job, WorkItem, Gate, Meeting, Pr, Linear, Slack, Op), `Event` (`Reason`, verbatim text, allowed `Response`s, `Target`), `Lane` (Needs you / Updates) derived from events, `Level` (Interrupt, Badge, Digest) from lead event reason; only approvals, questions, break due may interrupt/toast. APIs `upsert`, `resolve(subject)`, `changes`. States: open, seen, snoozed, done (Resolver: world/Idle/Eva/Phone). "Seen is not done." Return time ordering. Auto-settle after N days (default 3). Pure state machine: build it in TS with exhaustive unit tests ported from the Rust tests. |
| Persistence | Parity | M | `inbox.jsonl` append-only `{"put":Item}` / `{"drop":id}`, last put wins, compact when 2x rows, Done kept 30 days, failed save logged not fatal. Must stay format-compatible if Rust app runs side by side (decide: shared file or own config dir; shared is risky). |
| Bell and popover | Parity | M | Badge = Needs you count; rows per omp session; approval shows command verbatim and flags destructive; single-choice question shows up to 4 option buttons; keys `J/K`, Enter, `E`, `A`, `D`, `H`, `1-4`, Esc; N snoozed / N done views; recede to 70% opacity. |
| Producers from chats | Parity | L | Per running chat: working, blocked (approval/question), idle, ended. Raises needs approval, asked you, finished, failed (died while working/blocked or vanished from Relay while Relay stayed up), stale (30 min no news working, 2 h blocked). Toasts only for the two blocked kinds and only when chat is off screen; nothing toasts for chats already running at launch or on Relay reconnect. |
| Repo sources (phase 2) | Parity | L | Watch (poll 2 s) `work/items`, `jobs`, `work/meetings`, `work/elysia`. Jobs: failed/timeout/killed latest run in `jobs/.runs/<name>/` (Run now, Disable, opens `job.log`). Work items: frontmatter `move: isaac`. Habit gate: break due (status every 10 s). Meetings: pending proposals (Accept/Decline) then digest-ready. Operations: failed op with in-process Retry. Elysia: `work/elysia/slack.md` + `reviews.md` parsing (Flagged, Fyi, ReviewRequested; subject = sha256(link)[..8]; half-written file must not settle rows). Each source is idempotent `reconcile`. |
| GitHub and Linear pollers (phase 3) | Parity | L | Every 2 min, doubling backoff to 16 on failure, failed poll never settles rows. GitHub: GraphQL per `gh` account with its own `gh auth token`; review requested, changes requested, CI failed/passed, reviewed, mentioned, merged/closed. Linear: unread notifications + assigned issues of last 3 days, `LINEAR_API_KEY` env or `secrets/linear.env`. Freshness chips (amber if failing or over 10 min). |
| One row per work item (phase 3) | Parity | L | Fold subjects by (1) refs sources name, (2) ledger frontmatter `pr:`, `linear:`, `branch:`, `worktree:`, (3) what a session tells (cwd inside a worktree, branch in a command, `ENG-` key). Jobs, meetings, gate, ops never fold. Row headline is the work item's; leads with oldest open response; N pending, N sources; Linked section. Most intricate logic in the app; port with the Rust test fixtures. |
| Inbox page | Parity | L | Tabs Needs you / Updates / Snoozed / Done with counts; source chips (Agents, Work, People, Jobs, Habits, System); saved views in `inbox-views.json`; `/` filter; Waking soon section; "N chats finished" burst collapse; hover actions Done/Snooze/To-do/Open; detail pane over 860 px with Approve/Deny, numbered options, reply in own words, source buttons, Linked, activity; keys J K Tab Enter E Shift-E H T X(mark) 1-4 A D R F W U Z(undo 6 s) / ? Esc. `M`, `G`, approve-for-session are explicitly NOT built in the Rust app. |
| Snooze picker | Parity | M | Conditions (`SessionSettles`, `JobRuns`, `MoveChanges`, `PrMerged`, `CiGreen`, `LinearState`), time presets (1 h, next digest, evening digest, tomorrow morning digest, Monday), free-text time parser ("4pm", "fri", "tomorrow 9am", "in 2h", "next week"), Woke chip, nudge after two snoozes. Blocked rows cannot be snoozed. |
| Inbox To-do action | Parity | S | Appends `- [ ] T<next> [workspace] title: what it said (from inbox)` under `ecardsystems` (work rows) or `eva` (others), marks done; undo leaves the line. |
| Digests | Parity | L | Pure clock state machine ticking every 10 s: morning 08:30, after each break, evening 17:30 (max 3/day), fixed 08:30/13:00/17:30 fallback, override `digest_times`; "while you were away" after over 2 h; nothing during gate lock or quiet hours; `digest.json`. Page, popover link, Dashboard card. Eva summary: one `omp -p --no-session --no-tools --no-extensions --model haiku` call (15 s timeout, `EVAOS_DIGEST_MODEL`), validated (every named row exists, every number appears in rows; approval/question text never leaves the app). Catch me up + Clear N updates (Resolver::Eva, undoable). |
| Notification preferences (phase 4) | Parity | M | Mode Calm / Normal (default) / On call with live preview lines; Phone (on/off, delay 45 s, per-session gap 10 min, destructive-needs-Face-ID); Quiet hours 21:30-07:30 (30 min steps); auto-settle 1-90 days or off; digest times; per-source ceilings (Default/Badge/Digest/Off; GitHub cannot reach Interrupt); fixed AI-summary rules. `notifications.json`; applies instantly. |
| Phone escalation | Parity | L | Engine gate: prefs allow, Mac idle 2+ min (`ioreg -c IOHIDSystem` HID idle) or screen locked (`ioreg -n Root -d1`), row waited 45 s, not quiet hours/habit break, per-session min gap 10 min, second blocked agent within 2 min folded as "+1 more". Sends Relay `inbox.item` (`approval:<toolCallId>`, `ask:<askId>`, or `alert`), `inbox.resolve` both ways (`by: phone` settles as "answered on iPhone"), digests as passive pushes. Needs Relay frames `agent.approval`, `agent.ask`. Also desktop notifications for toasts (Electron `Notification`). |
| Relay feed client | Parity; also gates Inbox producers | L | WebSocket protocol identical to the phone: handshake (`platform: "ios"`), session list by `rev`, streaming replies, `agent.reply`, `agent.abort`, `agent.configure` (rename title, model, thinking), `agent.ask.answer/cancel`, `agent.approve/deny` (`confirmed: "desktop"`), reconnect every 3 s. Port from `work/relay/packages/protocol/src/index.ts` (879 lines, TS and zod; high reuse). |

#### 2.6 Global search (`⌘K`)

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Overlay, grouped results, keyboard nav, routing | Parity | M | 13 groups (Pages, Settings, Workspaces, Dashboards, Chats, Meetings, Work items, Todos, Notes, Files, GitHub PRs, GitHub issues, Linear issues); six rows per group, 40 total; Enter opens in active tab, `⌘`-Enter or click in new tab; empty query lists pages + six newest chats; browser view hides while open. |
| Index (off UI thread) | Parity | L | Worker thread or utility process. Sources and caps: repo files via `rg --files` (cap 40,000, gitignore respected, hidden skipped, `secrets/` excluded), Notes (markdown under `memory/`, `references/`, `workflows/`), `work/items/*.md` (gitignored; listed separately), meetings + transcriber notes, chat prompts and replies; text kept up to 256 KB each by mtime, incremental rebuild; built at launch and on each open. |
| Instant tier | Parity | M | 60 ms debounce, cancellable, subsequence scorer (substring > start > word start > ordered letters; titles then subtitles at half weight; single letter matches word start only); content hits for 3+ chars with matching line shown. |
| Semantic tier | Parity per README, but see anti-features for the tuning question | L | 400 ms idle. Jev intent (`api.typesafe.ai/v1/systemone`, model `jev-latest`, key `TYPESAFE_API_KEY` or `secrets/jev.env`, 3 s limit) asks 5 Choices; chip under input (`GitHub PRs · mine · open`); live `gh search` + Linear GraphQL (8 s / 6 s limits, 60 s cache); OpenAI `text-embedding-3-small` 256-d (`OPENAI_API_KEY` or `secrets/openai.env`) cached in `search-embeddings.bin`; merge and Jev rerank top 30 ("Ranked by Jev"). Every failure falls back silently to what is showing. Treat as its own late phase; the instant tier alone is the table-stakes slice. |

#### 2.7 Jobs, Habits, Meetings

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Jobs list + editor | Parity | M | `jobs/<name>/job.md` frontmatter `every`, `enabled`, `max_run`, `keep`, numbered steps. Schedule (`every 10m` or `manual`), enabled switch (writes `enabled:` immediately), last run from `jobs/.runs/<name>/last-run` + newest `status.json`, running = `jobs/.runs/<name>.lock` exists, next due = last-run + every. Validation: name `^[a-z0-9][a-z0-9-]*$`; durations `10m`, `90`, `2h`, `30s`. Edits change only edited lines, preserve other keys' text and order; temp-sibling then rename; refuse if changed on disk since opened; create refuses existing folder. |
| Run now / Open last session / Delete | Parity | M | Detached `bun .omp/tools/job-run.ts <name>` (no stdio, own process group, survives quit; bun from PATH, `/opt/homebrew/bin`, `~/.bun/bin`; child PATH adds `/opt/homebrew/bin`, `~/.local/bin`). Delete confirms then removes `jobs/<name>` recursively (run history stays). Never run Run now in tests. |
| Habits page | Parity | M | Shell out to `bun .omp/tools/habit-gate.ts <cmd> --json` (`status`, `habit add|edit|rm`, `task add|rm`, `start <id>`, `done <id> [--photo path]`, `override <reason>`); poll `status` every 4 s plus on open, focus, `⌘R`; every write prints new status. Habits (minutes 1-600, photo or honor proof, streak), tasks, today's breaks (calendar or evenly spaced), history (streaks through today/yesterday; latest 30 entries with proof photo). |
| Gate overlay | Parity | M | Near-opaque full-window layer that holds keyboard while status locked; hides browser WebContentsView; pick habit/task, Start, countdown to `endsAt`, Done enabled at zero (photo habits also need Choose photo), Override with typed reason. Closes when printed status is unlocked. |
| Meetings sidebar page, Home, Detail | Parity | L | Records `work/meetings/<stem>.json`; list grouped by day, search, test calls (`skipped`) folded; Home: subtext, Waiting on you, Who's out (`availability` memories until `(YYYY-MM-DD)` passes), Recent decisions (last 7 days, 4 each then Show all); Detail: Open Notes, Overview/Transcript (`## Full Transcript` with mono timestamps, speaker once per run, filter), For you, Remembered, Decisions, Open questions, Attendees. Protocol markdown parsed off-thread. |
| Meeting Accept / Dismiss | Parity | S | Accept: `append_todo` (tag = proposal workspace default `eva`; tickets prefixed `Draft ticket: `; suffix ` (from meeting <title>, <date>)`) then `status: accepted`; Dismiss sets `dismissed`. Atomic rewrite keeping all other fields. EvaOS is the only writer of `status`. |

#### 2.8 Settings and theme

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Settings sections | Parity | S | Theme, Chat (thinking, tool details, harness, omp account default), Notifications. PROJECT.md lists only Chat and Theme; Notifications is a third section. |
| Theme editor | Parity (PROJECT.md calls it "full") | XL | Section 5. |
| Claude Code harness option | Parity | M | Setting `harness` in `chat.json` (default omp). Chats from `~/.claude/projects/<root>/*.jsonl`; live chats run `bun .claude/bridge/session.ts --rpc` (speaks the same rpc-ui dialect); new chats are EvaOS children, no herdr. If chat I/O is behind one transport interface, this is mostly a different transcript reader plus command line. |

#### 2.9 Eregon

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Footer chat tabs, floating window, history | Parity | L | One tab per open chat (green dot working, accent dot unread); Eregon button = new chat; chat history menu; shown chat floats above footer right end, clamped to window, minimize/expand/close; own follow state; three suggested prompts when empty; Esc ladder: history, then minimize, then leave Chats page; history dismisses on outside click. Narrows the Browser WebContentsView. |
| Eregon turn client | Parity | M | HTTP to `.omp/eregon/server.ts` on :8860 `/turn?chat=<id>`, auto-start from Eva repo; render cards (brief with links, session links `eva-session:<path>?title=` that open in Side chats, `open` event opens Browser); speak sentences with `afplay`; mic via `sox`. Session links must target Side chats only. |

---

### Differentiators (where the port should beat the Rust app, aligned with Core Value)

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| Real Chromium browser panel with DevTools and CDP | Core value; the reason for the port | L | Proof by Playwright screenshots; DevTools docked or detached; CDP for agent page control; no Safari UA spoof or popup/OAuth hacks needed (see anti-features). |
| Smooth long-scrollback streaming | Core value | L | Virtualization with prepend anchoring and a token-batching reducer (coalesce `message_update` per animation frame, never drop). Add a benchmark fixture (the README's `--transcript` with more than 160 messages plus `--append-reply`) so "beats current" is measurable. |
| Playwright-driven proof harness | Replaces the Rust `snapshot` example and `evaos-ctl` | M | Port the idea, not the ids: stable `data-testid`s per README snapshot ids; fixtures for transcripts, widgets, scratch `EVA_ROOT`. Constraint says every phase ends with screenshots. |
| Widget renderer reusing Relay's zod schema | Same schema as the phone, one parser | M | `parseWidget` already exists in `work/relay/packages/protocol/src/widget.ts`; copy (do not import across the read-only boundary) and port parity tests (Relay has `fixtures/`). |
| Browser-native pieces for free | Mermaid, diagram HTML, syntax highlighting, audio, charts via ordinary web libs | S each | Mermaid.js (themed) instead of `mermaid-rs-renderer` plus SVG cache; `<audio>` instead of `afplay` for widgets. |
| Web-standard theme editor preview | Live preview is the real app | M | Mantine CSS variables or a token layer. |

### Anti-Features (deliberately do NOT rebuild)

| Anti-Feature | Why It Exists in Rust | Why Not Here | Alternative |
|--------------|----------------------|--------------|-------------|
| `chat-order` and `chat-sections` experiments (Agents section, return-time order, recede and auto-archive for chats, Snooze for chats, Pinned/Inbox/Working/Snoozed/Archived sections, `chat-order.json`) | Experimental build only | Not on the shipping README surface; PROJECT.md out of scope | Ship the main-build list (workspace groups, categories, pinned, archived). Keep chat list state behind a service so the experiment can be added later. |
| The experimental app itself: second bundle, banner strip, separate config folder seeding, `evaos-experimental` Relay device, `escalate::start` skip | Side-by-side testing of experiments | No experiments to gate | A single `EVAOS_CONFIG_DIR` override is enough (already required). |
| WKWebView focus hacks: `focus_parent`, "hide webview when overlays show" as a correctness workaround, AppKit first-responder handoff, narrowing for Eregon via native-layer overlap | gpui cannot z-order above a native view | WebContentsView is composited by Electron; still need `setVisible`/`setBounds` for DOM overlays, but not focus handoff | Single `BrowserViewHost` that listens to a layout store and overlay count. |
| Safari user-agent synthesis from installed Safari, sized `window.open` popup bridging with shared `window.opener`, new-window-to-subtab for OAuth | WebKit sign-in compatibility | Chromium signs in to Google natively | Use `setWindowOpenHandler`: popups with `opener` allowed via a real child BrowserWindow; everything else becomes a subtab. |
| Arc cookie import into WebKit's default store (`arc-cookies.ts`, `evaos-arc-sites.txt`, cookie button) | Needed to sign into sites in WKWebView | Writes decrypted cookies unencrypted; Electron session with its own partition persists logins; README itself warns | Persistent `partition: persist:evaos-browser`. Revisit only if Isaac asks. (LOW confidence it is unwanted: the cookie import also avoids re-login. Flag for roadmap decision.) |
| Bitwarden `bw` autofill with Keychain-stored session key | Convenience in WKWebView | Large, security-sensitive, macOS Keychain writes; Bitwarden has a Chromium extension | Defer; if wanted later, load the Bitwarden extension in the session. |
| Arc history sqlite read for address suggestions | Seed suggestions | Reads another app's private DB | Own history only at parity; Arc seed is P3. |
| gpui-specific scaffolding: `native_quit.rs`, app icon via NSApplication, `scale.rs` rem-trick, kit icon `ExtraIcons`, `window.open_dialog` notes, `.test_support()`, `SDKROOT` pin, `gen_theme_fields.py` for the 139 gpui-kit keys | Framework gaps | None apply | Mantine theme + `electron-builder` icon; Electron `before-quit`. |
| Native cell-canvas terminal (Alacritty VT parser, custom selection, wide-cell handling) | No web terminal in gpui | xterm.js already does VT, selection, scrollback, wide/combining, 256/truecolor | node-pty + xterm.js; reimplement only the focus-isolation and HUP then KILL semantics. |
| Rust-side snapshot example CLI (`--click`, `--press`, `--wait`, fake clock) and `control.sock` / `scripts/evaos-ctl` | Headless Metal capture and remote control | Playwright for Electron covers it | Keep a small main-process control channel only if proof needs it (S). `evaos-ctl` is used by Eva tooling; check `.omp` for callers before deleting. |
| `mermaid-rs-renderer` cache in `$TMPDIR/evaos-media`, `curl` downloads for widget media, `afplay` for widget audio | Native rendering limits | Browser fetches and plays media | `<img>`/`<audio>`; the main process only proxies `/drops/...` (Relay) and local paths via a custom protocol. |
| Relay-only widgets `video`, `model` (3D), `pr` | Phone app | Absent from EvaOS today | Out of parity; P3 follow-up since the schema exists. |
| Voice input in chat | n/a | omp RPC has none; PROJECT.md out of scope | Eregon mic only. |
| "Not built" items the README names: Inbox `M`, `G`, approve-for-session; Calendar/Tasks/Memory/Files/Help Center pages; Outlook calendar in digest; lab temporary-chat / machine picker in side chats | Not implemented | Parity means absent | Empty states. |
| Writing to the Eva checkout outside section 7's list | n/a | Data-safety constraint | Enforce in a single `EvaFs` write gateway with an allowlist (see ARCHITECTURE). |
| em dashes in UI strings | n/a | Style rule | Lint rule over string literals. |

---

## 3. omp RPC protocol surface (what the chat UI must handle)

Transport: `omp --mode rpc-ui [--resume <session file>] [--approval-mode ...] [--model ...] [--thinking ...] [--profile personal|work]`, JSON lines on stdin and stdout, run with cwd = Eva root. The Claude Code harness (`bun .claude/bridge/session.ts --rpc`) speaks the same dialect. Derived from `src/chat.rs` (`apply`, `response`, `ui_request`, tests) and the bridge. **Verify against `omp://rpc.md` in the first spike plan** (not available on disk to this researcher).

**Commands the UI sends** (all JSON objects with `type`; request/response pairing by optional `id`):

| Command | Payload | Notes |
|---------|---------|-------|
| `get_state` | `id: "state"` | Reply data: `sessionFile`, `model{provider,id,contextWindow}`, `thinkingLevel`, `fastModeEnabled`, `fastModeActive`, `contextUsage{tokens,contextWindow}`. Re-sent after set_* and after `model_changed` / `thinking_level_changed`. |
| `get_available_models` | `id: "models"` | `data.models[]`. |
| `set_ask_dialog` | `enabled: true` | Sent at start so every `ask` question arrives at once. |
| `prompt` | `message` (tagged), `streamingBehavior: "steer"` while working, `images: [{type:"image", data, mimeType}]` | |
| `abort` | none | Round stop button. |
| `set_model` | `provider`, `modelId` | |
| `set_thinking_level` | `level` (includes `xhigh`) | Model may clamp; re-read state. |
| `set_fast_mode` | `enabled` | |
| `set_session_name` | `name` | Rename running chat. |
| `extension_ui_response` | `id` plus one of `value`, `confirmed`, `answers[]`, `cancelled: true` | Answers dialogs. |

**Events the UI must reduce** (stdout):

| Frame | Fields used | UI effect |
|-------|-------------|-----------|
| `response` | `command`, `success`, `error`, `data`, `id` | Failure shows "Error: …" notice; failed `prompt` drops the optimistic message. |
| `agent_start` | | working = true; context stale. |
| `agent_end` | `yielded` (ignore when `false`) | working = false. |
| `session_settled` | | working = false. |
| `prompt_result` | `status` (`error`, `aborted`), `error.message` | Notice "Error: …" or "Stopped."; drop optimistic prompt on error. |
| `message_start` / `message_update` | `messageId`, `message{role,content[]}` | Assistant only; upsert streaming message text (replace, not append). |
| `message_end` | `messageId`, `message` (assistant: `provider`, `model`, usage for context tokens; user: echo; toolResult: attach by `toolCallId`) | Finalize; replace the optimistic user prompt with omp's echo (match by trimmed text, else first unconfirmed). |
| `tool_execution_start` / `_end` | `toolName`, `args` | Working row "name · summary"; clear on end. |
| `model_changed`, `thinking_level_changed` | | Trigger `get_state`. |
| `extension_ui_request` | `id`, `method` in `select`, `confirm`, `input`, `editor`, `ask`, `cancel` (`targetId`); `title`, `options`, `optionDetails[].description`, questions array for `ask` (multi-select, recommended, free text) | Question card; other `method`s (presentation updates) ignored. |
| `_stderr`, `_eof` | synthetic from the host | Keep last N stderr lines; on EOF mark ended "omp exited: <last stderr line>", clear dialog, drop unconfirmed prompts. |

**Session JSONL entry types** (history reader): `session` (id, cwd), `title`, `message` (`id`, `parentId`, `message.role` user/assistant/toolResult, `attribution` user/agent, content parts `text`, `thinking`, `toolCall{id,name,arguments}`, `image`; tool result `details.async{state,jobId,type}`), `model_change` (`model: "provider/id"`). Active branch = follow `parentId` from the last entry. Subagent chip data source is not visible in the files read; confirm during chat plan research.

**Relay frames the UI also consumes** (`work/relay/packages/protocol/src/index.ts`): agent session list by `rev`, streaming reply, `agent.approval`, `agent.approval.resolved`, `agent.ask`, `agent.ask.resolved`, plus outbound `agent.reply`, `agent.abort`, `agent.configure`, `agent.ask.answer|cancel`, `agent.approve|deny`, `inbox.item`, `inbox.resolve`. Handshake only accepts `platform: "ios"`.

---

## 4. Rich replies: complete `ui` widget inventory (30 types)

Reply pipeline: segment the assistant text into markdown, fenced `mermaid`, fenced `diagram`, fenced `ui`, and other fenced code (framed with language label + Copy). Malformed `ui` JSON falls back to an indented JSON code block. Eva's `Label:` lines (Detailed Read, Concise Read, Glossary, TLDR) become headings; Glossary becomes aligned rows. Markdown keeps single line breaks and selection. Schema (zod, from `work/relay/packages/protocol/src/widget.ts`): unknown tone degrades to neutral, unknown style to body, containers max 24 children and depth 4, tabs 2-6, table max 8 columns x 100 rows and every row must have one cell per column, button needs exactly one of `url`/`reply`, progress value clamps to 0..max (max defaults to 100), `MediaSrc` = `/drops/<id>/<token>` or http(s) (EvaOS additionally accepts local paths: showcase uses `/Users/iweber/...`).

Showcase.md contains 13 fenced `ui` blocks plus a mermaid flowchart and code fences (rust, ts). All 30 types appear in showcase.md.

| # | Widget | Key fields | Expected rendering | Cx |
|---|--------|-----------|--------------------|----|
| 1 | `stack` | `direction` (vertical default / horizontal = equal-width row), `gap` xs/sm/md/lg, `children` | Layout container | S |
| 2 | `card` | `title?`, `children` | Hairline-bordered group with heading | S |
| 3 | `grid` | `columns` 2/3/4, `gap?`, `children` | Equal cells wrapping into rows | S |
| 4 | `tabs` | `tabs[{label, children}]`; state keyed by node id | Segmented tab bar; one pane visible | S |
| 5 | `collapse` | `title`, `open`, `children` | Chevron disclosure row; local state | S |
| 6 | `text` | `text`, `style` heading/body/caption/muted | Type-scale line | S |
| 7 | `badge` | `label`, `tone` accent/ok/warn/danger/muted | Small tone pill | S |
| 8 | `divider` | none | Hairline | S |
| 9 | `stat` | `label`, `value`, `delta{value,direction up/down/flat}` | Big number with arrow and tone-coloured delta | S |
| 10 | `chart` | `kind` bar/line, `stacked?`, `title`, `labels[]`, `series[{name,color?,points[]}]` | Line chart or bar (grouped or stacked) with legend; default series colours from theme chart tokens when `color` is missing | M |
| 11 | `rows` | `rows[{label,value,tone}]` | Label left, value right (tone coloured) on hairlines | S |
| 12 | `table` | `title`, `columns` (string or `{label, align}`), `rows` of string, number, or `{text,tone,bold,url,icon github/linear}` | Scrolls sideways when wide; hairline rows; linked cells; brand icon (empty text OK with icon) | M |
| 13 | `progress` | `value`, `max`, `label`, `caption`, `tone` | Labelled bar plus caption | S |
| 14 | `list` | `style` bullet/number/check, `items` (string or `{text, caption, checked}`) | Static checklist (not interactive) | S |
| 15 | `callout` | `tone`, `title?`, `text` | Tinted note with tone icon | S |
| 16 | `code` | `title?`, `language?`, `code` (max 50,000) | Highlighted block with header bar and Copy | S |
| 17 | `quote` | `text`, `cite?` | Block quote with attribution | S |
| 18 | `avatar` | `name`, `subtitle?`, `src?` | Photo or initials | S |
| 19 | `timeline` | `items[{title, time?, text?, tone?}]` | Vertical dots-and-line rows | S |
| 20 | `button` | `label`, `url` xor `reply`, `variant` primary/secondary/subtle, `tone` (danger) | `reply` sends text as the chat's next turn; `url` opens in the side Browser (README: GitHub and Linear results open in panel browser; confirm default for widget `url`); disabled outside live chats | S |
| 21 | `link` | `label`, `url` | Inline link, opens in Browser | S |
| 22 | `input` | `placeholder`, `button` (default "Send"), `reply` containing `{value}`, `multiline?` | Field plus submit; sends `reply` with `{value}` substituted; disabled outside live chats; state keyed by node id | S |
| 23 | `image` | `src`, `alt`, `caption`, `url`, `aspect` 0.25..4 | Framed image, click opens the image viewer | S |
| 24 | `gallery` | `title`, `images[{src,title,caption,url}]` max 50 | One image at a time in a 4:3 frame with title, caption, source link, dots, pager; click opens viewer on the same page; pager wraps below title in narrow panes | M |
| 25 | `compare` | `title`, `before{src,label}`, `after{src,label}` | Before/after image slider (draggable divider) | M |
| 26 | `tickets` | `title`, `tickets[{id,title,summary,state,stateType,priority,assignee,updated,url}]` | Pager/carousel of ticket cards; state pill tone from `stateType`; header wraps pager in narrow panes | M |
| 27 | `emails` | `title`, `emails[{from,subject,snippet,date,unread,url}]` max 50 | Flat rows on hairlines with unread dot; row opens url | S |
| 28 | `diff` | `file?`, `patch` (unified, one file, max 50,000) | Line numbers, tinted add/del rows | M |
| 29 | `recipe` | `title`, `meta[]` (max 4), `ingredients[{item,section?}]`, `directions[]`, `source` | Checkable ingredients grouped by section, Directions on a separate tab, source link | M |
| 30 | `audio` | `title`, `src` | Play/pause, seekable bar, elapsed/total | S |

Count: **30 distinct widget names** (matches the 30 names in PROJECT.md; `chart` has 3 variants shown in showcase: line, grouped bar, stacked bar).

Shared widget behaviors: `Respond` handle from the chat view (live chats only; dashboards and past chats pass none so reply controls render disabled); local state for tabs, collapse, input, recipe checks keyed by node id; media loader supports local paths, http(s), and Relay drops (`/drops/...` fetched from the local Relay host); shared image viewer (prev/next, arrow keys, zoom 1x-4x with pan, Escape, Open in Preview).

Rich-reply extras: `mermaid` (themed from app theme, capped 420 px tall), `diagram` (HTML path or inline HTML), code fences framed with language label and Copy, tree-sitter highlighting replaced by Shiki or highlight.js (bash, rust, python, js/ts/tsx, json, yaml, toml, diff at minimum, same token set the theme editor exposes).

---

## 5. Theme editor scope

Location: Settings then Theme; controls left, live preview of real components right; every change applies app-wide instantly.

| Area | Scope | Port note |
|------|-------|-----------|
| Model | One theme, two versions (light and dark). Light/Dark toggle in editor picks the version being edited and switches the app. Light/Dark/System in sidebar picks which shows. | |
| Start from | EvaOS theme or one of 10 kit themes shipping both versions (Ayu, Catppuccin (Latte/Mocha), Gruvbox, Solarized, …); swatches. Dark-only and light-only themes excluded. A theme replaces colors and syntax colors but not fonts or shape. | Theme JSON sources: `assets/themes/kit/*` (Apache-2.0) and `assets/themes/evaos.json` (never rewritten). Copying assets into the new repo is a read, with LICENSE-APACHE carried along. |
| Colors | **139 gpui-kit color keys** grouped (Base, Primary, Status, Buttons, Sidebar, Tabs, Charts, Palette, …); swatch with picker (palette + HSLA sliders) and hex entry (applies as typed once full hex); `group_box.title.foreground` excluded. | The key list is gpui-kit's, not Mantine's. Decide: keep the 139 keys as the token vocabulary and map to CSS variables (recommended, preserves theme import/export), or reduce to Mantine's palette (loses parity and export). |
| Typography | Interface and code font (any installed family), sizes; shared across both versions; size scales whole UI (rem). | Installed-font enumeration needs `queryLocalFonts` or main-process `font-list`. |
| Syntax | Code view colors, diagnostic colors, **41 syntax tokens** each color/italic/bold; per-version edits persist. EvaOS Light has a bundled palette; modes without bundled palette use kit defaults. | Token set follows the tree-sitter capture names; the highlighter must map to the same 41 names (Shiki TextMate scopes need a mapping table). |
| Other | Radius, large radius, shadows (shared); app-wide: focus ring, scrollbar mode, list highlight, motion durations and distances, notification placement/width/count/margins, sheet top margin. Easing curves and springs not exposed. | |
| UX | Search filters every tab; edited rows get a dot and reset button; groups show edited count; Reset Light/Dark (color edits only); Reset app settings (fonts, shape, app-wide). Undo/redo for every edit; drags within about 1 s coalesce into one step. | |
| Persistence | `theme.json` in config dir (`~/Library/Application Support/EvaOS`, `$EVAOS_CONFIG_DIR` overrides); holds only diffs: `base`, `shared` (font, shape), per-version color and syntax edits in kit theme-file shape, `app`. Migrates old per-mode-preset files; unreadable file is reported and replaced by next edit. | Same file-shape compat only matters if both apps share a config dir. |
| Export | Both themes, every layer applied, as one gpui-kit theme file; Copy JSON. | Spec the exact schema from `assets/themes/kit/*.json` first. |

Complexity: XL overall. Split: (a) token model + persistence + light/dark/system (M), (b) color keys editor (L), (c) typography/shape/app-wide (M), (d) syntax tokens (M), (e) undo/redo + search + reset (M), (f) export (S).

---

## 6. Feature Dependencies

```
Eva checkout reader ──> Dashboard ──> Workspace page
        │                  │
        │                  └──needs──> Inbox store (PRs to review count, Digest card)
        └──> append_todo ──> New Todo, Inbox To-do, Meeting Accept

Shell/layout ──> Side panel chrome ──> Terminal, Browser, Files, Side chats, Simulator
Shell/layout ──> Main tabs ──> Global search (⌘-Enter / ⌘-click new tab)

omp transport (stdio JSON lines)
    ├──> Chat transcript + virtualized log ──> Rich replies (widgets, mermaid) ──> widget Respond
    ├──> Composer (model, access, thinking, images) ──> Question card
    ├──> Shared writer registry ──> Side chats ──> Eregon session links
    └──> Chat list (sessions folder watch) ──> Chat actions (pin/rename/archive/delete), categories

Relay client ──> Relay feed (sessions running elsewhere)
Relay client ──> Inbox producers (blocked, failed, stale) ──> Inbox popover/page
Relay client ──> Phone escalation ──needs──> Prefs + Digests + Habit Gate status + HID idle

Inbox store ──> Repo sources ──> GitHub/Linear pollers ──> One row per work item ──> Inbox page ──> Snooze conditions
Inbox store ──> Digests ──needs──> Habit Gate status ──> Habits page + Gate overlay
Notification prefs ──enhances──> Inbox popover, digests, escalation, toasts
Jobs files ──> Jobs page ──> Inbox job-failed rows
Meetings records ──> Meetings page ──> Inbox meeting rows

Theme store ──> Everything visual; Theme editor ──needs──> syntax highlighter token mapping (chat code, Files editor)
Browser WebContentsView host ──conflicts──> DOM overlays (search, dialogs, gate overlay, Eregon window): needs one visibility/bounds coordinator
Files editor ──guards──> app quit and panel close
Terminal focus isolation ──constrains──> hotkey routing
```

### Dependency notes

- **Inbox before Dashboard's PRs-to-review and Digest card:** the Dashboard can ship first with those two tiles showing `n/a` or hidden.
- **Relay client is a hub** (feed, inbox producers, escalation, rename for external sessions, approvals): build it before Inbox producers, after basic Chat.
- **Chat's transport interface should be abstract from day one** (stdio omp, Claude Code bridge, Relay-subscribed external session, Eregon HTTP) so Side chats, harness switching, and herdr new-chat do not require rework.
- **Hotkey router, overlay coordinator, and `EvaFs` write gateway** are cross-cutting; they need their own early plan.
- **Browser coordinator conflicts with every full-window overlay**: define the overlay stack API in the shell phase, not in the browser phase.

---

## 7. Exact file writes the app performs

Inside the Eva checkout (`/Users/ike/Eva` or `EVA_ROOT`), the only app-initiated writes:

| # | Write | Trigger | Mechanics |
|---|-------|---------|-----------|
| 1 | `memory/todos.md` append of `- [ ] T<next> [workspace] … (added date)` after the last open row | New Todo (`⌘N`); Inbox To-do (`T`); Meeting Accept | `append_todo`; id = max over both todos files + 1 |
| 2 | Arbitrary file under the root, only on explicit Save | Files panel `⌘S` | Stage sibling temp, preserve permissions/ownership/ACLs/xattrs, fsync, recheck original unchanged, rename; refuses if file changed since load; `secrets/`, symlinks, traversal rejected |
| 3 | `jobs/<name>/job.md` (toggle `enabled:`, save edits, create new `jobs/<name>/`) | Jobs page | Line-preserving edit; temp sibling then rename; refuses changed-on-disk; create refuses existing |
| 4 | Recursive delete of `jobs/<name>` | Jobs Delete after confirm step | `jobs/.runs/*` is kept |
| 5 | `work/meetings/<stem>.json` `status` field (`accepted` or `dismissed`) | Meeting Accept / Dismiss (also Inbox Accept/Decline) | Atomic rewrite preserving unknown fields; EvaOS is sole writer of `status` |
| 6 | omp session files: rename (`set_session_name` to running omp, or a short `omp --mode rpc --resume` that then restores mtime), delete (session file + artifacts folder + `.bak` backups; refuses running chat) | Chat context menu | Lives under `~/.omp/agent/sessions/`, not the repo |
| 7 | Indirect: `habits.yml` and `~/.config/eva/gate.json` via `bun .omp/tools/habit-gate.ts` subcommands; `jobs/.runs/*` via `job-run.ts` | Habits page; Run now | App never writes these directly |
| 8 | Terminal commands | User typing | Shell user's normal filesystem access, unrestricted by design |

Outside the checkout, in the EvaOS config folder (`~/Library/Application Support/EvaOS`, override `$EVAOS_CONFIG_DIR`): `layout.json` (widths, tabs, active tab, pins), `chat.json` (`collapsed_groups`, `chat_categories`, `chat_group_order`, `chat_assignments`, `archived_chats`, `show_thinking`, `show_tools`, `harness`, starred models, omp account default), `theme.json`, `notifications.json`, `inbox.jsonl`, `inbox-views.json`, `digest.json`, `search-embeddings.bin`, `control.sock`. Temp: `$TMPDIR/evaos-images`, `$TMPDIR/evaos-media`. (`chat-order.json` is experimental-only: skip.)

Other writes the README implies that touch global state, flagged against PROJECT.md "Out of Scope":
- `~/.config/relay/devices.json`: adds `{id: "evaos", name: "EvaOS"}` only when `serve.json` exists (Relay pairing; unpair by removing the entry). Required for the Relay feed. **Needs an explicit decision; a read-only alternative does not exist.** Use a different id (for example `evaos-electron`) so it does not collide with the Rust app's entry and Relay's per-device dedup.
- omp's `session-pins.json` (pin/unpin).
- macOS Keychain "EvaOS Bitwarden session" (only if Bitwarden is built; recommended not).

Everything else is read-only.

---

## 8. MVP Definition

### Spike (first slice)

- [ ] Electron shell + toolchain (React, TS, Mantine, Vite, pnpm, Vitest, Playwright Electron), three-column shell skeleton
- [ ] Chat: resume + stream over stdio with the section 3 reducer; prompt echo reconciliation; abort; steer
- [ ] Virtualized log with pinned follow and Jump to latest / New reply pills; benchmark fixture
- [ ] Browser panel: WebContentsView, address bar, subtabs, DevTools, CDP, copy link, open externally
- [ ] Proof: Playwright screenshots in `proof/` vs the Rust app for both

### Parity phases (suggested order from dependencies)

1. **Foundations:** shell, layout persistence, theme token store with Light/Dark/System, hotkey router, overlay coordinator, `EvaFs` gateway, Eva reader.
2. **Dashboard + todos + workspace page.**
3. **Chat complete:** list, history, composer, model picker, access, question card, images, thinking/tools, categories, pins, Claude Code harness.
4. **Rich replies:** segmenter, mermaid, code frames, all widgets, image viewer.
5. **Side panel complete:** Terminal, Files, Side chats, then Simulator last.
6. **Jobs, Habits (+ gate overlay), Meetings.**
7. **Relay client, then Inbox** (store, persistence, producers, repo sources, popover, pollers, folding, page, snooze).
8. **Digests, notification prefs, phone escalation.**
9. **Eregon, main tabs, global search (instant tier then semantic tier).**
10. **Theme editor full scope** (the base theme store ships in phase 1; editor UI can come as soon as phase 4's code blocks exist).

### Defer (post-parity)

- `chat-order`, `chat-sections`, Relay-only widgets (`video`, `model`, `pr`), Bitwarden, Arc cookie import, Arc history seed.

---

## 9. Feature Prioritization Matrix

| Feature | User Value | Implementation Cost | Priority |
|---------|------------|---------------------|----------|
| Chat stream + virtual log | HIGH | HIGH | P1 (spike) |
| Browser panel | HIGH | HIGH | P1 (spike) |
| Shell/layout/theme store/hotkeys | HIGH | MEDIUM | P1 |
| Dashboard, New Todo, Workspace page | HIGH | MEDIUM | P1 |
| Chat list, composer, model picker, question card | HIGH | HIGH | P1 |
| Rich replies and widgets | HIGH | HIGH | P1 |
| Terminal, Files | HIGH | HIGH | P1 |
| Jobs, Habits + gate, Meetings | HIGH | MEDIUM | P1 |
| Relay client + Inbox core | HIGH | HIGH | P1 |
| Side chats, Eregon | MEDIUM | MEDIUM | P2 |
| Main tabs | MEDIUM | MEDIUM | P2 |
| Global search instant tier | MEDIUM | MEDIUM | P2 |
| Digests, prefs, phone escalation | MEDIUM | HIGH | P2 |
| Theme editor full | MEDIUM | HIGH | P2 |
| Global search semantic tier | LOW-MEDIUM | HIGH | P3 |
| iOS Simulator | LOW | MEDIUM | P3 |
| `diagram` fenced blocks | LOW | MEDIUM | P3 |

---

## 10. Competitor feature analysis (README stays primary)

Sources are marketing and README pages only, so confidence is LOW-MEDIUM.

| Feature | T3 Code (pingdotgg/t3code) | Synara (trysynara.com) | EvaOS Electron approach |
|---------|---------------------------|------------------------|-------------------------|
| Multi-provider agents | Claude Code, Codex, Cursor, OpenCode, Grok, Antigravity; multiple accounts for Codex/Claude | Claude Code, Codex, OpenCode, Cursor, Antigravity, Grok, Devin, Pi, Oh My Pi, Droid; provider detection | omp primary plus Claude Code harness. Matches README; do not add providers. |
| Parallel sessions with git worktrees | Yes | Per-task isolated worktrees, ownership | README has none; sessions grouped by workspace. Not table stakes for a single-user Eva surface. |
| Per-task terminal, browser, diff | Terminal and diff in app (details not on landing page) | Task workspace holds terminal, browser, diff, delivery status | EvaOS has terminal and browser panel but no diff review panel. A `diff` widget exists only in replies. Optional P3: git diff view in Files. |
| Git/PR flow (commit, push, open PR) | Source control integrations | Commit, push, open/review PR in-task | Out of scope (no pushes per PROJECT.md). |
| Permission modes | Documented | Review before accepting | Present: access chip and inbox approvals. |
| Keyboard shortcuts doc | Yes | n/a | Parity set in 2.1; add a shortcuts reference only if cheap (S). |
| Remote/phone access | iOS and Android apps, web | n/a | EvaOS has Relay phone escalation instead. |
| Side panel with tool tabs and launcher | n/a | Browser, terminal, diff per task | EvaOS panel was modelled after Synara's; matches. |
| Auto-update, installers, background server | winget, brew, deb, AUR, self-update | Free desktop app | Out of scope (no release packaging). |

Table-stakes expectations the README lacks that these apps have (all deliberately NOT added): worktree-per-task isolation, diff review before accept, in-app commit/PR, provider switching mid-task. They conflict with PROJECT.md scope (single-user Eva checkout, no remote git). One cheap, safe borrow is a read-only git diff view in the Files panel (P3, not parity).

---

## Sources

- `/Users/ike/Eva/apps/evaos/README.md` (all 1111 lines, read in full; HIGH)
- `/Users/ike/Eva/apps/evaos/examples/showcase.md` (HIGH)
- `/Users/ike/Eva/apps/evaos/src/chat.rs` frame reducer, `response`, tests (lines 1580-1610, 1889-1960, 2038-2260, 2412-2462, tests) (HIGH for what EvaOS handles; MEDIUM as a statement of omp's full protocol)
- `/Users/ike/Eva/apps/evaos/src/rich/widgets.rs` (grep only: no `video`, `model`, `pr` widgets)
- `/Users/ike/Eva/work/relay/packages/protocol/src/widget.ts` (read in full; HIGH) and `.../index.ts` (not read; frame names taken from the README, MEDIUM)
- `/Users/ike/Eva/.planning/PROJECT.md`
- https://github.com/pingdotgg/t3code and https://trysynara.com (landing pages via fetch, LOW-MEDIUM; fetched 2026-10-14)

## Gaps to Address in Phase Research

- `omp://rpc.md` was not found on disk: the first chat plan must confirm the frame list, `rpc-ui` vs `rpc` differences, subagent chip data source, and whether `set_session_name` exists in `rpc-ui`.
- Relay `index.ts` frames (879 lines) were not read; the Relay-client plan should enumerate them.
- Whether Eva-side tools or skills call `scripts/evaos-ctl` / `control.sock` (affects whether to rebuild it).
- Exact kit theme JSON schema for export (139 keys) and the 41 syntax-token names.
- `src/rich/widgets.rs` per-widget layout details (paddings, tone colours) were not read; use the showcase snapshot from the Rust app as the visual baseline.
- Whether Isaac wants the Arc cookie import and Bitwarden fill (anti-feature call is a recommendation, not verified user intent).

---
*Feature research for: EvaOS Electron port*
*Researched: 2026-10-14*
