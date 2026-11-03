# Phase 2: Shell, Navigation and Theme Tokens - Research

**Researched:** 2026-10-15
**Domain:** Electron + React shell frame, tab/navigation model port, hotkey router, CSS-variable theming, quit guard
**Confidence:** HIGH (all decisions are locked in CONTEXT/UI-SPEC; research verified the Rust sources, the Phase 1 code and the environment)

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
D-01 Fit rules are a verbatim port of `src/layout.rs::fit` into a new Electron-free `packages/shell-core` (GAP 8, TRAFFIC_LIGHTS 80, MAIN_MIN 480, SIDEBAR_MIN 200, SIDEBAR_MAX 420, SIDEBAR_DEFAULT 272, PANEL_MIN 320, PANEL_DEFAULT 420, no panel maximum); Rust unit tests ported to Vitest; Phase 1 panel default 480 / max 960 replaced.
D-02 `layout.json` in the app's own config dir via ConfigStore (temp then rename), Rust keys `sidebar_width`, `panel_width`, `tabs` (`{active, list:[{...place, pinned}]}`); unknown keys preserved; widths written on pointer-up and on double-click reset only; missing/malformed gives defaults, clamp on read; never write to the Rust app's folder.
D-03 Frame per README: sidebar on chrome bg; main and panel are inset bordered cards with 8px gaps and theme radius; footer strip (Help left, empty Eregon slot right); sidebar hidden gives main's tab strip an 80px lead-in; drag region = sidebar header row + empty tab strip; interactive children `no-drag`.
D-04 `⌘B` and the sidebar button set preferred visibility (memory only). Folded state derived from `fit`, never changes preference or saved width. Folded tooltip text as specified.
D-05 One `Grip` component (8px hit, 2x36 bar, `col-resize`, dblclick resets); browser view occluded while dragging; drags clamp through `fit`.
D-06 One `ScrollArea` wrapper (Mantine, scrollbarSize 8, themed thumb, fades, `overscroll-behavior: contain`); `scrollMemory` store keyed by place key; chat logs excluded.
D-07 Tabs are a port of `src/tabs.rs` into shell-core: place + 50-entry history + `pinned`; place kinds `page`, `workspace(id)`, `board(slug)`, `chat(sessionFile|new)`, `settings(section)`, `meeting(stem)`; one tab per place (new chats never match); pinned tabs left, icon only, no close, skipped by `⌘W` and Close others, navigating from pinned opens another tab; closing last tab leaves Dashboard; saved JSON mirrors Rust shape and `place_from` tolerates missing fields.
D-08 Sidebar is a sliding stack (220ms) with Chats/Settings/Meetings sub-pages, Back + Esc; Chats/Meetings ship header over empty list with placeholder; Settings lists Theme, Chat, Notifications; Chat holds thinking/tool-details switches persisted to `settings.json`.
D-09 Main nav order/labels per `sidebar.rs`; Tasks and Jobs counts from `countOpenTodos` and `countScheduledJobs` in `eva-core` exposed via one `eva.sidebar` IPC call, refreshed on focus and `⌘R`; Recent = journal `## YYYY-MM-DD` titles, newest first, capped; `⌘F` focuses filter; pages without content render titled placeholder.
D-10 Tab strip at top of main card (toggle, tabs, `+`, panel toggle); right-click Pin/Unpin, Close tab, Close others; `⌘`-click opens new tab; plain click replaces active tab's place and pushes history; `⌘[` `⌘]` history.
D-11 One `HotkeyRouter`: single capture-phase window keydown, chord strings, scoped registries overlay > terminal > page > global; pure chord parse/match in shell-core; terminal scope mechanism proven with a fake scope in a unit test with a pass-through list (`cmd+shift+b, cmd+b, cmd+k, cmd+j, cmd+t, cmd+w, cmd+q`); guest-view keys enter via an `app.hotkey` event; Electron menu keeps only edit roles and Quit.
D-12 Esc is one `dismiss` action popping an ordered dismisser stack (`useDismissable(priority, fn)`).
D-13 `EvaModal/EvaMenu/EvaPopover/EvaDrawer` in `renderer/overlay` call `useOccludeBrowser()`; a Vitest scan fails on `Modal|Menu|Popover|Drawer` imported from `@mantine/core` outside `renderer/overlay`; Phase 1 test overlay and Import Arc move onto wrappers; the spike "Test overlay" rail button is removed.
D-14 Every README chord registered now (`⌘N ⌘R ⌘B ⌘⇧B ⌘J ⌘K ⌘F ⌘T ⌘W ⌘[ ⌘] ⌘S ⌘1-9 ⌘⇧C`, Esc); later-phase chords dispatch to named stubs; under `EVAOS_E2E=1` every action is appended to `window.__evaosHotkeys`; Phase 1 browser hotkeys register in page scope.
D-15 `packages/theme-core`: 139 kit color keys (excluding `group_box.title.foreground`), bundled EvaOS light/dark verbatim from `apps/evaos/assets/themes/evaos.json`, `ThemeDoc` shape, pure `resolveTheme(doc, mode)`; renderer `ThemeApplier` writes `--eva-c-<key dots to dashes>` plus typography/radius/shadow imperatively and flips Mantine's `data-mantine-color-scheme`; Phase 1 semantic tokens become aliases; `MantineProvider` gets a static theme, never rebuilt.
D-16 Appearance stored in `theme.json` `app.appearance`; System via `matchMedia`; each apply sends `app.setBackground`; no remount on switch (unit test element identity, e2e DOM node identity).
D-17 Entrance animation as a CSS timeline from `motion.rs` cues, `playedThisLaunch` flag, disabled under e2e / `EVAOS_NO_MOTION=1` / reduced motion; one e2e test with motion on.
D-18 `dirtyStore` registry; main intercepts window `close` and `before-quit`, asks renderer via `app.unsavedEdits`, native `dialog.showMessageBox` Save/Discard/Cancel; e2e stubs the dialog.

### Claude's Discretion
Internal file layout in `packages/shell-core`, `packages/theme-core`, `apps/desktop/src/renderer/shell`; zustand store shapes; exact alias table; icon choices per nav page; how Phase 1 `data-testid` values are kept or remapped as long as every Phase 1 e2e spec passes; whether the footer Help button opens a placeholder page or a tooltip.

### Deferred Ideas (OUT OF SCOPE)
Theme editor, kit presets, syntax tokens, undo/redo, export (Phase 7); side panel launcher, terminal, Files, Side chats, iOS Simulator (Phase 6); global search and Eregon (Phase 6; chords are stubs); Dashboard entrance cues on real cards (Phase 3); bitmap placeholder while browser view occluded; persisting sidebar visibility.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| SHEL-01 | three-column frame, footer, fit rules, 760x720 min | `fit` port (verbatim Rust, below), layout store, frame CSS |
| SHEL-02 | drag edges, dblclick reset, persist `layout.json` | `Grip`, `layout-store`, ConfigStore read-merge-write |
| SHEL-03 | sidebar nav, Recent, counts, account menu, appearance, sub-pages | `eva.sidebar` readers, sliding track, journal parser |
| SHEL-04 | tabs, per-tab history, pin, persistence | `tabs.ts` port; real `layout.json` shape documented below |
| SHEL-05 | every hotkey via one router yielding to terminal | `HotkeyRouter`, scopes, pass-through list, e2e ring buffer |
| SHEL-06 | contained scroll areas, fades, per-page scroll memory | `ui/ScrollArea`, `scrollMemory` |
| SHEL-07 | entrance animation once per launch, disable-able | CSS cue vars, `data-eva-motion` switch |
| SHEL-08 | quit guard for unsaved edits | `dirtyStore`, main-to-renderer request/reply, `dialog.showMessageBox` |
| SETT-01 | Settings lists Chat/Theme/Notifications | `settings(section)` place, `settings.json` |
| THEM-01 | 139 keys as CSS variables, imperative | `theme-core`, `ThemeApplier`, generated kit base |
| THEM-02 | light/dark versions; Light/Dark/System | `resolveTheme`, `matchMedia`, Mantine `setColorScheme` |
</phase_requirements>

## Summary

This phase needs no new runtime packages. Every library (Mantine 9.7.2, `@tabler/icons-react` 3.49, zustand 5, zod 4, `electron-vite`, Playwright) is already installed from Phase 1. The work is two new Electron-free packages (`shell-core`, `theme-core`, laid out like `packages/browser-core`: `package.json` with `exports {".":"./src/index.ts","./*":"./src/*.ts"}`, `tsconfig.json`, `vitest.config.mts`; the root `vitest.config.mts` globs `packages/*/vitest.config.mts` so they are picked up automatically), a replacement renderer shell, a handful of contract channels and a main-process quit guard. Research was therefore mostly verification of the Rust ports and of seams in Phase 1 code that will bite.

Four findings change the plan versus the CONTEXT text. (1) The real `layout.json` tab shape uses `back`/`forward` stacks, not a "history with cursor"; port the Rust shape exactly. (2) The kit base (96 non-EvaOS keys) cannot be taken from `default-theme.json` alone: Default Light has 99 keys and Default Dark 94, of which 47/53 of the 139 required keys are missing, so the generator script must port the fallback formulas in gpui-component's `schema.rs::apply_config` (lines 682-1064). (3) Phase 1's browser panel testids collide with the new main-tab testids (`tab-new`, `tab-close-<id>`, `tab-<id>`); rename the Phase 1 ones in the same plan. (4) The existing `before-quit` hook calls `preventDefault` then `app.exit(0)`, so the quit guard must run before it and a re-entrancy flag is required.

**Primary recommendation:** Build in this order: shell-core (fit, tabs, chords) with ported Rust tests; theme-core with the generated kit base and the 139-key test; ThemeApplier + aliases + bootstrap script; frame/layout store/grips with Phase 1 components re-parented and testids renamed; sidebar + tabs UI; router + overlay wrappers; quit guard; proof specs. Keep the Phase 1 e2e suite running after every plan.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| fit / widths math | shell-core (pure) | Renderer layout store | Pure function, unit tested; renderer feeds `window.innerWidth` |
| layout.json persistence | Main (ConfigStore) | Renderer via IPC | Only main writes files; renderer sends widths on pointer-up |
| Tab model and history | shell-core (pure) | Renderer zustand store | Pure reducer, persisted through IPC |
| Hotkey routing | Renderer (window capture listener) | Main (forwards guest-view keys) | Shell view has DOM focus; guest views forward via `before-input-event` |
| Theme apply | Renderer (documentElement vars) | Main (BaseWindow background) | CSS vars live in DOM; main only paints the window behind the view |
| Appearance persistence | Main (`theme.json`) | Renderer | Config dir is main's |
| Sidebar counts / Recent | eva-core readers in Main | Renderer | Reads Eva checkout (read-only), exposed via `eva.sidebar` |
| Quit guard | Main (dialog, close/before-quit) | Renderer (`dirtyStore`) | Main owns quit; renderer owns the dirty state |
| Scroll memory | Renderer | none | Pure UI state |
| Entrance animation | CSS in Renderer | Main (`app.info.e2e`) | CSS timeline; flag decides off-switch |
| Overlay occlusion | Renderer wrappers | Main (`browser.setOccluded`) | Existing Phase 1 mechanism |

## Standard Stack

### Core (all already installed; no new installs)
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| @mantine/core / hooks / notifications | 9.7.2 | ScrollArea, SegmentedControl, Switch, Tooltip, Kbd, overlay primitives | Fixed by Isaac [VERIFIED: apps/desktop/package.json] |
| @tabler/icons-react | 3.49.0 | Nav/tab icons | Fixed by Isaac [VERIFIED: package.json] |
| zustand | 5.0.15 | layout, tabs, hotkey, dirty, scrollMemory stores (vanilla stores + selector hooks) | Phase 1 pattern [VERIFIED: package.json] |
| zod | 4.6.7 | New IPC channel schemas, `layout.json` / `theme.json` / `settings.json` tolerant parsing | Phase 1 contract [VERIFIED] |
| vitest 5.0.4 + @testing-library/react + jsdom | pinned | shell-core, theme-core, overlay lint scan, element-identity test | Phase 1 [VERIFIED] |
| @playwright/test | 1.64.1 | Proof and e2e | Phase 1 [VERIFIED] |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Hand-rolled hotkey router | `@mantine/hooks` `useHotkeys` / `react-hotkeys-hook` | Neither gives scope priority, a capture phase listener, terminal pass-through or the e2e ring buffer; hand-roll is ~120 lines of pure logic, as decided (D-11) |
| `@dnd-kit` for grips | Pointer events | Overkill for a 1-D drag; use pointer capture |
| Mantine `AppShell` | Custom flex frame | UI-SPEC forbids AppShell |

**Installation:** none. Add only workspace packages (`@evaos/shell-core`, `@evaos/theme-core`) as `workspace:*` devDependencies of `apps/desktop`, then `pnpm install`.

## Package Legitimacy Audit

No external packages are installed in this phase. All used packages are the Phase 1 pins already in `pnpm-lock.yaml`. Packages removed: none. Packages flagged: none. (slopcheck not run; not applicable.)

## Architecture Patterns

### System Architecture Diagram

```
keydown (shell DOM) --------\
guest view before-input ---> main --(app.hotkey / browser.hotkey)--> HotkeyRouter (window capture)
                                                                      | scopes: overlay > terminal > page > global
                                                                      v
                                              action registry --> stores (tabs, layout, sidebar, dirty)
                                                                      |
 window.innerWidth --> fit(shell-core) --> layout store --> CSS vars --> Frame (sidebar | main card | panel card)
                           ^   |                                              |
          layout.json <----+---+-- IPC layout.save (pointer-up only)           +--> BrowserPanel slot --> browser.setBounds
 theme.json --> theme-core resolveTheme(doc, mode) --> ThemeApplier --> html --eva-c-* (139) + aliases
                                  ^ matchMedia(System)                   +--> app.setBackground --> BaseWindow bg
 eva.sidebar (main, eva-core readers: todos, jobs, journal) --> Sidebar badges + Recent
 window close / before-quit (main) --event app.unsavedEdits.request--> renderer dirtyStore
        <-- invoke app.unsavedEdits.reply {id, entries} -- dialog.showMessageBox -- Save: event app.saveDirty.request / reply
```

### Recommended Project Structure
```
packages/shell-core/src/{fit,layout-file,tabs,place,chord,router,journal?}.ts  (+ *.test.ts)
packages/theme-core/{src/{keys,bundled,base-light,base-dark,resolve,doc,vars}.ts, scripts/gen-base.ts}
packages/eva-core/src/sidebar/{todos,jobs,journal}.ts   (countOpenTodos, countScheduledJobs, recentTitles)
packages/contract/src/{app.ts (+setBackground, unsavedEdits, hotkey, layout, theme, settings), eva.ts}
apps/desktop/src/main/{layout-ipc,theme-ipc,settings-ipc,eva-ipc,quit-guard}.ts
apps/desktop/src/renderer/{shell,sidebar,tabs,pages,settings,theme,hotkeys,overlay,ui}/
```

### Pattern 1: `fit` verbatim port
**Source:** `/Users/ike/Eva/apps/evaos/src/layout.rs` lines 11-56 [VERIFIED: read in this session]
```ts
export const GAP=8, TRAFFIC_LIGHTS=80, MAIN_MIN=480, SIDEBAR_MIN=200, SIDEBAR_MAX=420, SIDEBAR_DEFAULT=272, PANEL_MIN=320, PANEL_DEFAULT=420
export function fit(window: number, sidebar?: number, panel?: number): {sidebar:number; panel:number} {
  const panelRoom = panel !== undefined ? PANEL_MIN + GAP : 0
  const sb = sidebar === undefined ? 0 : (() => {
    const room = window - MAIN_MIN - GAP - panelRoom
    return room < SIDEBAR_MIN ? 0 : Math.min(Math.max(sidebar, SIDEBAR_MIN), SIDEBAR_MAX, room)
  })()
  const left = sb > 0 ? 0 : GAP
  const pn = panel === undefined ? 0 : (() => {
    const available = Math.max(window - left - sb - 2 * GAP, 0)
    return Math.min(Math.max(panel, PANEL_MIN), Math.max(available - MAIN_MIN, PANEL_MIN), available)
  })()
  return { sidebar: sb, panel: pn }
}
```
Vectors: three-column floor with panel = 200 + 480 + 8 + 328 = 1016; 760 and 800 windows with a panel: sidebar 0, panel 320 (760-8-16=736 available, `max(736-480,320)=320`). Read the Rust `#[cfg(test)]` block (lines ~170-252) and port every assertion.

### Pattern 2: Tab model with the REAL saved shape
**Source:** `src/tabs.rs` (read) and the live file `~/Library/Application Support/EvaOS/layout.json` [VERIFIED]. A saved tab is:
`{ "here": {"page":"chat","chat":"<path|absent>","settings_section":"Theme","meeting":null}, "back":[place...], "forward":[place...], "pinned":bool }`, with top-level `active` index and `list`. Page keys are lowercase (`"chat"`); `settings_section` is capitalised (`"Theme"`, `"Chat"`); `HISTORY = 50` caps each of `back` and `forward`. D-07's "history with a cursor" is a modelling choice; keep `back`/`forward` stacks so files stay interchangeable. Rust semantics to port and test: `Tabs::new` sorts pinned first and keeps the active tab by id; ids are `u64` that are never reused (`next_id = max+1`; not persisted, recomputed); `same_place` (drafts never match; Chat compares chat identity; Settings compares section; Meetings compares stem; other pages equal); commit/mark pending-place mechanism (the Rust GUI needs it because page state is external; in TS make navigation an explicit reducer `navigate(tabs, place)` that pushes `here` onto `back` and clears `forward`, which removes the need for `pending`/`fresh` except the "`⌘`-click just opened the tab so its first navigation starts no history" rule: preserve that via a `fresh` flag). Note the real file's `board` and workspace places: read `place_from`/`page_key` (tabs.rs ~490-560) so unknown pages degrade to Dashboard instead of throwing. Important: pinned chat tabs in Isaac's real file point at session paths. The app only reads its own config dir (D-02), so none of this loads unless the optional read-only import is built; skip the import (not trivial, no requirement).

### Pattern 3: Config files via ConfigStore with merge-write
`ConfigStore.readJson/writeJson` already does temp+rename (verified, `config-store.ts`). `writeJson` replaces the whole file, so for `layout.json` do read, spread, set keys, write (preserving unknown keys, D-02). Serialise writes in main (single queue) because tabs and widths are written from different events. Validate with zod `.passthrough()` and clamp; a malformed file must set a `resetOnce` flag that triggers the "Layout was reset to defaults." toast once per launch.

### Pattern 4: Hotkey router
One `window.addEventListener('keydown', handler, true)`. Normalise: modifiers ordered `cmd, ctrl, alt, shift` then key lowercased (`metaKey`→`cmd`); use `e.key` for `[`/`]`/digits but prefer `e.code` (`BracketLeft`, `Digit1`) because `⇧` and layouts change `e.key`; `⌘⇧C` arrives as key `C` or `c`, so lowercase. Always `preventDefault` + `stopPropagation` only when a handler consumed the chord, so `⌘C/⌘V/⌘A/⌘Z/⌘X` and Esc with an empty stack reach the page. Registries: array of `{scope, chord, handler, priority}`; dispatch order overlay, terminal, page, global; first handler returning true wins. Terminal scope: `claim(allPass: string[])` returns true (swallow) for any chord not in the pass-through list so xterm gets it. Existing seam: `useBrowserHotkeys` already attaches its own `keydown` and dispatches `eva:hotkey` custom events (comment says "Phase 2 router listens for this"). Replace that listener: register its chords (`new-tab`, `close-tab`, `focus-address`, `prev/next-tab`, `devtools`) in the page scope, keep `matchesAppChord` for the guest-forwarded path, and have the router consume `browser.hotkey` events plus the new `app.hotkey` event. Beware double dispatch: today a chord pressed in the shell is handled by `useBrowserHotkeys` and would also match the new router. There must be exactly one keydown listener.

`⌘W` semantics (README): browser subtab if the panel has focus, else the main tab. Track panel focus with `focusin/focusout` on the panel card (and treat events forwarded from the guest view as panel-focused). `⌘T` in Phase 1 meant a browser subtab (`new-tab` chord); Phase 2 rebinds `⌘T` to a new main chat tab per D-14/UI-SPEC and the panel's `+` button remains the way to open a browser subtab. Check `browser-core/hotkeys.ts` `AppChord` list and the guest forwarding so `⌘T` from a guest page now reaches the new router, and update the Phase 1 e2e specs that send `⌘T`/`⌘W` expecting browser behaviour (grep `Meta+t`, `Meta+w` in `apps/desktop/e2e`; unverified how many specs).

### Pattern 5: ThemeApplier and Mantine color scheme
- Apply: loop the 139 `[key,value]` pairs, `root.style.setProperty('--eva-c-'+key.replaceAll('.','-'), value)`; names are stable across modes, so a mode switch only changes values. Batch in one function call per mode switch; no React state involved.
- Mantine's scheme attribute: call `useMantineColorScheme().setColorScheme(resolved)` from a tiny component under the provider (never `'auto'`, never `forceColorScheme`). It updates provider state and sets `data-mantine-color-scheme` without remounting children. Mantine's default `localStorageColorSchemeManager` reads `mantine-color-scheme-value` at mount, which can disagree with `theme.json`; pass a custom `colorSchemeManager` object (`get`, `set`, `subscribe`, `unsubscribe`, `clear`) that is a no-op store seeded from the bootstrap value. [ASSUMED: Mantine 9 manager interface unchanged from v7/v8; confirm by reading `@mantine/core` types in the plan].
- Bootstrap (no flash): inline script in `index.html` cannot run under the current CSP (`script-src 'self'`). Options: ship it as an external `<script src="./bootstrap.js">` copied through Vite's `public/`; or compute in `main.tsx` before `createRoot`. Use the external file (or main.tsx top-level code, which is already blocking before first paint since the module is deferred but runs before React renders; the window is `show:false` until `did-finish-load`, so a pre-render sync call in `main.tsx` is sufficient). Main creates the window with the last known background: persist it (`theme.json` `app.lastBackground`) and read it in `createMainWindow` (currently hard-coded `#17181c`; UI-SPEC says fallback `#181817`).
- `app.setBackground` calls `win.setBackgroundColor(hex)` on the `BaseWindow` (the WebContentsView `shell` also has `setBackgroundColor`; set both to avoid white flashes on resize).
- System mode: `matchMedia('(prefers-color-scheme: dark)')` change listener in the applier; also in e2e use `page.emulateMedia({colorScheme})` for System tests, and select Light/Dark explicitly for proof.

### Pattern 6: Kit base generation (THEM-01 risk)
`packages/theme-core/scripts/gen-base.ts` (run manually, output committed; keep `scripts/` outside the Vitest globs so the gate does not run it). Inputs: `~/.cargo/registry/src/index.crates.io-*/gpui-component-0.7.0/src/theme/default-theme.json` (Default Light 99 keys, Default Dark 94) and `default-colors.json`, plus the Rust-side key list from `/Users/ike/Eva/apps/evaos/src/theme_fields.rs` (139 `key: "..."` entries; the file lists group_box.title.foreground separately as UNUSED). The gap is real: after layering default-theme, 47 (light) / 53 (dark) of the 139 keys are still absent and must be filled by the kit's fallback logic in `schema.rs::ThemeColor::apply_config` (a 380-line function of `apply_color!`-style fallbacks, e.g. one key derived from another or from `background`/`accent` with `opacity`/`blend`). Port those fallbacks in an explicit order. Verify the generated values by spot checking against the running Rust app theme if cheap (e.g. compare a handful of derived keys); the unit test only proves "139 keys, valid hex", not correctness. Colors with alpha must be `#rrggbbaa`. Read `color.rs`/`schema.rs` helpers for the exact opacity and `mix` semantics (gpui `Hsla` math, not sRGB mixing) and note any approximations in a comment. The kit file `$schema` default also carries palette references ("blue.light" etc.) resolved through `default-colors.json` (the UI-SPEC already says this).

Bundled EvaOS file: `evaos.json` has two themes (`mode`: light/dark), each with exactly 43 `colors`, plus `font.family` IBM Plex Mono, `font.size` 14, `mono_font.family`, `mono_font.size` 13, `radius` 8, `radius.lg` 12, `shadow` false, and a `highlight` block (syntax; ignore until Phase 7). Copy verbatim. Note: Isaac's real Rust `theme.json` uses base "macOS Classic" with `Inter` font; the Electron app's own `theme.json` is separate and defaults to EvaOS per D-15/D-16.

### Pattern 7: Quit guard (main)
Existing code (`main/index.ts`): `before-quit` handler calls `event.preventDefault()` when `quitHooks.length>0`, runs hooks, then `app.exit(0)`; `window-all-closed` calls `app.quit()`. Required changes:
1. `quit-guard.ts` exports `guardedClose()`: if a `quitApproved` flag is set return true. Else send event `app.unsavedEdits.request {id}` to the shell and await the renderer's `invoke('app.unsavedEdits.reply', {id, entries:[{id,label}]})` with a 2 s timeout (timeout = treat as no dirty state, so a hung renderer cannot trap quit). If entries are empty, approve. Else `dialog.showMessageBox(win, {type:'question', message:'You have unsaved changes', detail, buttons:['Save','Discard','Cancel'], defaultId:0, cancelId:2, noLink:true})`. Save: event `app.saveDirty.request`, await reply listing failures; on failure show the failure box and abort. Cancel: abort.
2. Window `close` (BaseWindow event `'close'`): `if (!approved) { e.preventDefault(); void guardedClose().then(ok => ok && (approved = true, win.close())) }`. Closing the window triggers `window-all-closed` then `app.quit()` then `before-quit`; the approved flag makes the second pass skip the dialog.
3. `before-quit`: call the guard first (only if not approved), preventing default while waiting; on approval set the flag and call `app.quit()` again, which then flows into the existing hooks path (`quitting` flag there already prevents loops).
4. `⌘Q` is the Quit menu role's accelerator in `menu.ts` (kept; D-11 allows Quit). Quit from the account menu calls `invoke('app.quit')` which runs `app.quit()`. A quit triggered by the OS (logout) cannot show a dialog reliably; accept.
Keep chat close semantics: quit hooks close stdin only, never SIGKILL (existing).
Testing: e2e stubs `dialog.showMessageBox` via `app.evaluate(({dialog}) => { dialog.showMessageBox = async () => ({response: 0}) })` and marks a dirty entry through a test hook (`window.__evaosTest`-style on renderer; main `registerTestHook`). Do not call `app.quit()` in the middle of a spec in a way that breaks the fixture teardown (fixture notes quit specs exist; see `packaged.spec.ts`/lifecycle spec).

### Pattern 8: Sidebar data readers (eva-core)
- `countOpenTodos(root)`: count lines matching `^- \[ \] ` under the `## Open` heading of `memory/todos.md` (stop at the next `## `). Fixture has 2 open (T1, T2).
- `countScheduledJobs(root)`: for each `jobs/*/job.md`, parse the YAML frontmatter with the `yaml` package or a hand splitter. Count where `enabled: true` and an `every:` (or other schedule key) exists. Check `/Users/ike/Eva/apps/evaos/src/sidebar.rs` and `src/jobs.rs` for the precise "enabled and scheduled" rule (cron `at`/`every`/`cron` keys) before coding. [ASSUMED: `every:` is the only schedule key]. The fixture Eva root has no `jobs/` directory (verified: `ls fixtures/eva-root` shows README.md, jobs (empty or absent glob), memory, workspaces; the glob matched nothing), so the plan must add fixture job files (one enabled+scheduled, one disabled) so Jobs count is testable. The real checkout jobs use frontmatter `every: 20m`, `enabled: true`.
- Recent: journal headings are `## YYYY-MM-DD [workspace] title` (fixture and real). Return `{date, tag?, title}`; UI filters on title and tag; cap 8; newest first means last in file first (file is append-only, newest last). Skip the `## Digest` section (not date-prefixed, so the `^## \d{4}-\d{2}-\d{2}` regex excludes it).
- The packages must not import `fs` directly for writes (write guard); these are reads only, going through the existing EvaFs read API if one exists in `eva-core/src/fs` (check; reads of the Eva root should use it).
- Refresh on window `focus` (renderer `window.addEventListener('focus')`) and `reload` action. No watcher needed in this phase.

### Pattern 9: Sliding sidebar and no-reflow animation
Track is two pages wide inside a fixed-width column; animate `transform: translateX` on the track and `width` on the column (220ms ease-out-cubic). Width animation changes main's width every frame, which triggers `ResizeObserver` in the virtualized chat and the browser slot sync. Coalesce per Phase 1 (`useSlotSync` already coalesces per frame, verify). Because the browser panel is right-anchored its slot x does not move when the sidebar toggles, only when the window width changes. In tests set `data-eva-motion=off` (0ms). Add `inert` plus `visibility:hidden` on the off-screen page after `transitionend` (React 19 supports the `inert` boolean attribute natively).

### Pattern 10: Entrance animation
Pure CSS; variables from `motion.rs` verified: SPEED 2; cue `video(start,duration)` = `/SPEED`: SIDEBAR 0/0.30 → 0/0.15; HERO 0.10/0.40 → 0.05/0.20; SECTIONS 0.30/0.35 → 0.15/0.175; FIRST_CARD 1.00/0.30 → 0.5/0.15; FIRST_CHART 1.10/0.70 → 0.55/0.35; SECOND_CARD 1.85/0.30 → 0.925/0.15; SECOND_CHART 1.95/0.45 → 0.975/0.225; GRID_CARDS Stagger(2.45, 0.15, 0.40) → 1.225 / step 0.075 / dur 0.2; ASIDE_TITLE 3.00/0.30 → 1.5/0.15; ASIDE_ROWS Stagger(3.10, 0.10, 0.30) → 1.55 / step 0.05 / 0.15; STATS_TITLE 3.20/0.30 → 1.6/0.15; STAT_CARDS Stagger(3.50, 0.08, 0.30) → 1.75 / step 0.04 / 0.15; `TOTAL = 3.95/SPEED = 1.975s`; `SIDEBAR_TOGGLE = Cue::new(0, 0.22)`; RISE 10 [VERIFIED: motion.rs lines 10-32]. The UI-SPEC table matches. The e2e budget is 2.0 s (CONTEXT's "3.95 s" is the video length).

### Anti-Patterns to Avoid
- Rebuilding the Mantine theme or remounting on theme change (D-15/D-16).
- Computing widths in the renderer outside `fit`; writing widths per frame.
- Hex colors or raw px in component files (01-UI-SPEC rule; Phase 1 lint/review checks it).
- Two keydown listeners (router plus the legacy `useBrowserHotkeys`).
- Importing `Modal/Menu/Popover/Drawer` from `@mantine/core` outside `renderer/overlay` (lint test).
- Menu accelerators for app chords (the Electron menu would swallow `⌘B/⌘R/⌘W` before the renderer sees them; current menu is already clean, keep it).

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Atomic JSON writes | new writer | existing `ConfigStore.writeJson` (temp + rename) | Already reviewed |
| IPC typing/validation | ad-hoc `ipcRenderer` | `packages/contract` + `handle()` | Phase 1 pattern; preload exposes only `invoke`/`on` |
| Browser occlusion | per-overlay hide logic | `useOccludeBrowser()` inside the four wrappers | One mechanism |
| Scrollbars | custom scroll DOM | Mantine `ScrollArea` inside `ui/ScrollArea` | Themed, accessible |
| Segmented control, switch, tooltip, kbd | custom | Mantine components styled by variables | In stack |
| YAML frontmatter | regex field scraping | `yaml` package (already approved in the stack) with a 15-line splitter; not gray-matter | Stack decision |
| Dialogs | custom modal for quit | `dialog.showMessageBox` | Spec |

**Key insight:** the risk in this phase is fidelity of the ports (fit, tabs, kit fallbacks) and seams with Phase 1 code, not library choice.

## Runtime State Inventory

Not a rename phase, but two migrations of existing Phase 1 state apply:

| Category | Items Found | Action Required |
|----------|-------------|------------------|
| Stored data | Phase 1 wrote `app-state.json` only; no layout/theme/settings files exist yet | None; new files default cleanly |
| Live service config | None | None |
| OS-registered state | None | None |
| Secrets/env vars | `EVAOS_NO_MOTION` is new (read in main `env.ts`, expose via `app.info`) | Add to `loadEnv` and `AppInfoSchema` (e2e, noMotion flags) |
| Build artifacts | Phase 1 testids `tab-*`, `tab-new`, `tab-close-*` in e2e specs and `browser/TabStrip.tsx` | Rename to `browser-tab-*`, `browser-tab-new`, `browser-tab-close-*` in one task; fix e2e selectors `^=tab-t` to `^=browser-tab-t` |

## Common Pitfalls

### Pitfall 1: testid collisions with Phase 1
**What goes wrong:** `[data-testid=tab-new]` and `[data-testid^=tab-close-]` match both the main tab strip and the browser tab strip; Playwright strict mode errors or clicks the wrong one (the main strip is earlier in DOM). Verified: `TabStrip.tsx` uses `tab-${id}` (ids look like `t1`), `tab-close-${id}`, `tab-new`; e2e uses `^=tab-t`, `tab-new`, `^=tab-close-` in browser-basic, browser-tabs, browser-arc, browser-cdp.
**How to avoid:** rename the browser ones (UI-SPEC explicitly allows) and update specs in the same plan; main tabs use numeric ids (`tab-3`).
**Warning signs:** Phase 1 browser specs fail only after the new tab strip lands.

### Pitfall 2: Native browser view over overlays and over resizes
**What goes wrong:** menus (account menu opens above the trigger near the bottom-left, probably not over the panel, but the tab context menu and Settings popovers can overlap the panel), grips dragged over the panel region.
**How to avoid:** all overlays through wrappers; `Grip` calls occlusion while dragging (pointer capture continues over the native view only while the view is hidden; the native view otherwise swallows `pointermove`).
Note Tooltips are not in the lint list but tooltips over the panel region render under the view; keep chrome tooltips from overlapping the panel, or wrap Tooltip too (add `Tooltip` to the forbidden-import scan only if cheap; it is not required by D-13).

### Pitfall 3: `before-quit` re-entrancy and window close
See Pattern 7. A second `app.quit()` after approval re-enters `before-quit`; guard with flags or the app hangs or double-prompts. Also `window-all-closed` → `app.quit()` fires after a closed window, so set the approved flag before `win.close()`.

### Pitfall 4: Capture-phase router steals text input
Router must not intercept plain typing; only chords with `cmd` or Esc, and never `⌘C/V/X/A/Z`. Inside inputs `⌘F`/`⌘N` still fire (intended). Esc with an empty dismiss stack must not `preventDefault` (xterm, inputs need it). Do not use `e.isComposing` events (IME); skip when `e.isComposing`.

### Pitfall 5: Mantine overlays and `closeOnEscape`
Set `closeOnEscape: false` on all wrappers and register `useDismissable`; otherwise Mantine closes the overlay on Esc before the router, and the router then also pops the sidebar sub-page (double dismissal). Mantine's own Esc handler runs on `document`, the router on `window` capture, so the router sees it first; ensure the router stops propagation when it consumes Esc.

### Pitfall 6: Drag region swallows clicks / interactive children
`-webkit-app-region: drag` regions swallow mouse events including `dblclick` and context menu; every child must be `no-drag` (spec). The tab strip's empty spacer is the only drag area; tabs, buttons and the grip are `no-drag`. Context menu (right-click) on tabs only works if the tab is `no-drag`. Check `drag-region.spec.ts` (opt-in, `EVAOS_OS_EVENTS=1`) which currently targets `chat-header`; update it to the tab strip or leave skipped but fix selectors.

### Pitfall 7: Folding behavior and window minimum
Window `minWidth` is 760 and the panel opens by default: `fit(760, 272, 420)` gives sidebar 0, panel 320. Main width = 760 - 8 - 8 - 320 = 424 < 480 (allowed, compact reflow). Chat composer and pills must not overflow at 424; verify in the 760x720 proof.

### Pitfall 8: Per-frame resize cost
Dragging a grip updates `fit` per `pointermove`; update only CSS variables on the frame element (not React state per frame) and write `layout.json` on pointer-up. The virtualized chat and `useSlotSync` already handle resize; throttle with rAF.

### Pitfall 9: Keep-alive chat vs scroll memory and tabs
Chat stays mounted but hidden (`display:none`); virtua loses measurements when hidden. On re-show, scroll to preserved offset; Phase 1 `useSlotSync` must also hide the browser panel's slot only if the panel closes, not when the Chat tab is hidden. Page placeholders remount per navigation (scroll memory restores). One pane only in Phase 2: the Chat place always shows the single Phase 1 `ChatPane` (do not instantiate multiple `ChatPane`s per chat tab; the Phase 1 store is a singleton).

### Pitfall 10: Icon names
`IconTimer` does not exist in `@tabler/icons-react` 3.49 (verified by listing the icons directory). Use `IconFlame` (streaks) or `IconRepeat` for Habits. All other icons in the UI-SPEC list exist (verified: LayoutDashboard, Inbox, Message, CalendarTime, Users, Calendar, ListCheck, Brain, File, Settings, Help, Asterisk, Search, ChevronRight/Down/Left, Edit, User, Selector, Power, Sun, Moon, DeviceDesktop, LayoutSidebar, LayoutSidebarRight, Plus, X, Pin, Palette, Bell).

## Code Examples

### Hotkey normalisation (pure, shell-core)
```ts
export function chordOf(e: Pick<KeyboardEvent,'key'|'code'|'metaKey'|'ctrlKey'|'altKey'|'shiftKey'>): string {
  const k = e.code.startsWith('Digit') ? e.code.slice(5)
    : e.code === 'BracketLeft' ? '[' : e.code === 'BracketRight' ? ']'
    : e.key === 'Escape' ? 'escape' : e.key.toLowerCase()
  return [e.metaKey&&'cmd', e.ctrlKey&&'ctrl', e.altKey&&'alt', e.shiftKey&&'shift', k].filter(Boolean).join('+')
}
```
[ASSUMED pattern; unit-test with the README table.]

### Applier
```ts
export function applyTheme(root: HTMLElement, vars: Record<string,string>): void {
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v)
}
// vars from theme-core: colorVars(resolved) -> {'--eva-c-accent-background': '#252523', ...} (139 entries)
```

### Contract additions (zod)
```ts
'app.setBackground': { input: z.object({ color: z.string().regex(/^#[0-9a-fA-F]{6}$/) }), output: z.object({}) }
'app.unsavedEdits.reply': { input: z.object({ id: z.string(), entries: z.array(z.object({ id: z.string(), label: z.string() })) }), output: z.object({}) }
// events (main to renderer): 'app.unsavedEdits.request' {id}, 'app.saveDirty.request' {id}, 'app.hotkey' {chord}
'eva.sidebar': { input: z.object({}).strict(), output: z.object({ openTodos: z.number(), scheduledJobs: z.number(), recent: z.array(...) }) }
```

## State of the Art

| Old Approach | Current Approach | Impact |
|--------------|------------------|--------|
| `BrowserView` | `WebContentsView` (already used) | Phase 1 done |
| Inline bootstrap scripts | External script or pre-render sync code under strict CSP | Needed for no-flash scheme |
| Rebuild UI theme object per change | CSS variables set imperatively | THEM-01 |

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Mantine 9 `colorSchemeManager` interface is `{get,set,subscribe,unsubscribe,clear}` | Pattern 5 | Use `setColorScheme` with default manager and overwrite localStorage key instead |
| A2 | `every:` is the only schedule key counted for "scheduled" jobs | Pattern 8 | Wrong Jobs badge; read `sidebar.rs`/`jobs.rs` first |
| A3 | `e.code`-based chord normalisation works for `⌘[`/`⌘]`/digits on ANSI and common layouts | Pattern 4 | Non-US layouts mis-map; fall back to `e.key` |
| A4 | Kit fallback formulas can be ported faithfully by reading `schema.rs`; spot check vs Rust app is feasible | Pattern 6 | Slightly different derived colors in non-EvaOS-defined keys; low visual impact |
| A5 | `dialog.showMessageBox(win, ...)` with a BaseWindow works (typed `BaseWindow`) | Pattern 7 | Fall back to no-parent dialog |
| A6 | Renderer replies to main requests via invoke, 2 s timeout to avoid a trapped quit | Pattern 7 | Design choice, not an API fact |

## Open Questions

1. **Kit fallback exactness.** What we know: 47/53 keys are missing after default-theme and EvaOS layering. Unclear: how many are consumed visibly by Phase 2 components. Recommendation: port fully; Phase 2 components only read about 25 keys (listed in UI-SPEC), so unit-test validity and eyeball proofs.
2. **`⌘T` rebinding vs Phase 1 e2e.** Phase 1 specs may send `⌘T` for browser subtabs. Recommendation: grep `Meta+t`/`Meta+w` in e2e at plan time and move browser expectations to the panel `+` button or the page-scope focus rules.
3. **Where journal/todo parsers live.** CONTEXT says `eva-core`. Check whether `eva-core/src/fs` already offers a read API that must be used for reads. Recommendation: use it if it exists; otherwise plain `fs.readFileSync` for read-only in `main/eva`.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node | build/tests | yes | 24.x (per CLAUDE.md) | none |
| pnpm | install | yes via corepack (Phase 1 gate uses `scripts/env.sh`) | 12.11.2 | none |
| Electron + Playwright | e2e, proofs | yes (Phase 1 e2e passes) | 44.7.2 / 1.64.1 | none |
| gpui-component 0.7.0 source | kit base generation | yes at `~/.cargo/registry/src/index.crates.io-*/gpui-component-0.7.0/` (read-only; script must read, not write) | 0.7.0 | none needed |
| Rust EvaOS source | port reference | yes at `/Users/ike/Eva/apps/evaos` (read-only) | n/a | none |

No missing dependencies.

## Validation Architecture

Skipped: `workflow.nyquist_validation` is `false` in `.planning/config.json`. Test guidance still applies from CONTEXT: Vitest for shell-core (fit vectors, tabs, chords, router scopes), theme-core (139 keys, valid hex, same names across modes), renderer (element identity across a mode switch, overlay import scan, ScrollArea fades with `data-fade-*`, em-dash lint), e2e for card rects at 1280/1016/800/760, hotkey ring buffer, grips and `layout.json` persistence across relaunch (use the same `configDir` fixture and launch twice; the fixture currently deletes the dir per test, so use one test that closes and relaunches via `_electron.launch` manually), quit guard with stubbed dialog, motion test, proof set composited with `proofShot` (resize the window with `app.evaluate(({BaseWindow}) => BaseWindow.getAllWindows()[0].setSize(760,720))` for 760x720 and 1440x900 shots). `pnpm gate` stays the phase gate (note: the gate runs packaged smoke too; the new `packages/*` must be bundled correctly, which is automatic because main/renderer inline workspace packages through Vite).

## Security Domain

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V5 Input Validation | yes | zod on every new IPC channel; clamp widths; hex regex on `app.setBackground`; tolerant parsers for `layout.json`/`theme.json`/`settings.json` |
| V12 Files | yes | `ConfigStore.checkName` forbids path separators; writes only under config dir; Eva checkout reads only (write guard stays) |
| V14 Config | yes | keep `sandbox`, `contextIsolation`; preload surface unchanged (`invoke`, `on`); new events are typed channels |
| V2/V3/V6 | no | no auth/session/crypto in scope |

| Pattern | STRIDE | Mitigation |
|---------|--------|------------|
| Guest page forging app IPC (`app.hotkey`, `unsavedEdits.reply`) | Spoofing/Tampering | existing sender validation in `handle()` (shell frame only); guest views have no preload |
| Malformed `layout.json` crashing startup | DoS | parse with fallback, clamp, reset toast |
| Path traversal in config names | Tampering | existing `checkName` |
| Quit trapped by hung renderer | DoS | 2 s timeout on `unsavedEdits` request |

## Sources

### Primary (HIGH)
- `/Users/ike/Eva/apps/evaos/src/layout.rs`, `tabs.rs`, `motion.rs`, `theme_fields.rs`, `assets/themes/evaos.json`, `src/app.rs` key bindings (read in this session)
- gpui-component 0.7.0 `default-theme.json` (key counts computed), `schema.rs` (apply_config location)
- Phase 1 code: `main/{index,window,config-store,menu,test-hooks}.ts`, `renderer/{main.tsx,index.html,ipc.ts,app/App.tsx,overlay/overlay-store.ts,styles/tokens.css,browser/useBrowserHotkeys.ts,browser/TabStrip.tsx}`, `e2e/fixtures.ts`, `scripts/gate.sh`, `vitest.config.mts`
- Live `~/Library/Application Support/EvaOS/layout.json` and `theme.json` (read-only shape check)
- Installed `@tabler/icons-react` icon directory listing (icon name verification)

### Secondary (MEDIUM)
- Mantine 9 behaviors (`setColorScheme`, `ScrollArea`) from training knowledge; verify against installed types during planning [ASSUMED]

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH, nothing new installed
- Architecture: HIGH, ports verified against source
- Pitfalls: HIGH for testid/quit/icon findings (verified in code); MEDIUM for Mantine scheme-manager details
- Kit base derivation: MEDIUM, largest technical risk

**Research date:** 2026-10-15
**Valid until:** 2026-11-14
