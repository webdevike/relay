# Project Research Summary

**Project:** EvaOS Electron
**Domain:** Single-user desktop AI-assistant workbench (port of Rust/gpui EvaOS to Electron + React + TypeScript at feature parity)
**Researched:** 2026-10-14
**Confidence:** MEDIUM-HIGH

## Executive Summary

EvaOS is a single-user operating surface over the Eva checkout: dashboard, chat with live omp sessions, inbox with approvals, jobs, habits, meetings, and a side panel with terminal, browser, files and side chats. Workbenches like this (Synara, T3 Code) share one shape. A thin main process owns everything with a handle: child processes, PTYs, watchers, native views and disk writes. It exposes a narrow typed IPC contract, and the renderer is a pure view over state streamed from main. Pure logic lives in Electron-free packages (`chat-core`, `eva-core`, `theme-core`, `widgets`), so the Rust unit tests port straight to Vitest.

**Recommendation:** rewrite every module in TypeScript, with no Rust sidecar in the initial plan.
- **Stack:** Electron 44.7.2, electron-vite 6, Vite 8, React 19, Mantine 9.7.2, zustand, Zod, virtua, node-pty + xterm.js, and Playwright `_electron`.
- **Chat:** the reducer runs in main next to the omp child. Main stamps each batch with a `seq` and flushes every ~16 ms. The renderer drains once per animation frame. Per `chat.rs`, `message_update` is a full-text snapshot that replaces the streaming text, so coalescing is safe.
- **Browser:** a `WebContentsView` is treated as a "hole" in the layout, positioned from a measured placeholder rect. One overlay-occlusion mechanism hides it, or swaps in a `capturePage()` bitmap, whenever a DOM overlay covers it.

**Main risks:**
- Core-value failures: chat framing and ordering bugs, and browser bounds, z-order or focus drift.
- Data safety: killing live omp sessions, or writing to the Eva checkout beyond the sanctioned writes.
- Vacuous proof: `page.screenshot()` excludes native views, so a green run can show an empty browser rectangle.
- Scope sprawl across ~68k lines of Rust, 30 widgets and a 139-key theme.

Mitigations are structural. Phase 1 builds the line framer, `seq` protocol, stdin-close-only supervisor, `EvaFs` write gateway, fake omp, fixture Eva root and a native-view-aware `proofShot`. Port by README feature slice, never by Rust file.

## Reconciliations the Roadmap Must Carry

**1. README features PROJECT.md missed (add to requirements):**
- **Main tabs:** `⌘T` new, `⌘W` close without stopping the chat, `⌘[` and `⌘]` per-tab history, pin and dedupe, `⌘`-click opens a new tab, persisted in `layout.json`. Size L. Global search `⌘`-Enter depends on it.
- **`diagram` fenced blocks:** render in a sandboxed iframe or offscreen WebContents. Size M, P3.
- **Notifications settings section:** the third Settings section (Calm / Normal / On call, phone, quiet hours, auto-settle, digest times, per-source ceilings).
- **Eregon server on :8860:** `.omp/eregon/server.ts` (`/turn?chat=<id>`) is Eva-side, so reuse it as-is. Electron needs the client, supervision, `afplay` and a mic path.
- **Also missed:** the prompt surface tag `<surface><machine> - EvaOS</surface>`, the pre-send second-writer prompt, the quit guard for unsaved Files edits, the Claude Code harness as a transport.
- **Not parity:** Calendar, Tasks, Memory, Files and Help Center pages are `Empty` states only. Relay-only widgets (`video`, `model`, `pr`) are not parity.

**2. Chat transport is a decision for the chat spike.**
- `omp --mode rpc-ui --resume <file>` over stdio covers resuming past chats. It is the spike path.
- New chats in the Rust app go through herdr and then Relay's WebSocket, not stdio.
- **Recommendation:** the spike proves resume over stdio only. Put chat I/O behind one `Transport`/`Launcher` interface: omp stdio, Claude Code bridge, Relay-subscribed session, Eregon HTTP. Write an ADR in the chat plan choosing between (a) herdr + Relay for new chats and (b) direct `omp --mode rpc-ui` children, as the Claude Code harness already does. Default to (b) unless parity with Relay visibility proves it needs (a). Option (a) depends on the late Relay client.
- `omp://rpc.md` was not on disk. The frame list comes from `chat.rs`, so the first chat plan must verify it.

**3. Config-dir and Relay-identity policy.**
- Use a separate config dir by default, for example `~/Library/Application Support/EvaOS-Electron`, with `$EVAOS_CONFIG_DIR` as the override. Do not share `inbox.jsonl`, `layout.json` or `chat.json` with the Rust app until cutover. A read-only import of the Rust app's state is fine.
- Use a distinct Relay device id, `evaos-electron`, not `evaos`. Relay's `ESCALATOR_DEVICE_ID` is `'evaos'`, so check dedup behavior in the Relay plan.
- Relay pairing writes `~/.config/relay/devices.json`, which PROJECT.md forbids. Until Isaac decides, ship notification and phone-escalation sinks in dry-run (log only) and Relay in listen-only mode. Live pairing is gated by `EVAOS_PORT_LIVE=1` and recorded as an explicit decision.
- Dev and test default to a fixture Eva root and tmp config/userData. A live root needs explicit opt-in. A `git status` sentinel runs on the Eva checkout, `apps/evaos` and `work/relay` around every e2e run.

**4. Other reconciled choices.**

| Topic | Decision |
|---|---|
| Virtualization (STACK: virtua, ARCH: tanstack, PITFALLS: Virtuoso) | Spike virtua first on a 5k-message fixture. Fall back to @tanstack/react-virtual only if it fails. |
| Streaming semantics (PITFALLS: concatenate, ARCH: snapshot) | Follow `chat.rs`. `message_update` replaces text and `message_end` is authoritative. Coalesce by keeping the last update per `messageId`. No delta op unless profiling demands it. |
| Window composition | `BaseWindow` + shell WebContentsView. Test Playwright `firstWindow()` on day one. Fall back to `BrowserWindow` with child views. |
| Occlusion | One `OverlayStack` / `useOccludeBrowser()` hook for all Mantine overlays, search, gate and Eregon. Hide for full-rect overlays, shrink the rect for Eregon, bitmap swap as polish. |
| DevTools / CDP | Detached by default. Verify `debugger.attach` coexistence in the spike. Wrap CDP in a lazily re-attaching `PageControl`. |
| Proof capture | `proofShot` composites `page.screenshot()` with `view.webContents.capturePage()`. It adds a blank-image pixel-variance check and asserts `view.getBounds()` equals the slot rect plus a CDP text probe. It exists from Phase 1. |
| Zod | Stack uses Zod 4.6.7; Relay pins zod ^3.25. Vendor Relay schemas into `packages/widgets` with a pinned commit and drift test. Verify v3/v4 compatibility. |
| SQLite | `node:sqlite` on a copied DB. Arc history seed is P3 and may be dropped. |
| Watching | Poll session files (500 ms) and `work/*` (2 s). FSEvents misses writes to open files. |
| Arc cookie import, Bitwarden, chat-order experiments | Do not build. Flag the cookie import for Isaac. |

## Key Findings

### Recommended Stack
Pin exact versions for the platform layer. All Mantine packages share one exact version. Use electron-vite for the build and electron-builder (`dir` target, `identity: null`) for local packaging. If a sidecar is ever needed, spawn a binary over stdio JSON lines and never use napi-rs.

**Core technologies:**
- **Electron 44.7.2 (Chromium 152, Node 24.21):** latest stable, with built-in `node:sqlite`.
- **electron-vite 6.0.0 + Vite 8.3.4 + plugin-react 6.1.2:** one config for main, preload and renderer. electron-vite 6 is brand new, so keep 5.x as the fallback.
- **TypeScript ~6.0.3 (not 7):** typescript-eslint peers `<6.1.0`, and Relay uses 6.0.3. Use pnpm 12 via corepack with `onlyBuiltDependencies: [electron, node-pty]`.
- **React 19.3.1 + Mantine 9.7.2 + recharts 3.10.1:** UI. The 139 theme keys are app-owned CSS variables applied imperatively under a static Mantine theme.
- **zustand 5 + Zod 4:** stores and validation at every IPC, RPC and widget boundary. IPC is a hand-rolled typed contract, not electron-trpc.
- **virtua 0.53.5, react-markdown 10, a custom block-memoized streaming renderer with `remend`, shiki 4 on closed fences only, mermaid 12 (dynamic import, strict, cached by source hash), dompurify:** chat rendering.
- **node-pty 1.1.0 + @xterm/xterm 6:** terminal. It ships darwin-arm64 prebuilds. Use `asarUnpack` and check that `spawn-helper` is executable.
- **Playwright 1.64 `_electron` + Vitest 5 `projects`:** testing. Run the built app with workers 1 and fake omp via `EVAOS_OMP_BIN`. Do not test virtualized scroll in jsdom.
- **Parsing and files:** `yaml` plus a hand-rolled frontmatter splitter (not gray-matter), plain line parsers for todos and journal, CodeMirror 6 for Files, and `@dnd-kit` 6.

### Expected Features
**Must have (table stakes):**
- Shell, layout, main tabs and the full hotkey set with terminal focus isolation.
- Dashboard, New Todo (contiguous ids from both todos files), workspace page, jobs, habits with gate overlay, meetings.
- Chat: session list, transcript from file, live streaming, virtualized pinned log, composer, model picker, access modes, context ring, question cards, images, subagent chips, writer registry, categories, Claude Code harness.
- Rich replies: markdown, mermaid, `diagram` and 30 `ui` widgets, using showcase.md as the golden fixture.
- Side panel: Terminal, Browser, Files, Side chats and the iOS Simulator (last), plus Eregon, `⌘K` search, Inbox with Relay client, digests, notification prefs, phone escalation and the theme editor.

**Should have (differentiators):**
- Real Chromium browser panel with DevTools and CDP.
- Measurable smooth streaming: gapless `seq` and frame-time p95. Use absolute budgets if no Rust baseline is repeatable.
- Playwright proof harness and a Relay-schema-based widget renderer.

**Defer:**
- `chat-order` and `chat-sections` experiments, `video`/`model`/`pr` widgets, Bitwarden, Arc cookie import and history seed.
- Semantic search tier (P3).
- A read-only git diff view in Files.

### Architecture Approach
Main-authoritative session state with a renderer mirror. The renderer asserts `seq` contiguity and resyncs from a snapshot on a gap, so it survives reloads. `BrowserHost` owns views, bounds and CDP. `PtyManager` owns PTYs and process groups. `EvaStore`, `ConfigStore` and `InboxStore` sit behind one `EvaFs` gateway with a closed set of sanctioned writers. Heavy work (search, digest) goes in a `utilityProcess` behind a swappable worker interface. Panels are registered tools.

**Major components:**
1. **`packages/contract`:** IPC channels and Zod schemas.
2. **`packages/chat-core`:** `LineFramer`, reducer, session-file parser, `tagged()`.
3. **`SessionManager` / `Transport`:** spawn, resume, write, abort. It reaps by stdin close and has no SIGKILL path.
4. **`BrowserHost` + renderer `OverlayStack`:** slot rect to `setBounds`, visibility, tab lifecycle, sandboxed guest partition with no preload.
5. **`EvaFs` / `eva-core`:** the only writer to the Eva checkout, with golden-file tests per operation.
6. **`PtyManager`, `SearchIndex`, `InboxStore`, `ConfigStore`, `theme-core` + `ThemeApplier`, `widgets`.**

### Critical Pitfalls
1. **Chunk-as-message parsing.** Use one `LineFramer` (StringDecoder, carry-over, per-line try/catch, stderr separate). Test with 1-byte, glued and split-emoji chunks.
2. **No ordering guarantee or render storms.** Use main-assigned `seq`, 16 ms batching, one rAF drain, an external store and memoized rows. Treat `message_end` as authoritative.
3. **Killing or double-writing live omp sessions.** Close stdin and wait, with no SIGKILL for sessions. Add a single-writer guard and use fake omp in every test and proof.
4. **WebContentsView z-order, bounds drift and focus leaks.** Sync the slot rect every frame during drags. Use one occlusion mechanism, forward app hotkeys from guests via `before-input-event`, and keep a sandboxed guest partition with a deny-all popup and permission policy.
5. **Vacuous proof and stray Eva writes.** Pair every screenshot with assertions and a blank-image check. Route all writes through `EvaFs` with a `git status` sentinel. Close phases only on a green gate: install, typecheck, lint, test, build, e2e launch with no console errors.
6. **Native modules under pnpm.** Set `onlyBuiltDependencies`, `asarUnpack` for node-pty, and add a packaged smoke test that spawns a PTY.
7. **Theme architecture.** Make the 139 keys CSS variables applied imperatively. Rebuilding `MantineProvider theme` per picker drag re-renders the whole tree. Decide this in the shell phase.

## Implications for Roadmap

The researchers' orders differed: ARCHITECTURE had 10 phases and PITFALLS had P0 to P8. This reconciled order uses five phases and keeps the spike first. The scope is large, so phases 2 to 5 are fat. The roadmapper should keep 5 as the count, let phases carry several plans, and split Phase 5 if it exceeds 3 plans. Every phase ends with a running built app, a green gate and `proof/` screenshots backed by assertions.

### Phase 1: Foundation, Harness and the Two Spikes
**Rationale:** Everything needs the toolchain, typed contract and proof harness. The two core-value risks are independent once the harness exists and must be proven before breadth. The spike gate validates virtua, WebContentsView and electron-vite 6.
**Delivers:**
- **Scaffold and harness:** workspace, electron-vite shell, preload, typed `contract`, Vitest projects, Playwright against the built app, fake omp, fixture Eva root, `EvaFs` guard with sentinel, `proofShot` with native-view capture, em-dash lint, green-gate script.
- **Chat spike:** `chat-core` (framer, reducer, Rust tests ported), `SessionManager` (resume over stdio, abort, steer, prompt-echo reconciliation), `seq` batching, virtualized log with pin and Jump to latest / New reply pills, composer, benchmark fixture.
- **Browser spike:** `BrowserHost` with slot sync, occlusion hook, subtabs, address-bar resolution (URL, search, bare port), title following, DevTools, CDP `PageControl`, copy link, open externally.
- **Proof:** gapless `seq` and frame-time numbers; bounds assertions, modal-hides-view, CDP text probe.

**Avoids:** pitfalls 1, 2, 3, 4, 6, 7, 8, 9, 10 (guard), 11 (toolchain), 13, 14, 18. Records ADRs for the transport and the config-dir policy.

### Phase 2: Shell, Theme Tokens and Eva Data Pages
**Rationale:** The browser slot and panel widths depend on the shell. The theme variable architecture, hotkey router and overlay model must exist before pages. The data pages are low-risk TS parsing and parallelize well. The missed README features (main tabs) enter here.
**Delivers:**
- **Shell:** three-column shell with fold rules and draggable edges, `layout.json`, sidebar with sliding sub-pages, account menu and Light/Dark/System.
- **Interaction layer:** hotkey router with terminal isolation, `OverlayStack`, main tabs, `ThemeApplier` with CSS variables, bundled fonts, entrance animation with an E2E-disable flag.
- **Pages:** Dashboard, New Todo, workspace page, jobs (atomic writes), habits with gate overlay, meetings with Accept, Settings Chat section.

**Avoids:** pitfalls 10 (todo and job races), 17, 20, 23, 25, 26, 27.

### Phase 3: Chat Parity and Rich Replies
**Rationale:** Side chats and Eregon reuse full chat, so the catalog, composer and question flow come first. Widgets share the code-block and theme work and depend on the chat view and the vendored Relay schema.
**Delivers:**
- **Session catalog and list:** groups, categories with drag and drop, pins, archive, rename, delete, 500 ms polling, writer registry.
- **Safety:** pre-send safety prompt, access-mode restart by stdin-close.
- **Composer and dialogs:** model picker, access, context ring, thinking and tool switches, image paste and drop, question cards, subagent chips, background jobs, surface tag.
- **Transport:** Claude Code harness through `Transport`, plus the transport ADR implemented.
- **Rich replies:** segmenter, block-memoized streaming markdown, shiki, mermaid, `diagram`, all 30 widgets with one fixture per showcase block, widget actions as replies, image viewer.

**Avoids:** pitfalls 3, 4, 5, 15, 16, 19, 29.

### Phase 4: Side Panel Tools, Eregon and Global Search
**Rationale:** These share the panel host, writer registry and overlay model. The terminal is a risky native-module integration and gets its own plan with a packaged smoke test. Side chats and Eregon reuse Phase 3 chat.
**Delivers:**
- Panel chrome and launcher.
- Terminal: node-pty, xterm, split panes, HUP then KILL of owned groups, flow control, themed ANSI.
- Files: secure IO, conflict-checked save, quit guard.
- Side chats and the iOS Simulator (last).
- Eregon: footer tabs, floating window, :8860 client, Esc ladder.
- `⌘K` instant search in a utilityProcess, with `⌘`-Enter to a new tab.

**Avoids:** pitfalls 10 (Files save), 11, 12, 20, 29.

### Phase 5: Relay, Inbox, Notifications, Theme Editor and Polish
**Rationale:** The Relay client is the hub for inbox producers and escalation, so it follows solid chat. The inbox is a pure TS state machine to build against Rust fixtures. The theme editor goes last because it re-skins everything. Phone escalation stays dry-run unless Isaac decides otherwise.
**Delivers:**
- **Relay and inbox:** Relay client (vendored protocol, `evaos-electron` device id), inbox store and `inbox.jsonl`, producers, repo sources, GitHub and Linear pollers, work-item folding, bell, inbox page and snooze.
- **Notifications:** digests, the Notifications settings section, phone escalation (dry-run default).
- **Theme and polish:** theme editor (139 keys, typography, syntax tokens, undo/redo, export), semantic search if time allows, hotkey audit against the README, README-to-requirement-to-test traceability pass.

**Avoids:** pitfalls 10 (torn lines, compaction), 17, 20, 21, 28, 29.

### Phase Ordering Rationale
- Contract, `chat-core`, `EvaFs` and the proof helper are the shared bottom layer, so they come first.
- The spikes carry the core-value risk and gate the rest.
- The layout shell precedes pages because the slot, panel widths and overlay model depend on it. The theme variable architecture must be set there, since retrofitting it later is a rewrite.
- Leaves that depend on chat and data go late. Widgets sit with chat because they share rendering and fixtures.
- Only Phase 1 carries more than one new risky integration, and that is the explicit spike exception.

### Research Flags
**Needs `/gsd:plan-phase --research-phase`:**
- **Phase 1:** electron-vite 6 and Rolldown stability, Playwright visibility of `BaseWindow` and WebContentsView, native-view capture, `debugger.attach` and DevTools coexistence, virtua pinning at 10k messages, `omp://rpc.md` frame verification.
- **Phase 3:** new-chat transport decision, subagent chip data source, streaming markdown choice, widget-schema port (zod 3 vs 4).
- **Phase 4:** node-pty packaging (`asarUnpack`, `spawn-helper`), secure Files IO (no `openat` in Node), Eregon server contract.
- **Phase 5:** Relay `index.ts` frames (879 lines, unread), pairing decision, kit theme schema (139 keys, 41 syntax tokens), inbox folding against Rust fixtures.

**Standard patterns, skip research:** Phase 2. File parsing, atomic writes, CSS-variable theming, hotkey routing and polling are well understood. Port rules and tests from the Rust modules and the README.

## Confidence Assessment

| Area | Confidence | Notes |
|---|---|---|
| Stack | HIGH | Versions read from the npm registry and Electron feed on 2026-10-14. MEDIUM for brand-new electron-vite 6 and virtua chat ergonomics, which the spike must prove. |
| Features | HIGH | README, showcase.md and the Relay widget schema were read in full. MEDIUM for the omp frame list (from `chat.rs`, not `rpc.md`) and for competitor comparisons. |
| Architecture | MEDIUM-HIGH | Electron APIs verified against official docs. The reference apps were not inspected. DevTools/CDP coexistence and Playwright with `BaseWindow` are unverified. |
| Pitfalls | MEDIUM | README-derived lifecycle rules are HIGH. The Electron, node-pty, pnpm and Playwright claims were not re-fetched. |

**Overall confidence:** MEDIUM-HIGH

### Gaps to Address
- **omp RPC frames:** verify `rpc.md`, `rpc-ui` vs `rpc`, `set_session_name` and the subagent-chip source in the first chat plan.
- **Relay frames, device id and pairing:** enumerate in the Phase 5 plan. Default to dry-run until Isaac decides on the global-config write.
- **"Beats current" baseline:** no repeatable Rust measurement exists. State absolute budgets.
- **Zod 3 vs 4:** check vendored schema compatibility before the widgets plan.
- **`evaos-ctl` / `control.sock` callers in `.omp`:** check before deciding to rebuild a control channel.
- **Kit theme schema:** read `assets/themes/kit/*` when planning the editor. Carry the Apache-2.0 LICENSE.
- **`rich/widgets.rs` layout details:** unread. Use a Rust showcase snapshot as the visual baseline.
- **Arc cookie import and Bitwarden:** the anti-feature call is a recommendation, so flag it for Isaac.
- **Unattended macOS risks:** Screen Recording permission, Keychain prompts and native dialogs. Prefer `capturePage`, `showInactive()` and stubbed dialogs.

## Sources
- **Primary (HIGH):** `/Users/ike/Eva/apps/evaos/README.md`, `examples/showcase.md` and `src/chat.rs`; `/Users/ike/Eva/work/relay/packages/protocol/src/widget.ts` and `package.json`; npm registry and the Electron release feed (2026-10-14); Electron docs (View, WebContentsView, debugger); Node SQLite docs; Playwright Electron API; the electron-vite changelog; `.planning/PROJECT.md`.
- **Secondary (MEDIUM):** Electron BaseWindow and UtilityProcess docs via search summaries; the Forge Vite plugin status; a local inspection of the node-pty 1.1.0 tarball; training-knowledge claims on pnpm build gating, xterm flow control and Playwright.
- **Tertiary (LOW):** T3 Code and Synara landing pages; virtua ergonomics; DevTools and CDP coexistence; Playwright visibility of WebContentsView; remend and Streamdown internals; Arc DB locking.

---
*Research completed: 2026-10-14*
*Ready for roadmap: yes*
