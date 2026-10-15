# EvaOS Electron

## What This Is

A port of EvaOS, Isaac's desktop app for his AI assistant Eva, from Rust + gpui-kit to Electron + React + TypeScript, reaching feature parity with today's app. EvaOS is a single-user personal operating surface over the Eva checkout at `/Users/ike/Eva`: a dashboard of workspaces, chat with live omp sessions, an inbox with digests and approvals, habits, jobs, meetings, a side panel with terminal, browser, files and side chats, a full theme editor, and rich `ui` widgets rendered inside chat replies. The new app lives entirely in this repo and reads the same Eva data the Rust app reads.

## Core Value

Chat with a live omp session streams smoothly (virtualized long scrollback, no dropped or reordered tokens) next to a real Chromium browser panel, clearly beating the current gpui app on both.

## Requirements

### Validated

(None yet — ship to validate)

### Active

**Spike (first milestone slice)**
- [ ] Electron shell (latest stable) with React, TypeScript, Mantine, Vite, pnpm, Vitest and Playwright for Electron wired up and running
- [ ] Chat view that starts or resumes an omp session (`omp --mode rpc-ui --resume <session file>` over stdin/stdout JSON lines, per `omp://rpc.md`) and streams replies with no dropped or reordered tokens
- [ ] Virtualized chat log that stays smooth on long scrollback, follows while pinned to bottom, and shows Jump to latest / New reply pills when scrolled up
- [ ] Browser panel built on Electron WebContentsView with DevTools and CDP page control: back, forward, reload, address bar (URL, search, bare local port), subtabs, title following, open in default browser, copy link
- [ ] Browser session loads real Chrome extensions (Bitwarden from the Chrome Web Store) and imports Arc logins, per Isaac's decision
- [ ] Measurable proof that browser quality and chat streaming smoothness beat current EvaOS, captured as Playwright screenshots under `proof/`

**Parity (every feature in the EvaOS README)**
- [ ] Dashboard: workspaces from `workspaces/<id>.md`, activity from journal headings and dated thread bullets, open todo counts, PRs to review, tag aliases, hero banners, filters (All / Active / Has Todos / Quiet), Recent Workspaces activity charts with 7D / 30D / 90D, workspace grid, compact and wide layouts, reload on window activation and `⌘R`
- [ ] New Todo (`⌘N`) appends a correctly numbered `- [ ] T<next> [workspace] … (added date)` row to `memory/todos.md` after the last open row
- [ ] Shell and layout: `[sidebar][main card][right panel card]` over a footer strip, responsive shrink order, sidebar auto-fold below the three-column floor, draggable column edges with double-click reset, widths persisted to `layout.json` in the EvaOS config folder (`$EVAOS_CONFIG_DIR` override), minimum window 760 by 720
- [ ] Sidebar: nav pages, Recent journal titles with `⌘F` filter, counts for Tasks and Jobs, bottom account menu and Light / Dark / System, sliding sub-pages for Chats, Settings and Meetings, `⌘B` toggle
- [ ] Global search (`⌘K`): grouped results across pages, settings, workspaces, dashboards, chats, meetings, work items, todos, notes, files, GitHub PRs and issues, Linear issues; keyboard navigation; opens through existing paths; index built off the UI thread
- [ ] Chat list: omp sessions for the repo grouped by workspace, collapsible groups saved to `chat.json`, running chats first, pinned section, Show N more, status rows (open, working, needs approval, has a question, job), custom categories with drag and drop, right-click Rename / Pin / Archive / Delete
- [ ] Chat view: composer with toolbar (model, access, context, omp account), thinking and tool-details switches, inline images, question cards with inline answers, subagent chips, background jobs, live session watching without refocus, Claude Code harness option, Relay feed of sessions running elsewhere
- [ ] Rich replies: fenced `mermaid` blocks as themed SVG diagrams and every `ui` widget block in `examples/showcase.md` (badge, chart line and bar, button, text, stat, stack, avatar, card, timeline, tickets, tabs, table, rows, recipe, quote, progress, list, link, input, image, grid, gallery, emails, divider, diff, compare, collapse, code, callout, audio) rendering as the showcase expects, with widget actions flowing back as replies
- [ ] Eregon (`⌘J`): floating footer chats with tabs, unread and working dots, history, suggested prompts, minimize / expand / close, Esc ladder
- [ ] Inbox: bell with popover, inbox page, append-only `inbox.jsonl` store, repo sources, one row per work item, keys (J / K / Enter / E), digests, notifications preferences, approvals and phone escalation through Relay
- [ ] Side panel (`⌘⇧B`): launcher, header tabs with icon collapse under 640 px, full view, close; tools Terminal, Browser, Side chats, Files, iOS Simulator
- [ ] Terminal: real interactive `$SHELL` PTY sessions in the Eva root (node-pty + xterm.js or equivalent), split right / down, scrollback, selection and copy, themed ANSI colors, clean HUP then KILL of owned process groups only
- [ ] Files panel: explorer rooted at the Eva root, preview without writing, explicit save writes only
- [ ] Side chats: independent conversation panes beside main
- [ ] Jobs: list from `jobs/<name>/job.md`, enabled switch, last and next run, editor with validation, atomic temp-file-then-rename writes, Run now via `bun .omp/tools/job-run.ts`
- [ ] Habits: status via `bun .omp/tools/habit-gate.ts <cmd> --json` polled every 4 seconds, habit and task editors, breaks, history, full-window gate overlay with Start / Done / Choose photo / Override
- [ ] Meetings: `work/meetings/<stem>.json` records grouped by day, home summary, detail with Open Notes and proposals, Accept appends a todo
- [ ] Workspace page: header chips, activity bars, merged timeline, open todos and file sections
- [ ] Settings: Chat section (thinking, tool details, harness, notifications) and Theme section
- [ ] Theme editor: one theme with light and dark versions, Start from EvaOS or the 10 paired kit themes, all color keys grouped with picker and hex entry, typography, syntax tokens, radius and shadows, undo and redo, live preview, export with Copy JSON
- [ ] Hotkeys: every shortcut in the README (`⌘N`, `⌘R`, `⌘B`, `⌘⇧B`, `⌘J`, `⌘K`, `⌘F`, Esc ladders) with terminal focus isolation
- [ ] Entrance animation timed like the reference
- [ ] Each phase ends with a running app and Playwright screenshot proof under `proof/`

### Out of Scope

- Modifying `/Users/ike/Eva/apps/evaos`, Relay, or any global config (`~/.claude`, `~/.omp`, shell rc) — the Rust app and Relay are read-only sources of truth
- Writes to the Eva checkout beyond the exact writes current EvaOS performs (New Todo, explicit Files saves, job.md edits, meeting Accept, inbox and layout state in the config folder) — data safety
- Running the new app destructively against Isaac's live omp sessions — never kill or corrupt sessions he is using
- Experimental-build-only features (`chat-order`, `chat-sections` experiments) — not part of the shipping README surface, revisit after parity
- Voice input in chat — omp RPC has no voice input in the current app either
- Remote git pushes, PRs, or release packaging — local `main` only per constraints

## Context

- **Source app:** `/Users/ike/Eva/apps/evaos`, Rust, about 68k lines. `README.md` lists every feature and is the parity checklist. Key files: `src/chat_view.rs`, `src/chat.rs`, `src/inbox.rs`, `src/inbox/digest.rs`, `src/inbox_view.rs`, `src/habits_view.rs`, `src/theme_editor.rs`, `src/panel/*`, `src/rich/widgets.rs`, `examples/showcase.md` (widget spec with expected rendering, 13 fenced `ui` blocks covering about 30 widget types).
- **Relay phone app:** `/Users/ike/Eva/work/relay`, pnpm monorepo with `apps/mobile` and `packages/protocol`. Its widget schemas and reply protocol are the closest TypeScript analog; reuse where they port to web cleanly.
- **Eva data:** `/Users/ike/Eva` (`workspaces/`, `memory/`, `jobs/`, `habits.yml`, `work/items/`, `work/meetings/`). omp sessions live under `~/.omp/agent/sessions/`. Habit Gate and job runner are Bun CLIs under `.omp/tools/`.
- **Why Electron:** the gpui browser panel is a native WKWebView (wry) layered over gpui with stacking, focus and position-sync seams and weak DevTools. Electron's WebContentsView gives a real Chromium browser in the same engine as the UI. One React stack also sits closer to Relay and iterates faster for agents.
- **Reference apps:** Synara (trysynara.com) and T3 Code (pingdotgg/t3code), both Electron.
- **Backend logic:** per module, either a Rust sidecar reusing existing code or a TypeScript rewrite, whichever is simpler; the choice must be justified in the plan for that module.
- **Repo state:** greenfield apart from a project-local GSD install, `IDEA.md`, and `run-gsd.sh` (the unattended driver). `package.json` is a placeholder and will be replaced by the pnpm workspace.

## Constraints

- **Tech stack**: Electron (latest stable), React, TypeScript, Mantine, Vite, pnpm; Vitest and Playwright for Electron — fixed by Isaac
- **Isolation**: everything lives in this repo; never modify the Rust app, Relay, or global config — source-of-truth protection
- **Data safety**: Eva checkout is read-only except the exact writes current EvaOS performs; no destructive use of live sessions — Isaac's working data
- **UI text**: no em dashes in UI strings — style rule
- **Proof**: each phase ends with a running app and Playwright screenshots under `proof/` — verifiable progress without Isaac present
- **Git**: commit per completed plan on `main`; no remote, no pushing — local-only workflow
- **Unattended**: Isaac is unavailable; every decision takes the recommended default — autonomous run

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Electron + React + TypeScript instead of gpui | Real Chromium browser panel in the same engine, one React stack near Relay, faster agent iteration | — Pending |
| Spike chat streaming + browser before parity | These are the two places the port must clearly win; validate early | — Pending |
| Backend reuse decided per module (Rust sidecar vs TypeScript rewrite) | Whichever is simpler; justified in each plan | — Pending |
| WebContentsView for the browser panel | Modern Electron API with DevTools and CDP, no BrowserView deprecation | — Pending |
| Coarse granularity, YOLO, parallel plans, research + plan check + verifier on | Recommended defaults chosen for the unattended run | — Pending |
| Keep Bitwarden and Arc login import in the browser panel, via real Chrome extensions (`electron-chrome-extensions` + `electron-chrome-web-store`) rather than reimplementation | Isaac's recorded decision (CLAUDE.md, 2026-10-14); research had proposed dropping them as anti-features | — Pending |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd-transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd:complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-10-14 after initialization*
