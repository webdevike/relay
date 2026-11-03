# Phase 2 Discussion Log

Mode: autonomous smart discuss, 2026-10-15. Isaac unavailable; every area accepted with the recommended answer.

## Grey Area 1/4: Shell geometry, cards and persistence

| # | Question | Accepted | Alternatives not taken |
|---|----------|----------|------------------------|
| 1 | Where do the fit rules live? | Verbatim port of `layout::fit` into `packages/shell-core`, Rust tests ported | Keep inside the renderer |
| 2 | `layout.json` shape | Rust keys and shape in the app's own config dir, written on drag end | New Electron-only shape |
| 3 | Frame look | Sidebar on chrome, main and panel as inset cards, footer strip | Flat columns |
| 4 | Sidebar fold | Preference in memory, fold derived from fit, explanatory tooltip | Persist visibility |
| 5 | Scroll areas | One ScrollArea wrapper with fades and per-place memory | Raw Mantine ScrollArea |

## Grey Area 2/4: Navigation model

| # | Question | Accepted | Alternatives not taken |
|---|----------|----------|------------------------|
| 1 | Tabs model | Port of `tabs.rs` with the Rust JSON shape | Flat tab list |
| 2 | Sliding sub-pages | 220 ms slide, Back and Esc, Chats and Meetings headers over empty bodies, Settings sections | Separate routes |
| 3 | Nav pages, counts, Recent | All README pages as placeholders; counts and Recent via small eva-core readers | Defer counts |
| 4 | Tab strip UI | Linear-style strip at the top of main with pin, close, close others, `⌘`-click | Tabs in the sidebar |

## Grey Area 3/4: Hotkey router and overlays

| # | Question | Accepted | Alternatives not taken |
|---|----------|----------|------------------------|
| 1 | Router | One capture-phase router with scoped registries; pure matching in shell-core | Menu accelerators |
| 2 | Esc ladder | Ordered dismisser stack | Per-component handlers |
| 3 | Overlay wrappers | Eva wrappers over Mantine with occlusion; lint test | Trust each component |
| 4 | Not-yet-built chords | Registered now with observable stubs; `⌘⇧B` toggles the panel | Register per phase |

## Grey Area 4/4: Theme, motion and quit

| # | Question | Accepted | Alternatives not taken |
|---|----------|----------|------------------------|
| 1 | Theme architecture | theme-core with 139 keys, bundled EvaOS themes, imperative ThemeApplier, Phase 1 tokens aliased | Rebuild MantineProvider |
| 2 | Appearance | `theme.json` `app.appearance`, System via prefers-color-scheme, window background follows | Mantine manager only |
| 3 | Entrance animation | CSS timeline from motion.rs, once per launch, off for e2e and reduced motion | JS animation library |
| 4 | Quit guard | Renderer dirty registry, native Save / Discard / Cancel, e2e via test hook | Defer to Phase 6 |
