# Requirements: EvaOS Electron

**Defined:** 2026-10-14
**Core Value:** Chat with a live omp session streams smoothly (virtualized long scrollback, no dropped or reordered tokens) next to a real Chromium browser panel, clearly beating the current gpui app on both.

## v1 Requirements

Requirements for the parity milestone. Each maps to roadmap phases. The source of truth for behavior is `/Users/ike/Eva/apps/evaos/README.md`; "as the README describes" means that document's wording governs.

### Foundation and Safety

- [x] **FOUND-01**: Developer can run `pnpm install`, `pnpm dev` and `pnpm build` on an Electron (latest stable) + electron-vite + React + TypeScript + Mantine workspace and see the app window open
- [x] **FOUND-02**: Developer can run `pnpm test` (Vitest, separate main / preload / renderer projects) and `pnpm e2e` (Playwright `_electron` against the built app) and both pass
- [x] **FOUND-03**: Every write to the Eva checkout goes through one `EvaFs` gateway with a closed allowlist (todos append, explicit Files save, `job.md` edit/create/delete, meeting `status`), and a test fails if any other path writes there
- [x] **FOUND-04**: Dev and test runs default to a fixture Eva root, a fake omp binary and a temporary config dir; using the live checkout or live omp requires an explicit opt-in flag
- [x] **FOUND-05**: The app stores its own state (`layout.json`, `chat.json`, `inbox.jsonl`, theme) in a config folder separate from the Rust app's, overridable with `$EVAOS_CONFIG_DIR`
- [x] **FOUND-06**: A `proofShot` helper captures composite screenshots (DOM plus every WebContentsView via `capturePage`), rejects blank images, and writes them under `proof/<phase>/`
- [x] **FOUND-07**: A green-gate script runs install, typecheck, lint (including an em-dash lint on UI strings), unit tests, build and an e2e launch with zero console errors; every phase ends with it passing
- [x] **FOUND-08**: Main and renderer communicate only through a typed IPC contract validated with Zod at the boundary

### Chat Streaming (spike)

- [x] **CHAT-01**: User can open a past omp session and see its transcript parsed from the session file (active branch, user and assistant messages, tool calls, thinking blocks)
- [x] **CHAT-02**: User can send a prompt into a past chat; the app starts `omp --mode rpc-ui --resume <session file>` in the Eva repo and streams the reply over stdin/stdout JSON lines
- [x] **CHAT-03**: Streamed frames arrive in order with no drops: a UTF-8-aware line framer in main, per-session sequence numbers, and a renderer that resyncs from a snapshot on any gap, verified by a test that feeds 1-byte, glued and split-emoji chunks
- [x] **CHAT-04**: Chat log is virtualized and stays smooth on a 5,000-message fixture while streaming, measured by a frame-time benchmark recorded in `proof/`
- [x] **CHAT-05**: Log follows new content while pinned to the bottom; scrolling up shows Jump to latest, then New reply when output arrives; clicking or scrolling down resumes following
- [x] **CHAT-06**: User can abort a running reply and steer with a new prompt while one is running, as the README describes
- [x] **CHAT-07**: Closing a chat or quitting closes omp's stdin and waits for exit; the app never sends SIGKILL to a session process
- [x] **CHAT-08**: Chat transport sits behind one interface so omp stdio, the Claude Code harness, Relay-observed sessions and Eregon can share the same view

### Browser Panel (spike)

- [x] **BROW-01**: User can open a Browser tool in the side panel backed by Electron WebContentsView, with back, forward, reload, copy link and open in the default browser
- [x] **BROW-02**: Address bar accepts a URL, a search query, or a bare local port (`3000` opens `http://127.0.0.1:3000/`), and the tab title follows the page
- [x] **BROW-03**: User can open multiple browser subtabs with + and close them; each is its own WebContentsView
- [x] **BROW-04**: The browser view's bounds track the React layout slot through drags and resizes, and it hides whenever a full-window overlay (global search, dialogs, gate overlay) is shown, through one shared overlay mechanism
- [x] **BROW-05**: User can open DevTools for the page, and the app can drive the page through the Chrome DevTools Protocol (navigate, read text, click) via a `PageControl` module
- [x] **BROW-06**: Guest pages run in a sandboxed partition with no preload, `window.open` and permission requests denied by default, and app hotkeys forwarded from the guest
- [x] **BROW-07**: Typing in the address bar suggests up to six pages from in-app history, ranked as the README describes (Arc history import deferred)
- [x] **BROW-08**: Browser panel session loads real Chrome extensions through `electron-chrome-extensions` and `electron-chrome-web-store`, and the Bitwarden extension installed from the Chrome Web Store autofills credentials in guest pages
- [x] **BROW-09**: User can import Arc logins (cookies for the README's site list) into the browser panel session so already signed-in sites stay signed in

### Shell and Navigation

- [x] **SHEL-01**: App shows `[sidebar][main card][right panel card]` over a footer strip, with the README's shrink order, the three-column floor, automatic sidebar folding, and a 760 by 720 minimum window
- [x] **SHEL-02**: User can drag the sidebar and panel edges within the README's ranges, double-click to reset, and widths persist in `layout.json`
- [x] **SHEL-03**: Sidebar shows the nav pages, Recent journal titles filtered by `⌘F`, Tasks and Jobs counts, Setting, Help Center, the account menu and Light / Dark / System, and slides to sub-pages for Chats, Settings and Meetings with Back and Esc
- [x] **SHEL-04**: User can open main tabs (`⌘T`), close them (`⌘W`, without stopping a chat), move through per-tab history (`⌘[`, `⌘]`), `⌘`-click to open in a new tab, right-click Pin / Unpin / Close / Close others, with tabs persisted in `layout.json`
- [x] **SHEL-05**: Every README hotkey works (`⌘N ⌘R ⌘B ⌘⇧B ⌘J ⌘K ⌘F ⌘T ⌘W ⌘[ ⌘] ⌘S ⌘1-9`, Esc ladders) through one hotkey router that yields to a focused terminal
- [x] **SHEL-06**: Scroll areas are contained with thin themed scrollbars and continuation fades, and each main page keeps its own scroll position across navigation
- [x] **SHEL-07**: The entrance animation plays once per launch with the README's timing and can be disabled for tests
- [x] **SHEL-08**: Quitting with unsaved Files edits asks before closing

### Dashboard and Workspaces

- [ ] **DASH-01**: Dashboard lists workspaces from `workspaces/<id>.md` or `workspaces/<id>/<id>.md`, plus the built-in Eva workspace, with tag aliases applied
- [ ] **DASH-02**: Activity comes from journal headings (`memory/journal.md` and `memory/archive/*.md`) and dated `## Threads` bullets; open todos are counted from `memory/todos.md`
- [ ] **DASH-03**: Hero shows rotating banners, a summary line, and New Todo and All Workspaces buttons; filters All / Active / Has Todos / Quiet work as the README describes
- [ ] **DASH-04**: Recent Workspaces shows the two most recent with a smoothed activity line, hatched current week, daily bars and a 7D / 30D / 90D switch
- [ ] **DASH-05**: Workspaces grid shows tagline, latest journal title or thread, last active and open todos; compact and wide card layouts reflow as the README describes
- [ ] **DASH-06**: Data reloads on window activation, the refresh button and `⌘R`
- [x] **DASH-07**: User can add a todo (`⌘N`, hero button, top bar) that appends `- [ ] T<next> [workspace] … (added date)` after the last open row of `memory/todos.md`, with the next id computed from both todos files and a re-read check before writing
- [ ] **DASH-08**: Workspace page shows the header chips, New Todo preselecting the workspace, Open File, activity bars, the merged Timeline with Show all, open todos and the file's `##` sections

### Chat Parity

- [ ] **CHTP-01**: Sidebar Chats page lists the repo's omp sessions grouped by workspace with collapsible headers saved to `chat.json`, running chats first, pinned section, the five newest with Show N more, and status rows (open, working, needs approval, has a question, job)
- [ ] **CHTP-02**: User can search chats by title and the search opens every group in full including archived chats
- [ ] **CHTP-03**: User can create, rename and delete custom categories, move chats by drag and drop or right-click Move to, and reorder headers by drag
- [ ] **CHTP-04**: User can right-click a chat for Rename, Pin / Unpin, Archive / Unarchive and Delete, with rename reaching the running omp or a short resume as the README describes
- [ ] **CHTP-05**: Chat list updates within 500 ms of session file changes without refocusing the window
- [ ] **CHTP-06**: Composer matches the README's two-line box with toolbar: model picker, access mode, context ring, omp account selector on unsent chats, image paste and drop
- [ ] **CHTP-07**: Settings › Chat switches for thinking and tool details apply to the chat view and persist as `show_thinking` / `show_tools`
- [ ] **CHTP-08**: Question cards render every blocked `ask` with inline single-choice answers (`1`-`4`), and extension UI requests (select, confirm, input, editor) are answerable
- [ ] **CHTP-09**: Subagent chips show running and finished subagents with Clear done, and the background jobs strip shows unfinished jobs while the omp process runs
- [ ] **CHTP-10**: Sending into a session another writer owns prompts first, and a shared writer registry tracks which pane owns which session
- [ ] **CHTP-11**: Prompts carry the `<surface><machine> - EvaOS</surface>` tag as the README describes
- [ ] **CHTP-12**: User can choose the Claude Code harness in Settings › Chat and chats then run through that bridge
- [ ] **CHTP-13**: Inline images in prompts and tool results render in the chat with an image viewer
- [ ] **CHTP-14**: Starting a new chat works through the transport the chat plan's ADR selects (direct omp child or herdr plus Relay), and the choice is recorded in PROJECT.md

### Rich Replies

- [ ] **RICH-01**: Assistant markdown renders incrementally while streaming with closed blocks memoized, GFM tables and lists, and syntax-highlighted code fences
- [ ] **RICH-02**: Fenced `mermaid` blocks render as SVG diagrams themed from the app theme
- [ ] **RICH-03**: Fenced `diagram` blocks render their HTML in a sandboxed frame and click opens the live page in the side browser
- [ ] **RICH-04**: All 30 `ui` widget types render (stack, card, grid, tabs, collapse, text, badge, divider, stat, chart line / grouped bar / stacked bar, rows, table, progress, list, callout, code, quote, avatar, timeline, button, link, input, image, gallery, compare, tickets, emails, diff, recipe, audio) with one fixture per `examples/showcase.md` block and a screenshot each under `proof/`
- [ ] **RICH-05**: Widget schemas come from Relay's protocol package, vendored with a pinned commit and a drift test, and invalid blocks fall back to a visible error card instead of breaking the reply
- [ ] **RICH-06**: Widget actions (button, link, input, tabs selection) flow back as replies or navigation as the README describes

### Side Panel

- [ ] **PANL-01**: User can open the side panel (`⌘⇧B` or the panel button), see the launcher when no tool is open, header tabs with icon collapse under 640 px, + back to launcher, full view and close
- [ ] **PANL-02**: Terminal tool runs real interactive `$SHELL` sessions in the Eva root with node-pty and xterm.js, with themed ANSI colors, scrollback, selection and copy, and app shortcuts blocked while the terminal has focus
- [ ] **PANL-03**: User can split a terminal right or down in the focused shell's directory, close panes and subtabs, and closing sends HUP then KILL only to owned process groups after a grace period
- [ ] **PANL-04**: Terminal survives a packaged build: node-pty is unpacked from asar and a packaged smoke test spawns a shell
- [ ] **PANL-05**: Files tool shows an explorer rooted at the Eva root, previews files without writing, and saves only on explicit Save with a conflict check against the on-disk version
- [ ] **PANL-06**: Side chats tool opens independent conversation panes beside main sharing the chat view and writer registry
- [ ] **PANL-07**: iOS Simulator tool checks Xcode, license and `simctl` and lists and boots simulators as the README describes

### Eregon

- [ ] **ERGN-01**: `⌘J` opens an Eregon chat floating above the footer's right end with minimize, expand and close, clamped to the window
- [ ] **ERGN-02**: Footer shows one tab per open Eregon chat with working and unread dots, the Eregon button and history; Esc closes history, then minimizes, then leaves the Chats page
- [ ] **ERGN-03**: Eregon turns go through the Eva-side server on port 8860 (`/turn?chat=<id>`), started from the Eva repo when not running, and links open in the side browser
- [ ] **ERGN-04**: An empty Eregon chat shows three suggested prompts and its log follows independently of main Chat

### Global Search

- [ ] **SRCH-01**: `⌘K` opens a centered search box with grouped results (Pages, Settings, Workspaces, Dashboards, Chats, Meetings, Work items, Todos, Notes, Files, GitHub PRs, GitHub issues, Linear issues) with icon, title, subtitle and matching line
- [ ] **SRCH-02**: Up and down move the selection, Enter opens in the active tab, `⌘`-Enter or `⌘`-click opens in a new tab, Esc or outside click closes, and results open through the existing navigation paths
- [ ] **SRCH-03**: The index is built off the UI thread at launch and when the box opens, covering the README's sources with ripgrep-style ignore rules and a 40,000 file cap
- [ ] **SRCH-04**: The instant tier scores titles then subtitles 60 ms after typing stops, as the README describes

### Jobs, Habits, Meetings

- [ ] **JOBS-01**: Jobs page lists each `jobs/<name>/job.md` with schedule, enabled switch, last run, run state and next due computed as the README describes
- [x] **JOBS-02**: User can create and edit jobs with inline validation of names and durations; saves change only edited lines, write via temp file and rename, and refuse a file changed on disk since opening
- [ ] **JOBS-03**: User can Run now (`bun .omp/tools/job-run.ts <name>` detached), open the last session, and delete a job after confirmation
- [ ] **HABT-01**: Habits page reads `habit-gate.ts status --json` on launch, every 4 seconds, on page open, on activation and `⌘R`, and shows gate state, habits, one-time tasks, today's breaks and history
- [ ] **HABT-02**: User can add, edit and remove habits and tasks through the habit-gate CLI subcommands
- [ ] **HABT-03**: While locked, a nearly opaque gate overlay covers the window, hides the browser view, and offers Start, countdown, Done, Choose photo and Override with a typed reason
- [ ] **MEET-01**: Meetings sidebar page lists `work/meetings/<stem>.json` records newest first grouped by day, with test calls folded, and a title search
- [ ] **MEET-02**: Meeting Home shows the summary line and Detail shows title, time, attendees, Open Notes and proposals
- [x] **MEET-03**: Accept appends a todo through `EvaFs` and Dismiss writes the record's `status` field

### Inbox and Relay

- [ ] **RELY-01**: App connects to the local Relay host as device `evaos-electron`, reads the session feed, and shows sessions running elsewhere in the chat list
- [ ] **RELY-02**: Relay pairing that writes outside the repo and phone escalation run in dry-run (log only) unless `EVAOS_PORT_LIVE=1` is set
- [ ] **INBX-01**: Inbox store persists to an append-only `inbox.jsonl` in the app's config folder with `put` / `drop` records and a process-wide upsert API
- [ ] **INBX-02**: Bell in the top bar shows the open count and a popover with J / K / Enter / E keys as the README describes
- [ ] **INBX-03**: Chat producers raise inbox items for questions, approvals and finished replies
- [ ] **INBX-04**: Repo sources and GitHub and Linear pollers produce items, folded into one row per work item
- [ ] **INBX-05**: Inbox page lists items with snooze, To-do (appends a todo) and done actions
- [ ] **INBX-06**: Digests are produced on the README's schedule and shown on the inbox page and dashboard
- [ ] **INBX-07**: Settings › Notifications holds the Calm / Normal / On call modes, quiet hours, digest times and per-source ceilings

### Settings and Theme

- [x] **SETT-01**: Settings page lists Chat, Theme and Notifications sections in the sidebar and shows the picked one in main
- [x] **THEM-01**: The app theme is a set of CSS variables applied imperatively (139 color keys, typography, radius, shadows) so edits apply live without remounting
- [x] **THEM-02**: One theme has light and dark versions; Light / Dark / System picks which shows, and the editor's Light / Dark picks the version edited
- [ ] **THEM-03**: User can start from EvaOS's theme or one of the 10 paired kit themes with swatches
- [ ] **THEM-04**: User can edit every color key grouped as the README describes, with a picker and hex entry, typography (interface and code font, sizes), syntax tokens (41, color / italic / bold), radius and shadows
- [ ] **THEM-05**: Undo and redo cover every edit, with drags within about a second coalesced into one step, and a live preview of real components updates as edits happen
- [ ] **THEM-06**: User can export both versions as one theme file and Copy JSON

### Proof

- [x] **PROF-01**: Each phase ends with the built app running and Playwright screenshots under `proof/<phase>/` paired with state assertions
- [x] **PROF-02**: The spike records chat streaming numbers (gapless sequence check, frame-time p95 on the benchmark fixture) and browser checks (bounds match slot, overlay hides view, CDP text probe) in `proof/`

## v2 Requirements

Deferred to a later milestone. Tracked but not in the current roadmap.

### Search and Browser extras

- **SRCH-05**: Semantic search tier (intent, live and embedding ranking) after 400 ms idle
- **BROW-10**: Arc history import for address suggestions

### Widgets

- **RICH-07**: Relay-only widgets `video`, `model` (3D) and `pr`

### Files

- **PANL-08**: Read-only git diff view in the Files tool

## Out of Scope

Explicitly excluded. Documented to prevent scope creep.

| Feature | Reason |
|---------|--------|
| `chat-order` and `chat-sections` experiments and the experimental build | Experimental-only; not part of the shipping README surface |
| WKWebView focus hacks, Safari user-agent synthesis, popup bridging | gpui and WebKit workarounds Electron makes unnecessary |
| Native cell-canvas terminal, gpui scaffolding, Rust snapshot CLI, `control.sock` | Replaced by xterm.js, Electron and Playwright |
| Voice input in chat | omp RPC has no voice input in the current app either |
| Empty pages (Calendar, Tasks, Memory, Files, Help Center) beyond their empty states | Not built in the Rust app |
| Rust sidecar | TypeScript rewrite is simpler per research; revisit only on a measured failure |
| Writes to the Eva checkout outside the `EvaFs` allowlist, modifying the Rust app, Relay or global config | Data safety and project constraints |
| Remote git, pushes, PRs, signed or notarized packaging | Local-only workflow |

## Traceability

Which phases cover which requirements. Updated during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| FOUND-01 | Phase 1 | Complete |
| FOUND-02 | Phase 1 | Complete |
| FOUND-03 | Phase 1 | Complete |
| FOUND-04 | Phase 1 | Complete |
| FOUND-05 | Phase 1 | Complete |
| FOUND-06 | Phase 1 | Complete |
| FOUND-07 | Phase 1 | Complete |
| FOUND-08 | Phase 1 | Complete |
| CHAT-01 | Phase 1 | Complete |
| CHAT-02 | Phase 1 | Complete |
| CHAT-03 | Phase 1 | Complete |
| CHAT-04 | Phase 1 | Complete |
| CHAT-05 | Phase 1 | Complete |
| CHAT-06 | Phase 1 | Complete |
| CHAT-07 | Phase 1 | Complete |
| CHAT-08 | Phase 1 | Complete |
| BROW-01 | Phase 1 | Complete |
| BROW-02 | Phase 1 | Complete |
| BROW-03 | Phase 1 | Complete |
| BROW-04 | Phase 1 | Complete |
| BROW-05 | Phase 1 | Complete |
| BROW-06 | Phase 1 | Complete |
| BROW-07 | Phase 1 | Complete |
| BROW-08 | Phase 1 | Complete |
| BROW-09 | Phase 1 | Complete |
| SHEL-01 | Phase 2 | Complete |
| SHEL-02 | Phase 2 | Complete |
| SHEL-03 | Phase 2 | Complete |
| SHEL-04 | Phase 2 | Complete |
| SHEL-05 | Phase 2 | Complete |
| SHEL-06 | Phase 2 | Complete |
| SHEL-07 | Phase 2 | Complete |
| SHEL-08 | Phase 2 | Complete |
| DASH-01 | Phase 3 | Pending |
| DASH-02 | Phase 3 | Pending |
| DASH-03 | Phase 3 | Pending |
| DASH-04 | Phase 3 | Pending |
| DASH-05 | Phase 3 | Pending |
| DASH-06 | Phase 3 | Pending |
| DASH-07 | Phase 3 | Complete |
| DASH-08 | Phase 3 | Pending |
| CHTP-01 | Phase 4 | Pending |
| CHTP-02 | Phase 4 | Pending |
| CHTP-03 | Phase 4 | Pending |
| CHTP-04 | Phase 4 | Pending |
| CHTP-05 | Phase 4 | Pending |
| CHTP-06 | Phase 4 | Pending |
| CHTP-07 | Phase 4 | Pending |
| CHTP-08 | Phase 4 | Pending |
| CHTP-09 | Phase 4 | Pending |
| CHTP-10 | Phase 4 | Pending |
| CHTP-11 | Phase 4 | Pending |
| CHTP-12 | Phase 4 | Pending |
| CHTP-13 | Phase 4 | Pending |
| CHTP-14 | Phase 4 | Pending |
| RICH-01 | Phase 5 | Pending |
| RICH-02 | Phase 5 | Pending |
| RICH-03 | Phase 5 | Pending |
| RICH-04 | Phase 5 | Pending |
| RICH-05 | Phase 5 | Pending |
| RICH-06 | Phase 5 | Pending |
| PANL-01 | Phase 6 | Pending |
| PANL-02 | Phase 6 | Pending |
| PANL-03 | Phase 6 | Pending |
| PANL-04 | Phase 6 | Pending |
| PANL-05 | Phase 6 | Pending |
| PANL-06 | Phase 6 | Pending |
| PANL-07 | Phase 6 | Pending |
| ERGN-01 | Phase 6 | Pending |
| ERGN-02 | Phase 6 | Pending |
| ERGN-03 | Phase 6 | Pending |
| ERGN-04 | Phase 6 | Pending |
| SRCH-01 | Phase 6 | Pending |
| SRCH-02 | Phase 6 | Pending |
| SRCH-03 | Phase 6 | Pending |
| SRCH-04 | Phase 6 | Pending |
| JOBS-01 | Phase 3 | Pending |
| JOBS-02 | Phase 3 | Complete |
| JOBS-03 | Phase 3 | Pending |
| HABT-01 | Phase 3 | Pending |
| HABT-02 | Phase 3 | Pending |
| HABT-03 | Phase 3 | Pending |
| MEET-01 | Phase 3 | Pending |
| MEET-02 | Phase 3 | Pending |
| MEET-03 | Phase 3 | Complete |
| RELY-01 | Phase 7 | Pending |
| RELY-02 | Phase 7 | Pending |
| INBX-01 | Phase 7 | Pending |
| INBX-02 | Phase 7 | Pending |
| INBX-03 | Phase 7 | Pending |
| INBX-04 | Phase 7 | Pending |
| INBX-05 | Phase 7 | Pending |
| INBX-06 | Phase 7 | Pending |
| INBX-07 | Phase 7 | Pending |
| SETT-01 | Phase 2 | Complete |
| THEM-01 | Phase 2 | Complete |
| THEM-02 | Phase 2 | Complete |
| THEM-03 | Phase 7 | Pending |
| THEM-04 | Phase 7 | Pending |
| THEM-05 | Phase 7 | Pending |
| THEM-06 | Phase 7 | Pending |
| PROF-01 | Phase 1 | Complete |
| PROF-02 | Phase 1 | Complete |

**Coverage:**
- v1 requirements: 103 total
- Mapped to phases: 103
- Unmapped: 0

---
*Requirements defined: 2026-10-14*
*Last updated: 2026-10-14 after roadmap creation*
