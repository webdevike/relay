# Phase 2: Shell, Navigation and Theme Tokens - Context

**Gathered:** 2026-10-15
**Status:** Ready for planning
**Mode:** auto (Isaac unavailable; every grey area resolved with the recommended option, logged in 02-DISCUSSION-LOG.md)

<domain>
## Phase Boundary

Replace the Phase 1 spike frame with the real EvaOS shell: `[sidebar][main card][right panel card]` over a footer strip, with the README's fit rules (panel shrinks first, then the sidebar, then the sidebar folds below the three-column floor), draggable edges with double-click reset, widths and main tabs persisted in `layout.json`, the sidebar's nav pages, Recent journal titles, Tasks and Jobs counts, account menu and Light / Dark / System, sliding sub-pages for Chats, Settings and Meetings, main tabs with per-tab history, one hotkey router covering every README chord, contained scroll areas with per-page memory, the 139-key CSS-variable theme architecture with live Light / Dark / System switching, the entrance animation, and the unsaved-edits quit guard. Requirements: SHEL-01..08, SETT-01, THEM-01, THEM-02.

Phase 1's chat pane and browser panel are kept as components: the chat pane becomes the Chat page's main content (placeholder catalog until Phase 4) and the browser panel becomes the right panel card's content (the panel launcher and the other tools are Phase 6). Every Phase 1 e2e spec must keep passing on the new frame.

Not in this phase: real page content (Dashboard, Workspaces, Jobs, Habits, Meetings: Phase 3), the chat list and composer parity (Phase 4), the theme editor (Phase 7, THEM-03..06), the side panel launcher, terminal, Files, Eregon and global search (Phase 6), inbox and notifications (Phase 7).

</domain>

<decisions>
## Implementation Decisions

### Shell geometry, cards and persistence
- **D-01:** Fit rules are a verbatim port of `src/layout.rs::fit` into a new Electron-free `packages/shell-core` (`fit(window, sidebar?, panel?)` with GAP 8, TRAFFIC_LIGHTS 80, MAIN_MIN 480, SIDEBAR_MIN 200, SIDEBAR_MAX 420, SIDEBAR_DEFAULT 272, PANEL_MIN 320, PANEL_DEFAULT 420, no panel maximum). The Rust unit tests (wide windows, panel gives way first, sidebar folds below the floor, compact 760 and 800 px reflow) are ported to Vitest. Phase 1's panel default of 480 and max of 960 are replaced by the Rust values; the browser panel keeps working at any width the fit yields.
- **D-02:** `layout.json` lives in the app's own config dir (ConfigStore, temp file then rename) with the Rust keys: `sidebar_width`, `panel_width` (rounded numbers) and `tabs` (`{ "active": n, "list": [ { ...place, "pinned": bool } ] }`). Unknown keys are preserved on write. Widths are written on pointer-up after a drag and on double-click reset, never per frame. A missing or malformed file yields the defaults; values are clamped on read like `layout::load`. Reading the Rust app's `layout.json` from its config folder is allowed as a read-only import only if trivial; never write there.
- **D-03:** Frame look per README: the sidebar sits on the chrome background; main and the panel are inset bordered cards with 8 px gaps and the theme radius; a footer strip runs under all three (Help on the left, an empty slot on the right reserved for Eregon's tabs in Phase 6). When the sidebar is hidden, main's tab strip starts 80 px in for the traffic lights. The window drag region is the sidebar header row and the empty part of main's tab strip; every interactive child is `no-drag`.
- **D-04:** `⌘B` and the sidebar button at the left of main's top bar set the sidebar's preferred visibility (in memory, not persisted, matching Rust). The folded state is derived from `fit` and never changes the preference or the saved width; the sidebar returns when the window widens, the panel closes or full view frees space. While auto-folded, the sidebar button's tooltip explains it ("Sidebar hidden to fit the window. Widen the window or close the panel to bring it back.").
- **D-05:** Both side columns drag by their inner edge through one `Grip` component (8 px hit area, 2 by 36 px bar visible on hover and while dragging, `col-resize` cursor, double-click resets to the default). The browser view is occluded while dragging (Phase 1 `useOccludeBrowser`). Drags clamp through `fit` so the panel can never push main below the compact floor.
- **D-06:** SHEL-06: one `ScrollArea` wrapper in `renderer/ui` (Mantine `ScrollArea` with `scrollbarSize` 8, themed thumb, top and bottom continuation fades driven by scroll position, `overscroll-behavior: contain`). Per-place scroll memory: a `scrollMemory` store keyed by the tab's place key restores `scrollTop` when a page or workspace is shown again. Chat logs keep their own virtua scrolling and are excluded.

### Navigation model
- **D-07:** Tabs are a port of `src/tabs.rs` into `shell-core`: a tab is a place plus a 50-entry history with a cursor plus `pinned`; a place is one of `page`, `workspace(id)`, `board(slug)`, `chat(sessionFile | new)`, `settings(section)`, `meeting(stem)`. A place is open in at most one tab: opening it in a new tab or navigating to it switches to the tab already showing it (new chats never match). Pinned tabs sit at the left as an icon with the title in a tooltip, have no close button, are skipped by `⌘W` and Close others, and stay put: navigating from a pinned tab opens the new place in another tab. Closing the last tab leaves a Dashboard tab. Phase 2 registers page and settings places (plus a chat placeholder that opens the Phase 1 chat pane); Phase 3 and 4 add workspace, meeting and real chat places without changing the model. The saved JSON mirrors the Rust shape (`place_from` tolerates missing fields) so the two apps' files are interchangeable.
- **D-08:** The sidebar is a sliding stack: the main nav and the Chats, Settings and Meetings sub-pages translate horizontally over 220 ms (Rust `SIDEBAR_TOGGLE`), with Back in the header and Esc returning to the main nav while leaving the page open in main. Chats and Meetings ship their header (Back, title, new-chat button on Chats, search box that `⌘F` focuses) over an empty list body with a placeholder line ("Chats arrive in a later update" style copy, no em dashes); Phase 3 and 4 fill the bodies. Settings lists Theme, Chat and Notifications; picking one shows it in main (SETT-01). Chat holds the thinking and tool-details switches persisted to `settings.json` in the config dir so Phase 4 can read them; Theme and Notifications show a titled placeholder until Phase 7.
- **D-09:** Main nav order and labels follow `sidebar.rs`: brand and search on top; Dashboard, Inbox, Chat, Jobs, Habits, Meetings, Calendar, Tasks, Memory, Files in the middle with Recent below (the middle scrolls); Setting, Help Center, the account menu (Settings, Quit) and the Light / Dark / System segmented control at the bottom. Tasks shows the open-todo count and Jobs shows how many jobs are enabled and scheduled, read by two small `eva-core` readers (`countOpenTodos` over `memory/todos.md`, `countScheduledJobs` over `jobs/*/job.md` frontmatter) exposed through one `eva.sidebar` IPC call and refreshed on window focus and `⌘R`. Recent lists journal entry titles parsed from `memory/journal.md` `## YYYY-MM-DD` headings (newest first, capped) and `⌘F` focuses the filter box. Pages without content yet render a titled placeholder in main.
- **D-10:** Main's tab strip sits at the top of the main card (Linear style): the sidebar toggle at the far left, tabs (title, close `x` on hover and on the active tab), a `+` button, and the panel toggle at the far right. Right-click a tab for Pin / Unpin, Close tab, Close others through the overlay-aware menu wrapper. `⌘`-click on sidebar items and search results opens a new tab; plain clicks replace the active tab's place and push history. `⌘[` and `⌘]` move through the active tab's history.

### Hotkey router and overlays
- **D-11:** One `HotkeyRouter` in the renderer: a single capture-phase `keydown` listener on `window` that normalises the event to a chord string (`cmd+shift+b`, `escape`, `cmd+[`) and dispatches through scoped registries in priority order: overlay, terminal, page, global. Chord parsing and matching are pure functions in `shell-core` with Vitest coverage. The terminal scope (Phase 6) will claim everything except an explicit pass-through list (`cmd+shift+b`, `cmd+b`, `cmd+k`, `cmd+j`, `cmd+t`, `cmd+w`, `cmd+q`); Phase 2 ships the scope mechanism and proves it with a fake terminal scope in a unit test. Keys forwarded from guest browser views (Phase 1 `before-input-event`) enter the same router through an `app.hotkey` event. The Electron menu keeps only the edit roles and Quit; no app chord is a menu accelerator.
- **D-12:** Esc is one `dismiss` action that pops the topmost entry of an ordered dismisser stack (`useDismissable(priority, fn)`): open overlay or menu, then global search (Phase 6), then Eregon history and minimise (Phase 6), then the sidebar sub-page's Back. Nothing on the stack means Esc does nothing.
- **D-13:** Overlay wrappers `EvaModal`, `EvaMenu`, `EvaPopover` and `EvaDrawer` in `renderer/overlay` wrap the Mantine components and call `useOccludeBrowser()` while open (Phase 1 D-08). A Vitest check scans `apps/desktop/src/renderer` and fails on `Modal`, `Menu`, `Popover` or `Drawer` imported from `@mantine/core` outside `renderer/overlay`. The Phase 1 test overlay and Import Arc modal move onto the wrappers; the spike's "Test overlay" rail button is removed (its e2e proof moves to the account menu or a wrapper-based test overlay reachable through a test hook).
- **D-14:** Every README chord is registered now: `⌘N ⌘R ⌘B ⌘⇧B ⌘J ⌘K ⌘F ⌘T ⌘W ⌘[ ⌘] ⌘S ⌘1-9 ⌘⇧C` and Esc. Chords whose feature lands later (`⌘N`, `⌘J`, `⌘K`, `⌘S`, `⌘1-9`, `⌘⇧C`) dispatch to named stub actions; when `EVAOS_E2E=1` every dispatched action is appended to an e2e-only ring buffer on `window.__evaosHotkeys` so SHEL-05 is assertable before the features exist. `⌘⇧B` really opens and closes the right panel (the browser is its only tool in Phase 2), `⌘B` toggles the sidebar, `⌘R` refreshes sidebar counts and Recent, `⌘F` focuses the visible sidebar search box, `⌘T`, `⌘W`, `⌘[`, `⌘]` drive tabs. Phase 1's browser hotkeys (address bar focus, tab close inside the panel) register in the page scope so `⌘W` closes a browser subtab while the panel has focus, else the main tab, as the README describes.

### Theme, motion and quit
- **D-15:** `packages/theme-core` (Electron-free) holds: the list of the 139 kit color keys (copied from `theme_fields.rs` key names, excluding `group_box.title.foreground`), the bundled EvaOS light and dark theme files (copied verbatim from `apps/evaos/assets/themes/evaos.json`; kit presets and their Apache-2.0 license arrive with the editor in Phase 7), the `ThemeDoc` shape (`base`, `shared`, `light.edits`, `dark.edits`, `app`) mirroring `theme.rs`, and a pure `resolveTheme(doc, mode)` that layers edits over the bundled mode file. A renderer `ThemeApplier` writes every color as `--eva-c-<key with dots as dashes>` plus typography (`--eva-font-ui`, `--eva-font-code`, sizes), radius and shadow variables onto `document.documentElement` imperatively, and flips Mantine's `data-mantine-color-scheme` so Mantine's own components follow. Phase 1's semantic `--eva-bg`, `--eva-surface`, `--eva-text`, `--eva-accent` and friends become aliases of kit keys (`background`, `panel.background`, `foreground`, `primary.background`, ...) so existing components keep working untouched. `MantineProvider` receives a static theme (spacing, font sizes, radius) and is never rebuilt on theme change.
- **D-16:** Appearance (Light / Dark / System) is stored in `theme.json` in the config dir under `app.appearance` (Phase 7 reconciles the rest of the document with the Rust `ThemeDoc` when it ports the editor). System resolves from `matchMedia('(prefers-color-scheme: dark)')` in the renderer and re-applies on change; on every apply the renderer tells main the resolved background color (`app.setBackground`) so the `BaseWindow` background matches and resizes never flash. Switching recolors live without remounting: a unit test asserts React element identity survives a mode switch and an e2e test asserts the same DOM nodes with changed computed colors.
- **D-17:** The entrance animation is a CSS timeline: cue names and timings from `motion.rs` (`SIDEBAR`, `HERO`, `SECTIONS`, `FIRST_CARD`, `FIRST_CHART`, `SECOND_CARD`, `SECOND_CHART`, `GRID_CARDS`, `ASIDE_TITLE`, `ASIDE_ROWS`, `STATS_TITLE`, `STAT_CARDS`, total 3.95 s at SPEED 2, rise 10 px) become `--eva-cue-*-delay` and `--eva-cue-*-duration` variables and `.eva-cue-<name>` classes that fade and rise once. A module-level `playedThisLaunch` flag (not persisted) plays it once per launch on the first shell render; navigating shows pages settled. It is disabled (all durations 0) when `app.info` reports `e2e`, when `EVAOS_NO_MOTION=1`, or under `prefers-reduced-motion`; one e2e test launches with motion on and asserts the sidebar opacity rises from 0 to 1 within the budget. Phase 3 attaches the Dashboard cues to its cards.
- **D-18:** SHEL-08: a renderer `dirtyStore` (`registerDirty(id, { label, save })`) is the one registry for unsaved edits; Phase 6 Files registers its editors. Main intercepts the window `close` and `before-quit` (keeping the Phase 1 quit hooks) and asks the renderer through `app.unsavedEdits`; when any exist it shows a native `dialog.showMessageBox` with Save, Discard and Cancel (Save runs every registered `save`, Cancel aborts the close or quit). The e2e test marks a fake dirty entry through a test hook and stubs the dialog with `electronApp.evaluate`.

### Claude's Discretion
- Internal file layout inside `packages/shell-core`, `packages/theme-core` and `apps/desktop/src/renderer/shell`; zustand store shapes; the exact alias table from kit keys to the Phase 1 semantic tokens; icon choices per nav page (tabler equivalents of the Lucide names in `sidebar.rs`); how `data-testid` values from Phase 1 are kept or remapped as long as every Phase 1 e2e spec passes; whether the footer Help button opens a placeholder page or a tooltip in this phase.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Project and research
- `.planning/PROJECT.md` — scope, constraints, key decisions
- `.planning/REQUIREMENTS.md` — SHEL-01..08, SETT-01, THEM-01, THEM-02 are this phase's requirements
- `.planning/research/SUMMARY.md` — theme architecture note (CSS variables applied imperatively; never rebuild the Mantine theme per change), config-dir policy, "Standard patterns, skip research: Phase 2"
- `.planning/research/PITFALLS.md` — overlay and WebContentsView z-order, hotkey and focus pitfalls
- `.planning/phases/01-foundation-harness-and-the-two-spikes/01-CONTEXT.md` and `01-UI-SPEC.md` — D-06..D-08 (window composition, slot sync, overlay stack), the token mechanism and the Phase 2 extension points
- `CLAUDE.md` — unattended run rules, boundaries, proof rules

### Source of truth (read-only, never modify)
- `/Users/ike/Eva/apps/evaos/README.md` — Shell (line ~40), Scrolling (~50), Sidebar (~179), Settings (~777), Entrance animation (~909), Layout table (`src/tabs.rs`, `src/layout.rs` rows, ~969)
- `/Users/ike/Eva/apps/evaos/src/layout.rs` — `fit`, grips, `layout.json` read and write, unit tests to port
- `/Users/ike/Eva/apps/evaos/src/tabs.rs` — tab and place model, dedupe and pin rules, saved shape, unit tests to port
- `/Users/ike/Eva/apps/evaos/src/sidebar.rs` — nav order, icons, counts, sub-page drills
- `/Users/ike/Eva/apps/evaos/src/app.rs` (lines ~245-267) — the key bindings list
- `/Users/ike/Eva/apps/evaos/src/motion.rs` — cue timings
- `/Users/ike/Eva/apps/evaos/src/theme.rs`, `src/theme_fields.rs`, `assets/themes/evaos.json` — ThemeDoc shape, the 139 color keys, the bundled light and dark themes
- `/Users/ike/Eva/apps/evaos/src/scale.rs` — design scale (text steps, spacing, radius)
- `/Users/ike/Eva/apps/evaos/src/settings.rs` — Settings sections
- `/Users/ike/Eva/apps/evaos/src/native_quit.rs` and the Files unsaved-edit check — quit guard behavior

### Existing code to build on
- `apps/desktop/src/renderer/app/App.tsx`, `PanelDivider.tsx`, `Rail.tsx` — the spike frame being replaced
- `apps/desktop/src/renderer/overlay/overlay-store.ts` — `useOccludeBrowser()`
- `apps/desktop/src/renderer/styles/tokens.css`, `theme.ts` — Phase 1 tokens and static Mantine theme
- `apps/desktop/src/main/config-store.ts`, `window.ts`, `menu.ts`, `index.ts`, `test-hooks.ts`, `env.ts` — config writes, BaseWindow, menu, quit hooks, e2e hooks
- `packages/contract/src/*` — typed IPC contract to extend (`app.*`, `eva.*` channels)
- `apps/desktop/e2e/fixtures.ts`, `helpers/proofShot.ts`, `helpers/paths.ts` — e2e launch and proof capture (`proof/phase-2/`)

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `useOccludeBrowser()` and the `overlayStore` (Phase 1 D-08) are the occlusion mechanism every new overlay wrapper uses.
- `ConfigStore.readJson` / `writeJson` already does temp-file-then-rename into the config dir; `layout.json`, `theme.json` and `settings.json` go through it.
- `createMainWindow` already sets `minWidth` 760, `minHeight` 720, `titleBarStyle: 'hiddenInset'` and a dark `backgroundColor`; Phase 2 adds the background-follow call and the close interception.
- `installTestHooks` exposes `globalThis.__evaosTest` under `EVAOS_E2E=1`; the dirty-entry hook and dialog stubs hang off it.
- `packages/contract` with Zod schemas and the `handle()` helper validate every new channel; the preload exposes only `invoke` and `on`.
- `e2e/fixtures.ts` launches the built app with the fixture Eva root, fake omp, temp config dir; `proofShot` composites the browser view. `fixtures/eva-root` already has two workspaces, a journal and a todos file for the sidebar readers.
- `BrowserPanel`, `ChatPane` and their stores are kept as-is and re-parented into the new frame.

### Established Patterns
- Pure logic in Electron-free packages with Vitest (`chat-core`, `browser-core`, `eva-core`, `contract`); `shell-core` and `theme-core` follow the same layout (`package.json`, `tsconfig.json`, `vitest.config.mts`, `src/index.ts`).
- Components read only `var(--eva-*)` or Mantine variables; no hex or px in component files (01-UI-SPEC). Em-dash lint on UI strings.
- zustand vanilla stores outside React for high-frequency state; selectors keep re-renders narrow.
- Every plan ends in a commit; the phase closes only on a green `pnpm gate` (typecheck, lint, Vitest, build, e2e with zero console errors).
- Phase 1 e2e waits on `[data-testid=rail]`; keep that selector on the new sidebar or update the fixture in the same plan.

### Integration Points
- `App.tsx` is the root to replace: new `Shell` renders sidebar, main card (tab strip plus routed place content), panel card (browser), footer.
- `packages/contract/src/app.ts` grows `app.setBackground`, `app.unsavedEdits` (main to renderer request), `app.hotkey` event; a new `eva.ts` adds `eva.sidebar` (counts and Recent titles).
- `main/index.ts` quit hooks plus a window `close` handler host the quit guard; `main/menu.ts` stays accelerator-free for app chords.
- Later phases plug in: Phase 3 pages register places and Dashboard cues; Phase 4 registers chat places and reads `settings.json`; Phase 6 registers the terminal hotkey scope, Files dirty entries, Eregon and search dismissers, the panel launcher; Phase 7 writes `theme.json` edits through `theme-core`.

</code_context>

<specifics>
## Specific Ideas

- Feel references stay Synara and T3 Code (Electron); the tab strip is "after Linear" per the README, the sidebar and panel "after Synara".
- The README's compact cases are explicit test vectors: at 760 and 800 px the two cards remain side by side with main reflowing below 480 px and all panel controls inside the window; the three-column floor with a panel is 1016 px.
- Proof set for `proof/phase-2/`: light and dark at 1280 by 800, folded (760 by 720) and wide (1440 by 900), tabs with a pinned tab and a context menu, a sidebar sub-page, the Settings page, each paired with a state assertion.
- THEM-01 counts: a unit test asserts exactly 139 color keys are applied as CSS variables.

</specifics>

<deferred>
## Deferred Ideas

- Theme editor, kit presets, syntax tokens, undo and redo, export: Phase 7 (THEM-03..06).
- Side panel launcher, header tabs, full view, Terminal, Files, Side chats, iOS Simulator: Phase 6.
- Global search (`⌘K`) and Eregon (`⌘J`): Phase 6; their chords are stubs in this phase.
- Dashboard entrance cues on real cards and charts: Phase 3 attaches them.
- Bitmap placeholder while the browser view is occluded: polish after this phase (carried from Phase 1).
- Persisting sidebar visibility across launches: not done by the Rust app; revisit only if Isaac asks.

</deferred>

---

*Phase: 02-shell-navigation-and-theme-tokens*
*Context gathered: 2026-10-15*
