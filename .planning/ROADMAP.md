# Roadmap: EvaOS Electron

## Overview

Port EvaOS from Rust + gpui to Electron + React + TypeScript at README parity. The two core-value risks (smooth gapless chat streaming, a real Chromium browser panel) are proven first in a spike phase that also builds the safety and proof harness. The shell and theme-variable architecture follow, then the Eva data pages, chat parity, rich replies, the side panel with Eregon and search, and finally Relay, Inbox and the theme editor. Every phase ends with the built app running, a green gate (install, typecheck, lint, test, build, e2e launch with zero console errors) and `proof/<phase>/` screenshots paired with state assertions (PROF-01).

## Phases

- [x] **Phase 1: Foundation, Harness and the Two Spikes** - Toolchain, EvaFs guard, proof harness, omp chat streaming spike, Chromium browser panel spike (completed 2026-10-15)
- [x] **Phase 2: Shell, Navigation and Theme Tokens** - Three-column shell, sidebar, main tabs, hotkey router, overlay stack, CSS-variable theming (completed 2026-10-15)
- [ ] **Phase 3: Dashboard, Workspaces, Jobs, Habits and Meetings** - Every Eva data page, New Todo, atomic job writes, gate overlay
- [ ] **Phase 4: Chat Parity** - Session catalog, categories, composer, questions, subagents, writer registry, harness, transport ADR
- [ ] **Phase 5: Rich Replies** - Streaming markdown, mermaid, diagram blocks and all 30 ui widgets with actions
- [ ] **Phase 6: Side Panel, Eregon and Global Search** - Terminal, Files, Side chats, iOS Simulator, Eregon floating chats, instant search
- [ ] **Phase 7: Relay, Inbox, Notifications and Theme Editor** - Relay client, inbox store and page, digests, notification prefs, full theme editor

## Phase Details

### Phase 1: Foundation, Harness and the Two Spikes

**Goal**: A runnable, safe Electron workspace where a live omp session streams gaplessly into a virtualized chat log beside a real Chromium browser panel, with proof captured.
**Mode:** mvp
**Depends on**: Nothing (first phase)
**Requirements**: FOUND-01, FOUND-02, FOUND-03, FOUND-04, FOUND-05, FOUND-06, FOUND-07, FOUND-08, CHAT-01, CHAT-02, CHAT-03, CHAT-04, CHAT-05, CHAT-06, CHAT-07, CHAT-08, BROW-01, BROW-02, BROW-03, BROW-04, BROW-05, BROW-06, BROW-07, BROW-08, BROW-09, PROF-01, PROF-02
**Success Criteria** (what must be TRUE):

  1. `pnpm dev` opens the app window and the green-gate script passes (typecheck, lint with em-dash check, Vitest, build, Playwright launch with zero console errors); attempting any write to the Eva checkout outside the EvaFs allowlist fails a test, and dev/test default to the fixture root, fake omp and temp config dir
  2. User opens a past omp session, sees its transcript, sends a prompt and watches the reply stream in order with no drops (1-byte, glued and split-emoji chunk tests pass); abort and steer work, and closing a chat closes stdin without ever sending SIGKILL
  3. On a 5,000-message fixture the log stays smooth while streaming, follows when pinned, shows Jump to latest then New reply when scrolled up, and the frame-time p95 and gapless seq results are recorded in `proof/`
  4. User opens a browser tool in the side panel, navigates by URL, search or bare port (`3000`), uses back/forward/reload/subtabs/DevTools, and the view's bounds match its slot through resizes and hide under a full-window overlay; a CDP text probe reads the page; the Bitwarden Chrome extension loads in the browser session and imported Arc logins keep a site signed in
  5. The built app is running and `proof/phase-1/` holds composite screenshots (DOM plus native browser view) that pass the blank-image check

**Plans**: 10 plans in 5 waves (Walking Skeleton: 01-SKELETON.md)

Plans:
**Wave 1**

- [x] 01-01-PLAN.md: Walking Skeleton: pnpm workspace, BaseWindow shell, typed `app.info` IPC, env contract, Vitest + Playwright, green gate (wave 1)

**Wave 2** *(blocked on Wave 1 completion)*

- [x] 01-02-PLAN.md: EvaFs allowlist + runtime write trap + scan, fixture Eva root, proofShot composite, metrics helper, advisory sentinel (wave 2)
- [x] 01-03-PLAN.md: Transcript slice: session parser port, session list, virtualized log, 5,000-message fixture (wave 2)
- [x] 01-04-PLAN.md: Recorded omp turn, deterministic fake omp, LineFramer + chunking tests (wave 2)
- [x] 01-07-PLAN.md: Browser single-tab slice: hardened WebContentsView, address bar, bounds sync, OverlayStack (wave 2)

**Wave 3** *(blocked on Wave 2 completion)*

- [x] 01-05-PLAN.md: Streaming slice: reducer port, ChatTransport, SessionManager seq batches, rAF drain with resync, composer send (wave 3)
- [x] 01-08-PLAN.md: Subtabs, history suggestions, DevTools, CDP PageControl, hotkey forwarding (wave 3)

**Wave 4** *(blocked on Wave 3 completion)*

- [x] 01-06-PLAN.md: Abort, steer, stdin-close lifecycle, pin/pills, 5,000-message frame-time benchmark (wave 4)
- [x] 01-09-PLAN.md: Chrome extensions + Bitwarden from the Web Store, Import Arc logins (wave 4)

**Wave 5** *(blocked on Wave 4 completion)*

- [x] 01-10-PLAN.md: Proof screenshots, validated metrics.json, packaged smoke, drag region, final proof gate (wave 5)

**UI hint**: yes

### Phase 2: Shell, Navigation and Theme Tokens

**Goal**: Users get the full EvaOS frame (sidebar, main card, right panel, footer) with tabs, hotkeys and live-themeable CSS variables, ready to host every page.
**Mode:** mvp
**Depends on**: Phase 1
**Requirements**: SHEL-01, SHEL-02, SHEL-03, SHEL-04, SHEL-05, SHEL-06, SHEL-07, SHEL-08, SETT-01, THEM-01, THEM-02
**Success Criteria** (what must be TRUE):

  1. User sees `[sidebar][main card][right panel card]` over a footer, drags edges within README ranges, double-click resets, widths persist across relaunch in `layout.json`, and the sidebar folds below the three-column floor at the 760 by 720 minimum
  2. User navigates the sidebar pages and sliding sub-pages (Chats, Settings, Meetings) with Back and Esc, opens/closes/pins main tabs with `⌘T`, `⌘W`, `⌘[`, `⌘]`, and every README hotkey works through one router that yields to a focused terminal
  3. Switching Light / Dark / System recolors the whole app live without remounting (139 color keys as CSS variables), the entrance animation plays once per launch and can be disabled for tests, and quitting with unsaved Files edits prompts
  4. The built app is running and `proof/phase-2/` screenshots (light and dark, folded and wide, tabs) exist with matching state assertions

**Plans**: 13 plans in 9 waves

Plans:
**Wave 1**

- [x] 02-01-PLAN.md: shell-core fit, layout-file, chords and scopes; theme-core skeleton (wave 1)
- [x] 02-02-PLAN.md: contract channels and sidebar data readers (wave 1)

**Wave 2**

- [x] 02-03-PLAN.md: tabs and places model port (wave 2)
- [x] 02-04-PLAN.md: theme-core 139 keys, bundled themes, resolveTheme (wave 2)

**Wave 3**

- [ ] 02-05-PLAN.md: main handlers (layout, theme, background, settings, sidebar, noMotion) and quit guard (wave 3)
- [ ] 02-06-PLAN.md: HotkeyRouter, dismiss stack, overlay wrappers, ScrollArea, dirty registry (wave 3)

**Wave 4**

- [ ] 02-07-PLAN.md: ThemeApplier, token aliases, Appearance control, entrance timeline (wave 4)

**Wave 5**

- [ ] 02-08-PLAN.md: three-column frame, grips, layout store, footer, spike removal (wave 5)

**Wave 6**

- [ ] 02-09-PLAN.md: tabs store, tab strip, context menu, toggles (wave 6)

**Wave 7**

- [ ] 02-10-PLAN.md: page router, placeholder pages, scroll memory, chat keep-alive (wave 7)

**Wave 8**

- [ ] 02-11-PLAN.md: sidebar, counts, Recent, sub-pages, account menu (wave 8)
- [ ] 02-12-PLAN.md: Settings pages (Theme, Chat, Notifications) (wave 8)

**Wave 9**

- [ ] 02-13-PLAN.md: hotkey, motion and quit-guard e2e, proof screenshots, gate, checklist (wave 9)

**UI hint**: yes

### Phase 3: Dashboard, Workspaces, Jobs, Habits and Meetings

**Goal**: Users can see and act on their Eva data (workspaces, todos, jobs, habits, meetings) from the new app with every write going through EvaFs.
**Mode:** mvp
**Depends on**: Phase 2
**Requirements**: DASH-01, DASH-02, DASH-03, DASH-04, DASH-05, DASH-06, DASH-07, DASH-08, JOBS-01, JOBS-02, JOBS-03, HABT-01, HABT-02, HABT-03, MEET-01, MEET-02, MEET-03
**Success Criteria** (what must be TRUE):

  1. User sees the Dashboard with hero banners, filters, Recent Workspaces activity charts (7D/30D/90D) and the workspace grid, reloaded on activation, the refresh button and `⌘R`; opening a workspace shows chips, timeline, open todos and sections
  2. User adds a todo with `⌘N` and a correctly numbered `- [ ] T<next> [workspace] ...` row appears after the last open row of the fixture `memory/todos.md`, with ids computed from both todos files
  3. User creates, edits, toggles, runs and deletes jobs with inline validation, atomic writes that change only edited lines, and a refusal when the file changed on disk
  4. User sees habit-gate status refresh every 4 seconds, edits habits and tasks, and a locked gate shows a near-opaque overlay that hides the browser view and offers Start, Done, Choose photo and Override with a reason
  5. User browses meetings grouped by day, opens a detail, and Accept appends a todo while Dismiss writes `status`; the built app is running and `proof/phase-3/` screenshots exist

**Plans**: TBD
**UI hint**: yes

### Phase 4: Chat Parity

**Goal**: Users manage and use all their omp chats (list, categories, composer, questions, subagents, shared writers) with the transport decision made and recorded.
**Mode:** mvp
**Depends on**: Phase 3
**Requirements**: CHTP-01, CHTP-02, CHTP-03, CHTP-04, CHTP-05, CHTP-06, CHTP-07, CHTP-08, CHTP-09, CHTP-10, CHTP-11, CHTP-12, CHTP-13, CHTP-14
**Success Criteria** (what must be TRUE):

  1. User sees the Chats page grouped by workspace with running chats first, pinned section, Show N more and status rows; searching opens all groups; custom categories, drag and drop, and right-click Rename/Pin/Archive/Delete all work, and the list updates within 500 ms of a session file change without refocusing
  2. User composes with the two-line box (model picker, access mode, context ring, account selector, image paste and drop), toggles thinking and tool details in Settings > Chat and sees them persist, and inline images open in a viewer
  3. User answers question cards inline (`1`-`4`) and extension UI requests, sees subagent chips with Clear done and the background jobs strip, and is prompted before sending into a session another writer owns
  4. User can pick the Claude Code harness and start a new chat through the transport the ADR selects, recorded in PROJECT.md, with prompts carrying the surface tag
  5. The built app is running and `proof/phase-4/` screenshots exist against fake omp and fixture sessions

**Plans**: TBD
**UI hint**: yes

### Phase 5: Rich Replies

**Goal**: Assistant replies render as rich content: streaming markdown, diagrams and every ui widget, with actions flowing back into the chat.
**Mode:** mvp
**Depends on**: Phase 4
**Requirements**: RICH-01, RICH-02, RICH-03, RICH-04, RICH-05, RICH-06
**Success Criteria** (what must be TRUE):

  1. User watches markdown render incrementally while streaming (tables, lists, highlighted code) without re-rendering closed blocks, and mermaid blocks appear as theme-colored SVG diagrams
  2. User sees `diagram` blocks render in a sandboxed frame and clicking opens the live page in the side browser
  3. All 30 ui widget types render, one fixture per `examples/showcase.md` block with a screenshot each under `proof/phase-5/`, and an invalid block shows a visible error card without breaking the reply
  4. User clicks a widget button, link, input or tab and the action returns as a reply or navigation; the vendored Relay schema drift test passes and the built app is running

**Plans**: TBD
**UI hint**: yes

### Phase 6: Side Panel, Eregon and Global Search

**Goal**: Users get the full side panel toolset, floating Eregon chats and instant global search across their Eva world.
**Mode:** mvp
**Depends on**: Phase 5
**Requirements**: PANL-01, PANL-02, PANL-03, PANL-04, PANL-05, PANL-06, PANL-07, ERGN-01, ERGN-02, ERGN-03, ERGN-04, SRCH-01, SRCH-02, SRCH-03, SRCH-04
**Success Criteria** (what must be TRUE):

  1. User opens the panel (`⌘⇧B`), sees the launcher, header tabs collapsing to icons under 640 px, and runs a real `$SHELL` terminal with themed colors, scrollback, copy and split right/down; closing panes sends HUP then KILL only to owned groups, and a packaged smoke test spawns a shell
  2. User browses the Files tool, previews without writing, and saves only on explicit Save with a conflict check; side chats open independent panes and the iOS Simulator tool reports Xcode state and lists/boots simulators
  3. User presses `⌘J` to open a floating Eregon chat with tabs, working/unread dots, history, suggested prompts and the Esc ladder, with turns going through the :8860 server
  4. User presses `⌘K` and sees grouped results across all README sources within 60 ms of typing stopping, navigates by keyboard and opens in the active or a new tab (`⌘`-Enter)
  5. The built app is running and `proof/phase-6/` screenshots exist

**Plans**: TBD
**UI hint**: yes

### Phase 7: Relay, Inbox, Notifications and Theme Editor

**Goal**: Users see work from everywhere in one inbox and can restyle the whole app with the full theme editor.
**Mode:** mvp
**Depends on**: Phase 6
**Requirements**: RELY-01, RELY-02, INBX-01, INBX-02, INBX-03, INBX-04, INBX-05, INBX-06, INBX-07, THEM-03, THEM-04, THEM-05, THEM-06
**Success Criteria** (what must be TRUE):

  1. User sees sessions running elsewhere in the chat list via the Relay client (device `evaos-electron`), and pairing and phone escalation only log in dry-run unless `EVAOS_PORT_LIVE=1`
  2. User sees the bell count and popover (J/K/Enter/E), the inbox page with snooze, To-do and done, items raised from chat questions/approvals/replies, repo sources and GitHub/Linear pollers folded to one row per work item, persisted in `inbox.jsonl`
  3. User sees digests on the schedule and sets Calm / Normal / On call, quiet hours, digest times and per-source ceilings in Settings > Notifications
  4. User starts from EvaOS or a paired kit theme, edits colors, typography, syntax tokens, radius and shadows with live preview, undoes and redoes (drags coalesced), and exports both versions with Copy JSON
  5. The built app is running and `proof/phase-7/` screenshots exist; the README hotkey audit passes

**Plans**: TBD
**UI hint**: yes

## Progress

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Foundation, Harness and the Two Spikes | 10/10 | Complete   | 2026-10-15 |
| 2. Shell, Navigation and Theme Tokens | 4/4 | Complete   | 2026-10-15 |
| 3. Dashboard, Workspaces, Jobs, Habits and Meetings | 0/TBD | Not started | - |
| 4. Chat Parity | 0/TBD | Not started | - |
| 5. Rich Replies | 0/TBD | Not started | - |
| 6. Side Panel, Eregon and Global Search | 0/TBD | Not started | - |
| 7. Relay, Inbox, Notifications and Theme Editor | 0/TBD | Not started | - |
