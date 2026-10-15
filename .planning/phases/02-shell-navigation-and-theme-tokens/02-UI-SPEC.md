---
phase: 2
slug: shell-navigation-and-theme-tokens
status: draft
shadcn_initialized: false
preset: none
created: 2026-10-15
---

# Phase 2 - UI Design Contract

> Visual and interaction contract for the real EvaOS shell: three-column frame and footer, sidebar with sliding sub-pages, main tab strip, placeholder pages, Settings (Theme, Chat, Notifications), the 139-key CSS-variable theme with Light / Dark / System, scroll areas, entrance animation, quit guard and overlay wrappers.
> This extends `01-UI-SPEC.md` (tokens, spacing, typography, overlay rules). Anything not restated here keeps its Phase 1 value. Where this file conflicts with Phase 1, this file wins and the change is listed under "Changes to Phase 1 tokens".
> Provenance legend: [CTX Dnn] from 02-CONTEXT.md (locked), [README] / [rust:file] Rust EvaOS source of truth (visual target), [P1] Phase 1 UI-SPEC, [auto] auto-selected default (unattended run, Isaac unavailable).
> Copy rule: no em dashes (U+2014) in any string. Sentence case. No exclamation marks.

---

## Design System

| Property | Value |
|----------|-------|
| Tool | none (Mantine is the fixed component library; shadcn not applicable) [P1] |
| Preset | not applicable |
| Component library | Mantine 9.7 primitives: `Box`, `Group`, `Stack`, `ScrollArea` (only inside the shared `ui/ScrollArea` wrapper), `ActionIcon`, `Button`, `Badge`, `Switch`, `SegmentedControl`, `TextInput`, `Tooltip`, `Kbd`. `Modal`, `Menu`, `Popover`, `Drawer` only through `renderer/overlay` wrappers [CTX D-13]. AppShell is NOT used. |
| Icon library | `@tabler/icons-react`, stroke 1.5, 16 px in chrome and nav rows, 14 px inline (chevrons, close, kbd rows) [P1] |
| Font | UI: `var(--eva-font-ui)` = theme `font.family` ("IBM Plex Mono" in both bundled themes) then the Phase 1 system stack as fallback. Code: `var(--eva-font-code)` = "IBM Plex Mono", ui-monospace, Menlo, monospace. Bundled weights 400 and 600 only [rust: assets/themes/evaos.json, P1] [auto] |
| Color scheme | Light, Dark or System, stored in `theme.json` `app.appearance`, default `system`. Mantine `data-mantine-color-scheme` follows the resolved mode; `forceColorScheme` is never set [CTX D-15, D-16] |
| Token mechanism | `ThemeApplier` writes `--eva-c-*`, `--eva-font-*`, `--eva-radius*`, `--eva-shadow` onto `document.documentElement` imperatively. `MantineProvider` gets a static theme and is never rebuilt on theme change. Components read only `var(--eva-*)` or Mantine variables; no hex and no raw px in component files except the layout constants named in this file [CTX D-15, P1] |

Default appearance [auto]: `system`. If `theme.json` is missing, malformed or has an unknown value, use `system`. First paint must not flash: the `index.html` inline bootstrap script reads `prefers-color-scheme` and sets `data-mantine-color-scheme` and `--eva-c-background` before React mounts; the main process creates the `BaseWindow` with the last known background (fall back to dark #181817) and then updates through `app.setBackground`.

---

## Spacing Scale

Scale unchanged from Phase 1 (all multiples of 4): xs 4, sm 8, md 16, lg 24, xl 32, 2xl 48, 3xl 64 as `--eva-space-*`.

Phase 2 uses 2xl and 3xl for page placeholders (3xl top padding of an empty page, 2xl gap between placeholder icon and title) so the "Reserved" tokens are now live.

Exceptions (layout geometry and control sizing, not spacing tokens). Every value is a multiple of 4 unless marked:

| Constant | CSS variable | Value | Notes |
|----------|--------------|-------|-------|
| Card gap and window inset | `--eva-gap` | 8px | GAP from `layout.rs`; between sidebar gutter, main, panel and window edge [CTX D-01] |
| Traffic-light clearance | `--eva-traffic` | 80px | `TRAFFIC_LIGHTS`; main tab strip content starts at window x = 80 when the sidebar is hidden [CTX D-01, D-03] |
| Sidebar header top inset | `--eva-sidebar-top` | 36px | Clears the macOS traffic lights above the brand row (Rust uses 34; rounded to the 4 grid) [auto] |
| Sidebar width | `--eva-sidebar-w` | 272 default, 200 min, 420 max | Written by the layout store from `fit()`; includes the 8px trailing gutter [CTX D-01] |
| Panel width | `--eva-panel-w` | 420 default, 320 min, no max | Replaces Phase 1's 480 default and 960 max [CTX D-01] |
| Main minimum | `--eva-main-min` | 480px | Compact windows (760, 800) may reflow main below it [CTX D-01] |
| Main tab strip height | `--eva-tabbar-h` | 40px | Same as Phase 1 chat header height |
| Tab item height | 28px | | Pinned tab is 28 by 28 |
| Footer strip height | `--eva-footer-h` | 32px | [auto] |
| Nav row height | 36px | | Rust `control::SM`; `px` 12 is a permitted inner-padding exception (multiple of 4, not a scale step) |
| Back row / small control height | 32px | | |
| Sidebar search box height | 36px | | |
| Recent row height | 28px | | |
| Count badge | min-width 20px, height 20px, radius 10px, padding 0 4px | | |
| Grip hit area | 8px wide, full column height | | Visible bar 2 by 36px [CTX D-05] |
| Icon-only buttons in chrome | `ActionIcon size={28}` | | 28 square; row padding gives a 36px minimum hit height [P1] |
| Window minimum | 760 by 720 | | unchanged [P1] |

Rules:
- A rect sent over IPC for the browser slot stays integer-rounded; the browser slot `div` keeps no padding, border or margin [P1]. The panel card's 1px border sits outside the slot, so the slot rect is the card inner rect minus the panel's own chrome rows.
- Card inner padding is 0. Content padding belongs to the page (24px for Settings and placeholders, `--eva-space-lg`).

---

## Typography

Exactly 4 sizes and 2 weights, unchanged from Phase 1:

| Role | Size | Weight | Line Height | Phase 2 usage |
|------|------|--------|-------------|---------------|
| Body | 14px | 400 | 1.5 | Nav row labels (weight 400, active 600), page descriptions, menu items, settings row text, input text |
| Label | 12px | 600 (400 where stated) | 1.4 | Tab titles, count badges, section labels ("Main"), segmented control labels, footer Help, Recent rows (weight 400), tooltips, kbd chips, brand tagline (weight 400), mono code |
| Heading | 16px | 600 | 1.2 | Sidebar sub-page titles ("Chats", "Settings", "Meetings"), brand name "EvaOS", card titles, dialog titles |
| Display | 20px | 600 | 1.2 | Page titles in main (placeholder pages, Settings sections) |

Phase 2 specifics:
- Rust's Medium (500) maps to 600; Rust's 11px badge size maps to 12px; Rust's H3 22px page headings map to Display 20px. No fifth size, no third weight.
- Sentence case everywhere, except proper nouns and the three Appearance labels ("Light", "Dark", "System").
- The theme file's `font.size` (14) and `mono_font.size` (13) are written as `--eva-font-size` and `--eva-font-code-size` for Phase 7's editor; Phase 2 components keep Body 14 and code at Label 12 so the contract stays at four sizes [auto].
- Tabular figures for count badges: `font-variant-numeric: tabular-nums`.

---

## Color

### Roles and the 60/30/10 split

Dominant, secondary and accent are roles over theme keys, so they hold in both modes. Values shown are the two bundled EvaOS themes [rust: assets/themes/evaos.json, CTX D-15].

| Role | Variable | Dark | Light | Usage |
|------|----------|------|-------|-------|
| Dominant (60%) | `--eva-c-background` | #141413 | #f3f3f1 | Main card and panel card fill, chat log, page bodies |
| Secondary (30%) | `--eva-c-sidebar-background` | #181817 | #eeeeeb | Window chrome behind the cards, sidebar, footer strip, `BaseWindow` background |
| Secondary surfaces | `--eva-c-secondary-background` | #1b1b1a | #f8f8f6 | Composer, code fences, tool rows, browser chrome rows (Phase 1 `--eva-surface`) |
| Hover and raised | `--eva-c-accent-background` | #252523 | #e5e5e1 | Row hover, tab hover, Phase 1 `--eva-surface-2` |
| Border | `--eva-c-border` | #2a2a28 | #e2e2de | Card borders, dividers, inputs |
| Sidebar border | `--eva-c-sidebar-border` | #262624 | #deded9 | Dividers inside the sidebar, Recent indent rule |
| Text | `--eva-c-foreground` | #ececea | #161616 | Body text |
| Sidebar text | `--eva-c-sidebar-foreground` | #d8d8d4 | #2b2b28 | Nav rows |
| Dim text | `--eva-c-muted-foreground` | #9a9a93 | #74746e | Section labels, placeholders, inactive tab titles |
| Accent / primary (10%) | `--eva-c-primary-background` | #f2f2ef | #141414 | Reserved list below |
| On accent | `--eva-c-primary-foreground` | #141413 | #fafaf9 | Text on accent fills |
| Active nav fill | `--eva-c-sidebar-primary-background` | #f2f2ef | #141414 | Active nav row, active sidebar sub-page row |
| Active tab | `--eva-c-tab-active-background` / `--eva-c-tab-active-foreground` | #2a2a28 / #ececea | #f8f8f6 / #161616 | Active main tab |
| Segmented track | `--eva-c-tab_bar-segmented-background` | #20201e | #e7e7e4 | Appearance control track |
| Popover | `--eva-c-popover-background` / `-foreground` | #1d1d1c / #ececea | #fbfbfa / #161616 | Menus, popovers, modals |
| Focus ring | `--eva-c-ring` | #55554f | #b5b5b0 | Decorative ring only; see focus rule |
| Success | `--eva-c-success-background` | #4ade80 | #22c55e | Working dot, count of enabled items never uses it |
| Warning | `--eva-c-warning-background` | #facc15 | #eab308 | Reserved (approvals, Phase 4) |
| Destructive | `--eva-c-danger-background` | #f87171 | #ef4444 | Error banners and failed-save text; no destructive button in Phase 2 |

Accent reserved for (exhaustive, replaces the Phase 1 list but keeps its elements):
1. The active sidebar nav row and active sub-page row fill (`sidebar-primary`).
2. The brand tile fill in the sidebar header.
3. Focus-visible outline on every focusable element (2px, offset 2px). The outline uses `--eva-c-primary-background`, not `--eva-c-ring`, because the bundled ring color is under 3:1 on both backgrounds.
4. The Phase 1 chat elements, unchanged in role: Jump to latest and New reply pills, address-bar and composer focus ring, active browser tab 2px top line, browser loading bar, streaming dot.
5. The checked state of a Switch in Settings.
6. The selected segment of the Appearance control uses `tab-active` (not accent).

Never accent: body text, icons in chrome, borders, hover states, tab fills, count badges.

Contrast rules:
- Text on `--eva-c-background` and `--eva-c-sidebar-background` meets 4.5:1 for `foreground`, `sidebar-foreground`, `primary-foreground` on `primary-background`.
- Known exception: bundled light `muted-foreground` #74746e on #f3f3f1 measures about 4.3:1. It is allowed only for secondary text at 12 px and above that never carries the sole copy of an action (section labels, placeholders, descriptions). Count badges, tab titles and anything actionable use `foreground`/`sidebar-foreground`. Do not edit the bundled values (locked by D-15).
- Success, warning and danger fills are used as dots, bars, banners with `foreground` text, never as small text on the page background in light mode.

### Theme variable naming [CTX D-15]

- Every kit color key becomes `--eva-c-<key with "." replaced by "-">`, underscores kept: `accent.background` becomes `--eva-c-accent-background`, `tab_bar.segmented.background` becomes `--eva-c-tab_bar-segmented-background`, `base.blue.light` becomes `--eva-c-base-blue-light`. Values are `#rrggbb` or `#rrggbbaa` strings exactly as resolved.
- Exactly 139 keys are written (the kit schema's keys minus `group_box.title.foreground`). A Vitest test counts the `--eva-c-*` properties after `apply()` and asserts 139, and that a mode switch changes the set of values but not the set of names.
- Resolution order per key, per mode: bundled EvaOS mode file (43 keys, copied verbatim) over the kit base for that mode. The kit base (96 remaining keys) is generated once by a committed script under `packages/theme-core/scripts/` from gpui-component 0.7.0 `default-theme.json` (Default Light for light, Default Dark for dark), resolving palette tokens through `default-colors.json` and applying the kit's documented fallback formulas (`schema.rs` `apply_config`) for keys absent from both. The output is committed as `base-light.ts` and `base-dark.ts`; there is no runtime derivation. Tests assert every value is a valid hex and no key is missing.
- Editable layers (`light.edits`, `dark.edits`, `shared`, `app`) are layered on top by `resolveTheme(doc, mode)`; Phase 2 only ever has empty edits and `app.appearance`.
- Other variables written by the applier: `--eva-font-ui`, `--eva-font-code`, `--eva-font-size` (14), `--eva-font-code-size` (13), `--eva-radius` (8), `--eva-radius-lg` (12), `--eva-shadow` (`none` when the theme `shadow` is false, else `0 1px 2px rgb(0 0 0 / 0.2)`).

### Aliases for the Phase 1 tokens [CTX D-15, auto]

`tokens.css` keeps the old names so existing components work untouched; each becomes an alias in `:root` (not per-scheme), resolved through the live `--eva-c-*` values:

| Phase 1 variable | Alias of |
|------------------|----------|
| `--eva-bg` | `var(--eva-c-background)` |
| `--eva-surface` | `var(--eva-c-secondary-background)` |
| `--eva-surface-2` | `var(--eva-c-accent-background)` |
| `--eva-border` | `var(--eva-c-border)` |
| `--eva-text` | `var(--eva-c-foreground)` |
| `--eva-text-dim` | `var(--eva-c-muted-foreground)` |
| `--eva-accent` | `var(--eva-c-primary-background)` |
| `--eva-accent-fg` | `var(--eva-c-primary-foreground)` |
| `--eva-ok` | `var(--eva-c-success-background)` |
| `--eva-warn` | `var(--eva-c-warning-background)` |
| `--eva-danger` | `var(--eva-c-danger-background)` |

New semantic aliases for the shell: `--eva-chrome` (sidebar.background), `--eva-chrome-text` (sidebar.foreground), `--eva-chrome-border` (sidebar.border), `--eva-hover` (accent.background), `--eva-nav-active-bg` (sidebar.primary.background), `--eva-nav-active-fg` (sidebar.primary.foreground), `--eva-popover-bg`, `--eva-popover-fg`, `--eva-scroll-thumb` (scrollbar.thumb.background), `--eva-scroll-thumb-hover` (scrollbar.thumb.hover.background), `--eva-scroll-fade-bg` (default `var(--eva-c-background)`; the sidebar sets it to chrome).

### Changes to Phase 1 tokens

- The indigo accent #7c8cff and the blue-gray dark palette are retired. Phase 1 chat and browser components now render in the EvaOS neutral palette in both modes. The accent is near-white on dark and near-black on light. Pills, dots and focus outlines therefore read as high-contrast neutral, not hue. [auto: the bundled themes are locked by D-15]
- Phase 1's rule "Light scheme: out of scope" is removed; every Phase 1 component is verified in both modes by the proof set.
- The Mantine `colors.eva` ramp stays for Mantine's internal states but all app surfaces read the CSS variables above.
- Phase 1 spike UI is removed: the placeholder rail, its "EvaOS" wordmark block and the "Test overlay" button [CTX D-13]. `data-testid="rail"` moves to the new sidebar root [CTX Established Patterns].

---

## Layout and Visual Hierarchy

### Frame

```
window (bg: --eva-chrome, drag region where stated)
  body: row, height = window - footer
    [ sidebar column  W px ][ main card ][ 8px ][ panel card ][ 8px ]
  footer strip: 32px, full width, bg --eva-chrome
```

- Vertical: the cards start 8px below the window top and end at the footer strip's top edge (footer height 32px; 0 extra gap, the strip's own padding supplies the visual 8px). Horizontal: sidebar column width W (its last 8px is the empty gutter that holds the grip), then main card, 8px gap, panel card, 8px right margin. With no panel: main extends to 8px from the right edge. With the sidebar hidden (folded or toggled): main starts 8px from the left edge.
- `fit(windowWidth, sidebar?, panel?)` from `shell-core` is the only source of widths; the renderer never computes widths itself. The layout store exposes `{ sidebarPx, panelPx, folded }` and writes `--eva-sidebar-w` and `--eva-panel-w` on the frame element. Columns use `flex: none` widths from those variables; main is `flex: 1; min-width: 0`.
- Test vectors (from README, asserted in e2e as card rects): at 1280 wide with a panel, sidebar 272, panel 420; at 1016 and above with a panel, three columns; below 1016 with a panel, sidebar folds; at 800 and 760, two cards side by side, main below 480 allowed, panel at 320 and fully inside the window.
- Cards: `background: var(--eva-c-background)`, `border: 1px solid var(--eva-c-border)`, `border-radius: var(--eva-radius)` (8), `overflow: hidden`, `box-shadow: var(--eva-shadow)`. Cards are `data-testid="main-card"` and `data-testid="panel-card"`.
- The sidebar has no card, no border and no radius: it sits on `--eva-chrome`. No divider line between sidebar and main (the gutter is the separation).
- Footer strip (`data-testid="footer"`): `padding: 0 8px`, `display: flex; align-items: center`. Left: Help ghost button (`data-testid="footer-help"`, 28px high, IconHelp 16 + label "Help" Label weight 600, tooltip "Help Center", opens the Help place). Right: an empty flex-1 slot `data-testid="footer-eregon-slot"` right-aligned, `min-width: 0`, reserved for Eregon's tabs in Phase 6. No border on the strip.
- Focal point: main card. The panel card is the secondary focus. Chrome (sidebar, footer, window) is quieter than cards because chrome uses the sidebar color and cards use the dominant color.

### Grips [CTX D-05]

One `Grip` component serves both edges (props: `edge: "sidebar" | "panel"`).
- Sidebar grip: absolutely positioned at `left: W - 8px`, width 8px, full body height (`data-testid="grip-sidebar"`). Panel grip: occupies the 8px gap between main and panel (`data-testid="grip-panel"`). Both sit above the cards (`z-index: 2`) and use `cursor: col-resize`.
- Visible bar: 2px wide, 36px tall, `border-radius: 999px`, centered, `background: color-mix(in srgb, var(--eva-c-muted-foreground) 50%, transparent)`, opacity 0 at rest, 1 on hover and while dragging (120ms fade; none under reduced motion).
- Pointer handling: `pointerdown` captures the pointer, sets `user-select: none` on `body`, calls `useOccludeBrowser()` for the duration of the drag, and drags through `fit()` so the result is always legal. The saved width is written once on `pointerup`. Double-click resets to the default (272 and 420) and writes once. Keyboard: grip is focusable (`role="separator"`, `aria-orientation="vertical"`, `aria-label` "Resize sidebar" / "Resize panel", `aria-valuenow` = width); Left and Right arrows move 16px, Shift+arrow 48px, Home resets to default.
- Drag region and no-drag: `-webkit-app-region: drag` on the sidebar header row (brand area, not its controls) and on empty tab strip space; every button, input, tab and grip is `no-drag`. The sidebar column itself is not a drag region below the header.

### Sidebar

Column (`data-testid="sidebar"`, also the element that carries `data-testid="rail"` for Phase 1 e2e fixtures): width W, `background: var(--eva-chrome)`, `color: var(--eva-chrome-text)`, `overflow: hidden`. Its inner track is 2 pages wide (`2 * (W - 8)`), pages laid out at the full width so a fold or toggle slides instead of reflowing.

Hide and show (`⌘B` and the toggle): width animates to 0 and back over 220ms `cubic-bezier(0.215, 0.61, 0.355, 1)` (Rust `SIDEBAR_TOGGLE`). Content stays at full width inside. When auto-folded by `fit`, the same animation plays. `prefers-reduced-motion` or `EVAOS_NO_MOTION=1` or e2e: 0ms.

#### Main nav page (`data-testid="sidebar-root"`)

Top to bottom, inside the sliding track's first page; `padding-top: var(--eva-sidebar-top)` (36px):

1. Header (drag region, `padding: 0 8px 8px`, gap 16):
   - Brand row: tile 36 by 36 (`--eva-nav-active-bg` fill, `--eva-nav-active-fg` icon `IconAsterisk` 16, radius `--eva-radius`), then a text stack: "EvaOS" (Heading 16/600) and "Work OS" (Label 12/400 dim).
   - Search box (`data-testid="sidebar-search"`): 36px high, `background: var(--eva-c-muted-background)`, radius `--eva-radius`, `IconSearch` 14 dim prefix, input Body 14, placeholder "Search", suffix `Kbd` "⌘F" (Label 12). Filters Recent live (case-insensitive substring on title and tag), debounced 0 ms (local list). Esc while focused and non-empty clears; Esc empty blurs.
2. Scroll region (`ScrollArea`, `data-testid="sidebar-scroll"`, `--eva-scroll-fade-bg: var(--eva-chrome)`), `padding: 0 8px`:
   - Section label "Main" (Label 12/600 dim, `padding: 8px 4px 4px`).
   - Nav rows in this order: Dashboard, Inbox, Chat, Jobs, Habits, Meetings, Calendar, Tasks, Memory, Files [CTX D-09]. Row spec below.
   - Divider (1px `--eva-chrome-border`, `margin: 8px 0`).
   - Recent group (spec below).
3. Divider (1px `--eva-chrome-border`).
4. Footer block (`data-testid="sidebar-footer"`, `padding: 8px 8px 8px`, gap 4): Setting row, Help Center row (same row spec, no counts), 8px spacer, account row, Appearance control.

Nav row spec (`data-testid="nav-<slug>"`, slug lowercase: dashboard, inbox, chat, jobs, habits, meetings, calendar, tasks, memory, files, setting, help):
- 36px high, `padding: 0 12px`, gap 8, radius `--eva-radius`, Body 14/400, `cursor: pointer`, `IconX` 16 at the left, label flex 1 truncating with ellipsis, optional count badge, optional chevron.
- Rest: transparent, `--eva-chrome-text`. Hover: `--eva-hover` fill. Active (the active tab's place is that page): `--eva-nav-active-bg` fill, `--eva-nav-active-fg` text, weight 600; `aria-current="page"`.
- Count badge (`data-testid="count-<slug>"`): Label 12/600, `tabular-nums`, `background: var(--eva-hover)` (active: `color-mix(in srgb, var(--eva-nav-active-fg) 15%, transparent)`), color inherits the row text. Rendered only when count > 0. Tasks: open todo count. Jobs: enabled and scheduled jobs count. Counts above 99 show "99+". Other rows have no count in Phase 2 (Chat working count, Inbox and Meetings pending counts arrive with their phases through the same slot).
- Chat and Meetings rows end with `IconChevronRight` 14 (dim; active: 70% of the active fg) to signal they drill into a sub-page.
- Click behavior [CTX D-10]: plain click replaces the active tab's place and pushes history; `⌘`-click opens (or switches to) a new tab. Chat and Meetings also slide the sidebar to their sub-page. A pinned active tab never navigates: the click opens another tab [CTX D-07]. Files in Phase 2 is a normal page place with a placeholder body (the panel explorer arrives in Phase 6).
- Icons (tabler; if a name is missing in the installed version, use the nearest visual match and note it in the plan): Dashboard `IconLayoutDashboard`, Inbox `IconInbox`, Chat `IconMessage`, Jobs `IconCalendarTime`, Habits `IconTimer`, Meetings `IconUsers`, Calendar `IconCalendar`, Tasks `IconListCheck`, Memory `IconBrain`, Files `IconFile`, Setting `IconSettings`, Help Center `IconHelp` [auto, CTX Discretion].

Recent group (`data-testid="recent"`):
- Toggle row `data-testid="recent-toggle"`: 36px high, `padding: 0 4px`, label "Recent" Body 14/600, `IconChevronDown` 14 dim at the right; rotates -90deg when collapsed (120ms). Open by default; open state is in memory.
- Open body: `margin-left: 12px; padding-left: 12px; border-left: 1px solid var(--eva-chrome-border)`. Rows `data-testid="recent-item"`: 28px high, `padding: 0 8px`, Label 12/400, color `--eva-chrome-text`, single line truncated, `title` attribute with the full text. Up to 8 entries, newest first, filtered by the sidebar search. In Phase 2 rows are static text (no hover fill, no pointer) because navigation to workspaces lands in Phase 3; the row component takes an optional `onOpen` so Phase 3 only passes a handler and gains hover and pointer styles.
- Empty states: search active with no hits: "No matches" (Label 12 dim, 28px row). No journal entries at all: "Nothing recent yet".
- Titles come from `eva.sidebar` (journal `## YYYY-MM-DD` headings, title text after the date).

Account menu (`data-testid="account-trigger"`): row 36px high, `padding: 0 8px`, gap 8, avatar 28 circle (`--eva-hover` fill, `IconUser` 16), label "Account" Body 14/600, `IconSelector` 14 dim at the right; opens an `EvaMenu` above the trigger (`position="top-start"`, width = trigger width, `data-testid="account-menu"`). Items (32px high, Body 14, icon 16): Settings (`IconSettings`; opens the Settings sub-page and the Settings place, same as the Setting row) and Quit (`IconPower`, `Kbd` "⌘Q" at the right; routes through the quit guard).

Appearance control (`data-testid="appearance"`): Mantine `SegmentedControl` styled with `--eva-c-tab_bar-segmented-background` track, radius `--eva-radius`, 32px high, 3 equal segments in order Light, Dark, System with `IconSun`, `IconMoon`, `IconDeviceDesktop` 14. Selected segment: `--eva-c-tab-active-background` fill, `--eva-c-tab-active-foreground` text, weight 600. Labels (Label 12) show beside icons when the sidebar content width is at least 248px; below that, icon-only with the label as `Tooltip` and `aria-label`. Segment testids: `appearance-light`, `appearance-dark`, `appearance-system`. `role="radiogroup"`, arrow keys move selection and apply immediately. Selecting persists `theme.json` `app.appearance`, applies live and sends `app.setBackground`.

#### Sub-pages (Chats, Settings, Meetings) [CTX D-08]

- Sliding: the track translates from `0` to `-(W - 8)` px over 220ms `cubic-bezier(0.215, 0.61, 0.355, 1)`. The page that is off-screen gets `visibility: hidden` and `inert` once the transition ends so it cannot take focus. Sub-page root `data-testid="sidebar-sub-<chats|settings|meetings>"`.
- Header (drag region, `padding: 0 8px 8px`, gap 8) inside the same 36px top inset:
  - Back row (`data-testid="sidebar-back"`): 32px high, `padding: 0 4px 0 4px`, gap 4, `IconChevronLeft` 16 + "Back" Body 14/400, dim, hover `--eva-hover` fill with `foreground` text. Tooltip: "Back to menu" with `Kbd` "Esc". Click and Esc slide back to the main nav; the main pane's page stays open [CTX D-08, D-12].
  - Title row: Heading 16/600 ("Chats", "Settings", "Meetings"), `padding-left: 4px`. Meetings' title is a button that, from Phase 3, opens the Meetings home; in Phase 2 it opens the Meetings page place.
  - Chats only: a 28px ghost `ActionIcon` `IconEdit` at the right of the title row, tooltip "New chat", `data-testid="chat-new"`, opens a new `chat(new)` place in a new tab (Phase 1 chat pane).
  - Chats and Meetings: search box (36px, same style as main nav), placeholder "Search chats" and "Search meetings", `data-testid="sidebar-sub-search"`. `⌘F` focuses it while the sub-page is visible.
- Body: Chats and Meetings: a `ScrollArea` with a centered dim Label placeholder line: Chats "Your chats arrive in a later update."; Meetings "Your meetings arrive in a later update." (`data-testid="sidebar-sub-empty"`). Settings: three rows listing sections, no search box.
- Settings rows (`data-testid="settings-item-<theme|chat|notifications>"`): same row spec as nav rows (36px, icon 16, label): Theme `IconPalette`, Chat `IconMessage`, Notifications `IconBell`. Active when the active tab's place is that section. Click replaces the active tab's place with `settings(section)`; `⌘`-click opens a new tab.
- Which place opens the sub-page: Chat row, Meetings row and the Setting row (or the account menu's Settings) open the sub-page and the page. After Back, the sub-page content stays rendered until the slide ends, then unmounts.

#### Folded and hidden state

- When `fit` folds the sidebar: the column animates to 0 width. The sidebar toggle in main's tab strip stays visible and gets the folded tooltip (below).
- `⌘B` or the toggle set the preferred visibility (in memory only). The folded state never changes the preference or saved width [CTX D-04].

### Main tab strip [CTX D-10]

A 40px bar at the top of the main card (`data-testid="tabbar"`), `border-bottom: 1px solid var(--eva-c-border)`, `background: var(--eva-c-background)`, `display: flex; align-items: center; gap: 4px; padding: 0 8px`. Left to right:

1. Sidebar toggle (`data-testid="sidebar-toggle"`): 28px ghost `ActionIcon`, `IconLayoutSidebar` 16. When the sidebar is hidden (preferred or folded) the strip's `padding-left` increases so this button's left edge is at window x >= 80 (`calc(var(--eva-traffic) - var(--eva-gap) - 1px)`, i.e. 71px) and the traffic lights never overlap it. When the sidebar is visible, padding-left is 8px (the lights sit over the sidebar header).
   Tooltips: sidebar visible "Hide sidebar" + `Kbd` "⌘B"; hidden by preference "Show sidebar" + "⌘B"; auto-folded: "Sidebar hidden to fit the window. Widen the window or close the panel to bring it back." (`aria-label` the same). Pressed state when visible (`aria-pressed`).
2. Pinned tabs (leftmost, before unpinned): `data-testid="tab-pinned-<id>"`, 28 by 28, icon only (the place's icon 16), no title, no close button, tooltip with the title. Active: tab-active fill and foreground; inactive: transparent, dim, hover `--eva-hover`. Radius `--eva-radius`.
3. Unpinned tabs: `data-testid="tab-<id>"`, 28px high, min-width 96, max-width 200, `padding: 0 8px`, gap 4, radius `--eva-radius`, place icon 14 + title Label 12/600 truncating + close `IconX` 14 in a 20px square hit area (`data-testid="tab-close-<id>"`, `aria-label` "Close tab"). Close shows on hover and on the active tab only. Active: `--eva-c-tab-active-background`, `--eva-c-tab-active-foreground`, plus a 1px inner `--eva-c-border` outline; inactive: transparent with `--eva-c-tab-foreground` (dim); hover: `--eva-hover`. Middle-click closes (unpinned). Tabs scroll horizontally (hidden scrollbar, the active tab scrolls into view, 120ms) when they overflow; they never shrink below 96. A Mantine `Tooltip` shows the full title when truncated.
4. New tab `+` (`data-testid="tab-new"`): 28px ghost `ActionIcon`, `IconPlus` 16, tooltip "New tab" + `Kbd` "⌘T", immediately after the last tab (it scrolls with the strip only when there is no room, else it stays adjacent). It opens a new chat place (`chat(new)`, title "New chat"; new chats never dedupe) [CTX D-07, auto].
5. Flex spacer: drag region, so the empty strip moves the window (`-webkit-app-region: drag`).
6. Panel toggle (`data-testid="panel-toggle"`): 28px ghost `ActionIcon`, `IconLayoutSidebarRight` 16, `aria-pressed` when open, tooltip "Close panel" or "Open panel" + `Kbd` "⌘⇧B". Always inside the window at 760px.

Tab title and icon by place: Dashboard, Inbox, Chat, Jobs, Habits, Meetings, Calendar, Tasks, Memory, Files, Help Center use the nav title and icon; `chat(new)` and `chat(file)`: "New chat" (Phase 4 supplies the real title) with `IconMessage`; `settings(section)`: "Settings: Theme", "Settings: Chat", "Settings: Notifications" with `IconSettings`.

Tab context menu (right-click, `EvaMenu`, `data-testid="tab-menu"`, width 200): items in order "Pin tab" (or "Unpin tab" when pinned) with `IconPin`, "Close tab" with `IconX`, "Close others" with `IconX`. "Close tab" is enabled for pinned tabs (explicit action) but `⌘W` and Close others skip pinned tabs [CTX D-07]. "Close others" is disabled when no other unpinned tab exists. Items: `tab-menu-pin`, `tab-menu-close`, `tab-menu-close-others`. Menu opens at the pointer. Esc closes it first (overlay priority).

Rules carried from the model [CTX D-07]: a place is open in at most one tab (opening it switches); closing the last tab leaves a Dashboard tab; pinned tabs stay at the left; navigating from a pinned tab opens another tab; history is 50 entries per tab; `⌘[` and `⌘]` step it.

### Page area

Below the tab strip, the active place fills the card: `flex: 1; min-height: 0`. Pages scroll inside one `ScrollArea`; the Chat place does not (virtua scrolls itself). Keep-alive: the Chat place stays mounted when another tab is active so its stream and scroll position survive, hidden with `display: none` (not unmounted). Page placeholder bodies are re-mounted per navigation.

#### Placeholder pages (Dashboard, Inbox, Jobs, Habits, Meetings, Calendar, Tasks, Memory, Files, Help Center)

Root `data-testid="page-<slug>"`. Content is centered horizontally with `max-width: 720px`, `padding: var(--eva-space-3xl) var(--eva-space-lg) var(--eva-space-lg)`. Vertical stack, gap 16, left-aligned text:
- Icon tile 48 by 48 (`IconX` 24, `--eva-c-secondary-background` fill, 1px `--eva-c-border`, radius `--eva-radius`).
- Title: Display 20/600, the page title ("Dashboard", "Inbox", "Jobs", "Habits", "Meetings", "Calendar", "Tasks", "Memory", "Files", "Help Center").
- Description: Body 14, `--eva-c-muted-foreground`.
- Dashboard shows the cue-ready structure only (no cards yet); Phase 3 replaces the body.

#### Chat page

The Phase 1 chat pane (header 40px, log, composer stub) fills the page unchanged, including its empty state ("No messages yet / Resume a session to see its messages here."). Its header loses `-webkit-app-region: drag` (the tab strip above is the drag surface) and its 1px bottom border now uses `--eva-c-border`.

#### Panel card

Hosts the Phase 1 `BrowserPanel` as-is: tab strip 36, address row 40, loading bar 2px, `browser-slot`. Remove its own `border-left`. Default open [auto] so the Phase 1 e2e specs pass unchanged. Open state is in memory. Closing the panel hides the view through the existing slot sync (`visible=false`); reopening restores bounds.

### Settings (SETT-01) [CTX D-08, rust: settings.rs]

Place `settings(section)` renders inside the page scroll area, content column `max-width: 720px`, `padding: 24px`, gap 16 (`data-testid="settings-<section>"`). Each section starts with Display 20/600 title and a Body 14 dim description.

| Section | Title | Description | Body |
|---------|-------|-------------|------|
| Theme | Theme | Colors, fonts and shape for the whole app. | Card with a row "Appearance" (Body 14/600) + helper "Light, Dark or System. System follows your Mac." and the same Appearance control (`data-testid="appearance-settings"`, always icon + label). Below, a placeholder card: title "Theme editor" (Heading 16/600) and "Editing colors, fonts and shape arrives in a later update." |
| Chat | Chat | What conversations show besides Eva's replies. | A card (1px `--eva-c-border`, radius `--eva-radius`, `--eva-c-secondary-background` fill, rows 16px padding, 1px divider between) with two switch rows |
| Notifications | Notifications | How the inbox tells you about new items. | Placeholder card: title "Notification settings" and "Delivery, quiet hours and digests arrive in a later update." |

Chat switch rows (Mantine `Switch`, size md, right-aligned, label column left; the whole row is the click target; `role="switch"`):
- "Show thinking" / "The model's reasoning before each reply, in gray." (`data-testid="settings-show-thinking"`)
- "Show tool details" / "Each tool call's input and output as code, like omp in a terminal. Off, a run of tools folds to one line." (`data-testid="settings-show-tools"`)

Switch spec: track 40 by 24 (Mantine `size="md"` rounded to these via theme), thumb 16. Off: `--eva-c-switch-background`; on: `--eva-c-primary-background` with thumb `--eva-c-primary-foreground`. 120ms transition. The value writes `settings.json` immediately (`show_thinking`, `show_tools` booleans) through the config store; failures show the error copy below and revert the switch. Defaults: both on [auto, matches an everything-visible default so nothing is hidden before Phase 4 exists].

### Scroll areas (SHEL-06) [CTX D-06]

One `ui/ScrollArea` wrapper (props: `fadeBg?`, `scrollKey?`, `className`):
- Mantine `ScrollArea` with `type="hover"`, `scrollbarSize={8}`, `offsetScrollbars={false}`; thumb `--eva-scroll-thumb` (hover `--eva-scroll-thumb-hover`), track transparent, thumb radius 999px, 120ms fade; `overscroll-behavior: contain` on the viewport.
- Continuation fades: two 16px absolutely positioned overlays at the top and bottom of the viewport, `pointer-events: none`, `linear-gradient(to bottom, var(--eva-scroll-fade-bg), transparent)` (bottom inverted). The top fade shows when `scrollTop > 0`, the bottom fade when `scrollTop + clientHeight < scrollHeight - 1`; 120ms opacity. They expose `data-fade-top="true|false"` and `data-fade-bottom="true|false"` on the wrapper root (`data-testid` supplied by the caller, e.g. `sidebar-scroll`, `page-scroll`).
- Per-place memory: `scrollMemory` store keyed by the tab's place key (`page:<slug>`, `settings:<section>`, later `workspace:<id>`). Save `scrollTop` on scroll (rAF-throttled), restore on mount in a layout effect before paint. The Chat log is excluded (own virtua scroll).
- Used for: sidebar middle region, Chats and Meetings lists, page bodies, Settings, menus taller than 320px (menu max-height 320).

### Motion and entrance animation (SHEL-07 shell part) [CTX D-17, rust: motion.rs]

- Easing for every cue and the sidebar slide: `cubic-bezier(0.215, 0.61, 0.355, 1)` (ease-out-cubic). Rise distance `--eva-cue-rise: 10px`. Only `opacity` and `transform` animate.
- Cue timings in seconds at `SPEED` 2 (video time divided by 2). Each cue is two variables, `--eva-cue-<name>-delay` and `--eva-cue-<name>-duration`; staggered cues also `--eva-cue-<name>-step`:

| Cue (class `.eva-cue-<name>`) | Delay | Duration | Step | Effect |
|-------------------------------|-------|----------|------|--------|
| sidebar | 0 | 0.150 | n/a | fade only |
| hero | 0.050 | 0.200 | n/a | fade and rise |
| sections | 0.150 | 0.175 | n/a | fade and rise |
| first-card | 0.500 | 0.150 | n/a | fade and rise |
| first-chart | 0.550 | 0.350 | n/a | fade and rise |
| second-card | 0.925 | 0.150 | n/a | fade and rise |
| second-chart | 0.975 | 0.225 | n/a | fade and rise |
| grid-cards | 1.225 | 0.200 | 0.075 | fade and rise, item `--i` index |
| aside-title | 1.500 | 0.150 | n/a | fade and rise |
| aside-rows | 1.550 | 0.150 | 0.050 | fade and rise, item `--i` index |
| stats-title | 1.600 | 0.150 | n/a | fade and rise |
| stat-cards | 1.750 | 0.150 | 0.040 | fade and rise, item `--i` index |

  Total settles at 1.975 s (3.95 / 2). CONTEXT D-17 states "3.95 s at SPEED 2"; the Rust source defines `TOTAL = 3.95 / SPEED = 1.975 s`, and the table above follows the source. The e2e budget is therefore 2.0 s, not 3.95 s [auto, flagged].
- Mechanism: `.eva-cue-<name>` sets `animation: eva-cue <duration> <ease> calc(delay + var(--i, 0) * step) both` where `@keyframes eva-cue` goes from `opacity: 0; transform: translateY(var(--eva-cue-rise))` to `opacity: 1; transform: none` (the sidebar uses `eva-fade`, opacity only). `fill-mode: both` keeps the element hidden during its delay.
- Phase 2 attaches only `.eva-cue-sidebar` (on the sidebar root). Phase 3 attaches the rest to Dashboard cards. A module-level `playedThisLaunch` flag (not persisted) plays the timeline once per launch on the first shell render and then sets `data-eva-played="true"` on `html`; the classes are only applied while the flag was unset at mount, so navigation shows settled pages and workspace pages never animate.
- Off switch: `html[data-eva-motion="off"]` sets every delay, duration and step to 0s and `animation: none`. It is set when `app.info` reports `e2e`, when `EVAOS_NO_MOTION=1`, or when `prefers-reduced-motion: reduce` matches (also honored live via `matchMedia`). One e2e test launches with motion on and asserts `[data-testid=sidebar]` computed opacity starts below 1 and reaches 1 within 2.0 s.
- Other transitions (all disabled by the same switch): sidebar slide and width 220ms; grip bar 120ms; scroll fades 120ms; chevron rotation 120ms; switch 120ms; menu and popover open 120ms opacity, close instant; modal 120ms opacity.
- No spring, glow, slide-in for tabs or page transitions.

### Interaction states and keyboard

- Hover: `--eva-hover` fill. Pressed: no scale or shift. Disabled: opacity 0.4, `aria-disabled`. Cursor: pointer on rows, tabs, buttons; `col-resize` on grips; default elsewhere.
- Focus-visible: 2px `--eva-c-primary-background` outline, offset 2px, on every focusable element. Tab order: sidebar (search, nav rows, Recent toggle, footer rows, account, appearance) then tab strip (sidebar toggle, tabs, `+`, panel toggle) then page content, then panel chrome, then footer Help.
- Roving: nav rows are plain buttons in tab order (not roving) [auto]. Tabs are `role="tablist"` / `role="tab"` with Left and Right arrow navigation and `Enter` to activate.
- Esc is one `dismiss` action over the ordered stack: open overlay or menu, global search (Phase 6), Eregon (Phase 6), then the sidebar sub-page's Back. Nothing on the stack: Esc does nothing and is not swallowed from the page [CTX D-12].

### Hotkeys (SHEL-05) [CTX D-11, D-14]

One `HotkeyRouter` (single capture-phase `window` keydown, scopes overlay > terminal > page > global). Chord strings `cmd+shift+b`, `escape`, `cmd+[`. Every chord is visible in the UI through `Kbd` chips or tooltips where a control exists.

| Chord | Action id | Phase 2 behavior |
|-------|-----------|------------------|
| `⌘N` | `new-todo` | stub (logged) |
| `⌘R` | `reload` | refreshes sidebar counts and Recent (`eva.sidebar`) |
| `⌘B` | `toggle-sidebar` | toggles preferred sidebar visibility |
| `⌘⇧B` | `toggle-panel` | opens or closes the right panel |
| `⌘J` | `toggle-eregon` | stub |
| `⌘K` | `toggle-search` | stub |
| `⌘F` | `focus-search` | focuses the visible sidebar search box (main nav or sub-page); if the sidebar is hidden, shows it first (preference on) then focuses |
| `⌘T` | `new-tab` | new chat tab |
| `⌘W` | `close-tab` | closes the focused browser subtab when the panel has focus, else the active unpinned main tab; skipped for pinned tabs |
| `⌘[` / `⌘]` | `history-back` / `history-forward` | active tab history |
| `⌘S` | `save` | stub (Phase 6 Files) |
| `⌘1` to `⌘9` | `pick-model-1..9` | stubs |
| `⌘⇧C` | `copy-page-url` | stub |
| `Esc` | `dismiss` | stack above |
| `⌘Q` | `quit` | quit guard path |

In e2e (`EVAOS_E2E=1`) each dispatched action id is appended to `window.__evaosHotkeys` (ring buffer, 200 entries, entries `{ chord, action, at }`).

### Overlay wrappers [CTX D-13]

`renderer/overlay/` exports `EvaModal`, `EvaMenu`, `EvaPopover`, `EvaDrawer`. All: call `useOccludeBrowser()` while open, `withinPortal`, `zIndex: 300`, `closeOnEscape: false` (the router's dismiss stack handles Esc via `useDismissable(priority)`), `transitionProps: { duration: 120 }` (0 under the motion-off switch), radius `var(--eva-radius)`.

| Wrapper | Spec |
|---------|------|
| `EvaModal` | centered, width 400 default (prop override), padding 16, backdrop `rgb(0 0 0 / 0.5)` no blur, header Heading 16/600, close `ActionIcon` 28 top-right with `aria-label` "Close", surface `--eva-popover-bg`, 1px `--eva-c-border`, `box-shadow: var(--eva-shadow)` |
| `EvaMenu` | surface `--eva-popover-bg`, text `--eva-popover-fg`, 1px `--eva-c-border`, padding 4, item height 32, `padding: 0 8px`, gap 8, Body 14, hover `--eva-hover`, divider 1px `--eva-c-border`, `max-height: 320px` scrolling inside, default width 220 |
| `EvaPopover` | same surface as menu, padding 8, arrow off, offset 4 |
| `EvaDrawer` | edge sheet, width 400, same surface, no extra backdrop blur; unused until Phase 6 but exported and covered by the lint test |

A Vitest test scans `apps/desktop/src/renderer` and fails on `Modal`, `Menu`, `Popover` or `Drawer` imported from `@mantine/core` outside `renderer/overlay`. The Phase 1 Import Arc confirmation moves onto `EvaModal`. The e2e overlay proof uses the account menu (or a hidden test hook that opens a wrapper-based test overlay) while asserting the browser view reports `visible=false`.

### Quit guard (SHEL-08) [CTX D-18]

Native `dialog.showMessageBox`, type `question`, triggered by window `close` and `before-quit` when `app.unsavedEdits` returns entries. `defaultId: 0` (Save), `cancelId: 2` (Cancel), `noLink: true`. Copy in the Copywriting table. Save runs every registered `save` in order; if any fails, the app stays open and a second box lists the failure. Discard proceeds. Cancel aborts the close or quit. No dialog when nothing is dirty.

---

## Copywriting Contract

No em dashes. Sentence case. No exclamation marks. Placeholders say what arrives, not when.

| Element | Copy |
|---------|------|
| Primary CTA (phase) | New chat (tooltip on the Chats sub-page icon button and `+` tab action) |
| Brand | EvaOS / Work OS |
| Main nav section label | Main |
| Nav labels | Dashboard, Inbox, Chat, Jobs, Habits, Meetings, Calendar, Tasks, Memory, Files, Setting, Help Center |
| Sidebar search placeholders | Search (main nav) / Search chats / Search meetings |
| Recent group label | Recent |
| Recent empty (filter) | No matches |
| Recent empty (no entries) | Nothing recent yet |
| Count badge overflow | 99+ |
| Back row | Back (tooltip: Back to menu) |
| Sub-page titles | Chats, Settings, Meetings |
| New chat tooltip | New chat |
| Chats list placeholder | Your chats arrive in a later update. |
| Meetings list placeholder | Your meetings arrive in a later update. |
| Settings sections | Theme, Chat, Notifications |
| Account row | Account |
| Account menu items | Settings, Quit |
| Appearance labels | Light, Dark, System |
| Appearance group aria-label | Appearance |
| Sidebar toggle tooltips | Hide sidebar / Show sidebar / Sidebar hidden to fit the window. Widen the window or close the panel to bring it back. |
| Panel toggle tooltips | Close panel / Open panel |
| New tab tooltip | New tab |
| Tab close aria-label and tooltip | Close tab |
| Tab context menu | Pin tab, Unpin tab, Close tab, Close others |
| Settings tab titles | Settings: Theme, Settings: Chat, Settings: Notifications |
| New chat tab title | New chat |
| Grip aria-labels | Resize sidebar / Resize panel |
| Footer Help | Help (tooltip: Help Center) |
| Dashboard placeholder description | Your workspaces, activity and open todos will appear here in a later update. |
| Inbox placeholder description | Digests and approvals from Eva will appear here in a later update. |
| Jobs placeholder description | Scheduled jobs and their runs will appear here in a later update. |
| Habits placeholder description | Your habits and streaks will appear here in a later update. |
| Meetings placeholder description | Meetings and their notes will appear here in a later update. |
| Calendar placeholder description | Your calendar will appear here in a later update. |
| Tasks placeholder description | Your open todos will appear here in a later update. |
| Memory placeholder description | Eva's memory will appear here in a later update. |
| Files placeholder description | Browse and edit files from here in a later update. |
| Help Center placeholder description | Guides and shortcuts will appear here in a later update. |
| Settings Theme title / description | Theme / Colors, fonts and shape for the whole app. |
| Settings Theme appearance row | Appearance / Light, Dark or System. System follows your Mac. |
| Theme editor placeholder | Theme editor / Editing colors, fonts and shape arrives in a later update. |
| Settings Chat title / description | Chat / What conversations show besides Eva's replies. |
| Show thinking | Show thinking / The model's reasoning before each reply, in gray. |
| Show tool details | Show tool details / Each tool call's input and output as code, like omp in a terminal. Off, a run of tools folds to one line. |
| Settings Notifications title / description | Notifications / How the inbox tells you about new items. |
| Notifications placeholder | Notification settings / Delivery, quiet hours and digests arrive in a later update. |
| Empty state (main with no tabs) | never shown: closing the last tab opens Dashboard |
| Error: settings save failed | Could not save your settings. Check that the EvaOS config folder is writable, then try again. (toast, `--eva-c-danger-background` accent bar) |
| Error: layout file unreadable | Layout was reset to defaults. (toast, once per launch, shown only if a malformed `layout.json` was replaced) |
| Error: sidebar data failed | Could not read counts or recent items. Press the refresh shortcut to try again. (Label dim under the counts region; Tasks and Jobs badges hidden) |
| Quit guard message | You have unsaved changes |
| Quit guard detail | {labels, one per line, up to 5, then "and {k} more"} / Save them before EvaOS closes, or discard them. Cancel keeps EvaOS open. |
| Quit guard buttons | Save / Discard / Cancel |
| Quit guard save failure (message box, button OK) | Could not save {label}. EvaOS stays open so nothing is lost. |
| Destructive confirmation | Discard (quit guard): Discard permanently drops every unsaved edit, confirmed by the native dialog above. No other destructive action in Phase 2; "Close tab" and "Close others" do not delete data and need no confirmation. |
| Test overlay (e2e hook only) | Test overlay / The browser view is hidden while this is open. / Close |

Accessibility copy: every icon-only control has an `aria-label` equal to its tooltip text (sidebar toggle, panel toggle, `+`, close x, grips, new chat, theme segments when icon-only). The sidebar root is `<nav aria-label="Main">`, the tab strip `role="tablist"` with `aria-label` "Open pages", the sub-page region `aria-label` "Chats", "Settings" or "Meetings".

---

## Test and Proof Contract

### `data-testid` hooks (ship exactly these)

| `data-testid` | Element |
|---------------|---------|
| `shell` | Frame root (row + footer) |
| `sidebar`, `rail` | Sidebar column (`rail` kept for Phase 1 fixtures) |
| `sidebar-root`, `sidebar-sub-chats`, `sidebar-sub-settings`, `sidebar-sub-meetings` | Sidebar pages |
| `sidebar-search`, `sidebar-sub-search`, `sidebar-scroll`, `sidebar-footer` | Search boxes and regions |
| `nav-dashboard` ... `nav-files`, `nav-setting`, `nav-help` | Nav rows |
| `count-tasks`, `count-jobs` | Count badges |
| `recent`, `recent-toggle`, `recent-item` | Recent group, toggle, entries |
| `sidebar-back`, `chat-new`, `sidebar-sub-empty` | Sub-page controls |
| `settings-item-theme`, `settings-item-chat`, `settings-item-notifications` | Settings sub-page rows |
| `account-trigger`, `account-menu` | Account menu |
| `appearance`, `appearance-light`, `appearance-dark`, `appearance-system`, `appearance-settings` | Appearance control (sidebar and Settings) |
| `main-card`, `panel-card` | Cards |
| `grip-sidebar`, `grip-panel` | Grips |
| `tabbar`, `sidebar-toggle`, `panel-toggle`, `tab-new` | Tab strip chrome |
| `tab-<id>`, `tab-pinned-<id>`, `tab-close-<id>` | Tabs (`<id>` stable tab id) |
| `tab-menu`, `tab-menu-pin`, `tab-menu-close`, `tab-menu-close-others` | Tab context menu |
| `page-<slug>` | Placeholder page roots |
| `page-scroll` | Page scroll area (with `data-fade-top` and `data-fade-bottom`) |
| `settings-theme`, `settings-chat`, `settings-notifications` | Settings section roots |
| `settings-show-thinking`, `settings-show-tools` | Chat switches |
| `footer`, `footer-help`, `footer-eregon-slot` | Footer |
| `overlay-open`, `overlay-test` | Test overlay hook (kept from Phase 1, no visible button) |

Existing Phase 1 ids (`chat-log`, `msg-*`, `pill-*`, `composer-*`, `browser-panel`, `browser-slot`, `tab-*` inside the browser panel, `nav-back` etc.) keep their names. Collision rule: main-tab ids use the prefix `tab-` followed by the numeric main tab id, and browser panel tab ids stay `browser-tab-<id>`. If Phase 1 specs select `tab-<id>` for browser tabs, rename those selectors in the same plan [CTX Discretion].

Required state attributes for assertions: `data-active="true"` on the active nav row, active tab and active settings row; `data-sidebar-state="open|hidden|folded"` on `shell`; `data-appearance="light|dark|system"` and `data-resolved="light|dark"` on `html`; `data-eva-motion="on|off"` on `html`; `data-sidebar-level="root|chats|settings|meetings"` on `sidebar`.

### Proof screenshots (`proof/phase-2/`, each paired with a state assertion, composited with `proofShot`)

| File | State | Viewport | Assertion |
|------|-------|----------|-----------|
| `shell-dark-1280x800.png` | Dark, sidebar and panel open, Chat page | 1280 by 800 | `data-resolved="dark"`, sidebar width 272, panel width 420 |
| `shell-light-1280x800.png` | Light, same state | 1280 by 800 | `data-resolved="light"`, `--eva-c-background` is #f3f3f1 |
| `shell-folded-dark-760x720.png` | Dark, folded sidebar, two cards | 760 by 720 | `data-sidebar-state="folded"`, `sidebar-toggle` left >= 80, panel inside window |
| `shell-folded-light-760x720.png` | Light, folded | 760 by 720 | same as above, light |
| `shell-wide-dark-1440x900.png` | Dark, wide | 1440 by 900 | sidebar 272, main fills the rest, panel 420 |
| `shell-wide-light-1440x900.png` | Light, wide | 1440 by 900 | light resolved |
| `tabs-pinned-menu.png` | Three tabs, one pinned, tab context menu open (browser hidden) | 1280 by 800 | pinned tab has no close button, `tab-menu` visible, browser view `visible=false` |
| `sidebar-subpage-settings.png` | Sidebar slid to Settings | 1280 by 800 | `data-sidebar-level="settings"`, Back visible |
| `sidebar-subpage-chats.png` | Chats sub-page with search | 1280 by 800 | placeholder line visible |
| `settings-chat.png` | Settings: Chat with both switches | 1280 by 800 | both switches checked |
| `settings-theme-light.png` | Settings: Theme, light | 1280 by 800 | appearance control `appearance-light` selected |
| `appearance-live-switch.png` | After a live Dark to Light switch | 1280 by 800 | same DOM node count, the same `sidebar` node, changed computed background |

Order of capture per scheme: set `appearance` through the control (not by editing files) so the proof also exercises the control. Both light and dark runs use `EVAOS_E2E=1` (motion off) except the single motion test.

### Verifiable assertions (e2e and unit)

- 139 distinct `--eva-c-*` properties on `html` after apply; switching mode keeps the same names and changes the values; React element identity and DOM node identity survive a switch.
- `fit` test vectors (wide, panel yields first, sidebar folds, 760 and 800 reflow) pass in Vitest and match e2e card rects within 1px.
- Every chord in the Hotkeys table appears in `window.__evaosHotkeys` after being sent; Esc pops overlays before the sidebar Back.
- Em-dash lint passes on all new strings.

---

## Extension Points for Phases 3 to 7

- **Phase 3 (Dashboard, Workspaces, Jobs, Habits, Meetings, Calendar):** replace the placeholder body of each `page-<slug>` and attach `.eva-cue-*` classes to Dashboard cards, rows and stats using the existing variables; register `workspace(id)`, `board(slug)` and `meeting(stem)` places (tab model unchanged); pass `onOpen` to Recent rows; fill the Meetings sub-page body; feed Meetings and Inbox counts through the count badge slot.
- **Phase 4 (Chat):** fill the Chats sub-page list body and search; register `chat(sessionFile)` places and real tab titles, plus the working dot (`--eva-c-success-background`) in tab and nav slots; read `settings.json` `show_thinking` and `show_tools`.
- **Phase 5 (rendering):** consumes `--eva-font-code`, code and syntax variables once Phase 7 adds syntax tokens; message surfaces already read `--eva-c-*` aliases.
- **Phase 6 (panel, search, terminal, Eregon, Files):** the panel card is the container for the launcher and tools; the footer's `footer-eregon-slot` hosts Eregon's tabs; register the terminal hotkey scope with the pass-through list, Files dirty entries through `registerDirty`, and global search and Eregon dismissers on the Esc stack; Files nav row becomes the panel explorer.
- **Phase 7 (theme editor, notifications):** replace the Theme and Notifications placeholder cards inside the same section roots; write edits through `theme-core` `ThemeDoc` (`light.edits`, `dark.edits`, `shared`, `app`); all colors, fonts, radius and shadow already flow from the applier, so no component changes; add kit presets and Apache-2.0 license notice at that time.
- Variable and class names, testids and the overlay wrappers in this file are the stable surface; do not rename them in later phases.

---

## Registry Safety

| Registry | Blocks Used | Safety Gate |
|----------|-------------|-------------|
| shadcn official | none (shadcn not used) | not applicable |
| third-party | none | not applicable |

No component registry is used. Runtime dependencies added in this phase (none expected beyond Phase 1's stack: Mantine, `@tabler/icons-react`, zustand, zod) are vetted by version pin in the plan. The bundled theme data (EvaOS Light and Dark) is copied from the local Rust repo; the gpui-component default theme values used for the kit base are Apache-2.0 data and are converted by a local script, not fetched at runtime.

---

## Auto-selected Decisions (unattended run)

| Question | Auto-selected answer | Basis |
|----------|----------------------|-------|
| UI font | Theme `font.family` "IBM Plex Mono" with system stack fallback, via `--eva-font-ui` | Bundled themes set it for UI; Rust parity; Phase 1 had only a system stack |
| Accent in the neutral palette | `--eva-accent` = `primary.background` (near-white on dark, near-black on light); outline uses it instead of `ring` | Bundled themes are locked (D-15); `ring` fails 3:1 |
| Active nav row style | Filled with `sidebar.primary.background` and its foreground, weight 600 | `sidebar.rs` does the same with primary |
| 11px badge size | 12px Label | Keep exactly four sizes |
| Medium weight | Maps to 600 | Keep exactly two weights |
| Sidebar top inset | 36px | Rust 34, snapped to the 4 grid |
| Tab strip height | 40px | Matches Phase 1 chat header |
| Footer strip height | 32px | No Rust value found in the shell sources read |
| Entrance total | 1.975 s, e2e budget 2.0 s | Rust `TOTAL = 3.95 / SPEED`; CONTEXT text says 3.95 s |
| Panel default state | Open | Phase 1 e2e specs expect the browser panel |
| `+` and `⌘T` target | A new chat place | Tab model: new chats never dedupe, so `+` always adds a tab |
| Appearance default | `system` | Matches the three-way control; avoids a flash on light systems |
| Help in two places | Footer Help button and sidebar "Help Center" row both open the Help Center place | D-03 puts Help in the footer; D-09 lists Help Center in the nav |
| Account row | Generic "Account" label with icon avatar | Avoids reading or hardcoding the user's name |
| Settings switch defaults | Both on | Nothing hidden before Phase 4 consumes them |
| Close others label | "Close others" | README wording |
| Recent rows in Phase 2 | Static (no navigation) | Workspace pages are Phase 3; Rust only links when a workspace exists |
| Tab icon names | Tabler equivalents listed above, nearest match if a name is missing | CTX Claude's Discretion |
| Cue class set in Phase 2 | Only `sidebar` attached | Remaining cues belong to Phase 3 Dashboard |
| Code font size | Label 12 in components; theme 13 stored as a variable | Keep four sizes |

---

## Checker Sign-Off

- [ ] Dimension 1 Copywriting: PASS
- [ ] Dimension 2 Visuals: PASS
- [ ] Dimension 3 Color: PASS
- [ ] Dimension 4 Typography: PASS
- [ ] Dimension 5 Spacing: PASS
- [ ] Dimension 6 Registry Safety: PASS

**Approval:** pending
