---
phase: 4
slug: chat-parity
status: draft
shadcn_initialized: false
preset: none
created: 2026-10-15
---

# Phase 4 - UI Design Contract

> Visual and interaction contract for chat parity: sidebar chat list, composer toolbar, question cards, subagent chips, background jobs strip, writer-conflict prompt, image viewer, Settings > Chat additions.
> Extends `01-UI-SPEC.md` and `02-UI-SPEC.md`. Anything not restated here keeps its Phase 1/2 value (tokens, spacing scale, 4 sizes, 2 weights, overlay rules, focus rule, accent list).
> Provenance: [CTX] 04-CONTEXT.md locked, [P1]/[P2] earlier specs, [rust] read-only Rust app behavior (status wording, menu order), [auto] default chosen (unattended).
> Copy rule: no em dashes, sentence case, no exclamation marks.

---

## Design System

| Property | Value |
|----------|-------|
| Tool | none (Mantine fixed; shadcn not applicable) [P1] |
| Preset | not applicable |
| Component library | Mantine 9.7 primitives. `Modal`, `Menu`, `Popover`, `Drawer` only via `renderer/overlay` wrappers (`EvaModal`, `EvaMenu`, `EvaPopover`, `EvaDrawer`) [CTX, P2]. Drag and drop with `@dnd-kit/core` + `@dnd-kit/sortable` [CTX]. |
| Icon library | `@tabler/icons-react`, stroke 1.5, 16px in rows and toolbar, 14px inline [P2] |
| Font | `var(--eva-font-ui)`; code and tool output `var(--eva-font-code)` [P2] |
| Token mechanism | Only `var(--eva-*)` / `--eva-c-*`; no hex or raw px in component files except constants listed below [P2] |

---

## Spacing Scale

Scale unchanged (4, 8, 16, 24, 32, 48, 64 as `--eva-space-*`).

Phase 4 constants (multiples of 4 unless marked). Non-scale values below (12px padding and chip radius, 20px badge/ring, 28px rows, 36px option rows, 56px text area, 2px lines, 1px rule) are component dimensions, not spacing-scale values.

| Constant | Value | Notes |
|----------|-------|-------|
| Chat row height | 28px | Matches Recent row [P2]; status icon 16px at left, title flex, trailing slot for count/status text |
| Group header height | 32px | Chevron 14px, name Label 600, count badge 20px |
| Row indent under header | 8px | Plus 1px `--eva-c-sidebar-border` rule |
| Show N more row | 28px | Label 12px 400, `muted-foreground` |
| Drop indicator | 2px line | `--eva-c-primary-background`, inside drop target |
| Composer | min 2 lines (56px text area), max 8 lines then internal scroll | Padding 12px horizontal (inner-padding exception), 8px vertical; radius `--eva-radius-lg` |
| Composer toolbar row | 32px high, gap 8px | Controls 28px |
| Context ring | 20px diameter, 2px stroke | |
| Question card | padding 16px, gap 8px between options, option row height 36px | Max width = chat column; margin 8px vertical |
| Subagent chip | height 24px, padding 0 8px, gap 4px, radius 12px | Strip wraps, gap 8px |
| Jobs strip | height 32px collapsed, rows 28px expanded (max 4 visible then scroll) | Sits directly above composer |
| Image thumbnail in chat | max 240 by 240px, radius `--eva-radius` | Pasted-image chips in composer: 48 by 48px |
| Image viewer | `EvaModal` size 90vw by 90vh, image `object-fit: contain` | |
| Writer prompt modal | width 400px | |

---

## Typography

Exactly 4 sizes, 2 weights (unchanged) [P2]:

| Role | Size | Weight | Line Height | Phase 4 usage |
|------|------|--------|-------------|---------------|
| Body | 14px | 400 | 1.5 | Composer input, question text and options, menu items, settings row text, modal body |
| Label | 12px | 600 (400 where stated) | 1.4 | Chat row title (400, 600 when active), group headers, status text (400), subagent chips, jobs strip, toolbar control labels, context ring tooltip, kbd chips, tool details (mono) |
| Heading | 16px | 600 | 1.2 | Modal titles, question card header (when multi-question) |
| Display | 20px | 600 | 1.2 | Settings section titles only (no new Display use) |

Tabular figures for counts, context percentage, Show N more.

---

## Color

Roles per `02-UI-SPEC.md` (dominant `--eva-c-background`, secondary `--eva-c-sidebar-background`, composer and cards `--eva-c-secondary-background`, hover `--eva-c-accent-background`).

Status mapping (dots and icons, never small text on page background in light mode) [auto]:

| Status row | Indicator | Variable |
|------------|-----------|----------|
| Working | 8px dot, pulsing (disabled under reduced motion) | `--eva-c-success-background` |
| Needs approval | 8px dot | `--eva-c-warning-background` |
| Has a question | 8px dot | `--eva-c-warning-background` plus question icon |
| Open | hollow 8px ring | `--eva-c-muted-foreground` |
| Job | 14px icon | `--eva-c-muted-foreground` |
| Error or failed send | banner border and 14px icon | `--eva-c-danger-background` |

Accent (10%, `--eva-c-primary-background`) reserved for, in addition to the P2 list:
1. Selected option and keyboard-focused option in a question card (outline, not fill).
2. Send button fill in the composer when enabled.
3. Drop indicator line during chat drag and drop.
4. Context ring progress arc below 80%.

Context ring at or above 80% uses warning, at or above 95% uses danger. Never accent: status dots, chips, group headers, row hover, menu items.

Destructive: `--eva-c-danger-background` used only on the Delete menu item text/icon and the confirm button of the delete dialog (dialog confirm uses danger fill with `foreground` text meeting 4.5:1; if not, use outlined danger).

---

## Layout and Interaction Contract

### Sidebar Chats sub page (CHTP-01..05)
- Order top to bottom: search box (36px), Pinned section, then groups. Within every group: running chats first, then newest first; five visible plus `Show N more` (toggles to `Show fewer`).
- Groups are collapsible (chevron rotates 90deg, 120ms); collapsed state persists to `chat.json`. Default groups per workspace; custom categories render as groups with a drag grip appearing on hover.
- Search: filters by title as typed (debounce 100ms); while query is non-empty every group is expanded in full, includes archived chats (archived rows show an `Archived` label chip, 12px 400), and `Show N more` is hidden. Esc or clear returns to prior collapse state. No match: empty state below.
- Row: status indicator, title (single line, ellipsis, full title in Tooltip after 600ms), trailing slot shows status text for non-open states: `Working`, `Needs approval`, `Question`, `Job running` [rust wording, confirm against README at implement time]. Active row uses `sidebar-primary` fill [P2].
- Drag: whole row is the handle with 4px activation distance; keyboard drag via dnd-kit KeyboardSensor (Space to lift, arrows, Space to drop, Esc cancel). Dragging a group header reorders headers; dragging a chat onto a group moves it. Dragged item gets 0.6 opacity and raised background; announcements through dnd-kit live region.
- Right-click menu via `EvaMenu`, order [rust]: Rename, Pin / Unpin, Archive / Unarchive, Move to (submenu: categories plus `New category`), divider, Delete. Also reachable with the `...` ActionIcon on row hover/focus and Shift+F10.
- Rename: inline TextInput replacing the title; Enter commits, Esc cancels, blur commits. Empty value cancels.
- New category: header-level `+` ActionIcon (28px) opens inline input at the list end; header context menu offers Rename category and Delete category (chats move back to their workspace group, no chat is deleted).
- List updates within 500 ms of file change; changed rows animate background fade 300ms (none under reduced motion). Scroll position and focus are preserved across updates.

### Composer (CHTP-06, CHTP-13)
- Focal point: the chat log is the default focal point; when a question is pending, the pinned question card above the composer is the focal point (it takes the first focus stop after the log).
- Two-line box: auto-growing textarea above a 32px toolbar. Enter sends, Shift+Enter newline, Cmd+Enter also sends. While the process is streaming, Send becomes `Stop` (square icon) and Enter queues nothing; behavior follows existing `Composer.tsx`.
- Toolbar left to right: attach image ActionIcon, model picker (`EvaPopover` list, shows current model name, Label 12px, truncated at 160px), access mode picker (segmented popover, label of current mode), omp account selector (visible only on unsent chats; hidden once the first prompt is sent), spacer, context ring (Tooltip: `Context {n}% used`), Send.
- Image paste and drop: paste of clipboard images and file drop onto composer adds thumbnail chips (48px, remove x button 20px, alt text `Pasted image {n}`). Drop target state: 2px dashed `--eva-c-primary-background` border and overlay text `Drop images to attach`. Non-image files are rejected with an inline notice below the toolbar.
- Disabled states: all toolbar controls disabled with 0.5 opacity and `aria-disabled` while the session is closed or starting.

### Question cards (CHTP-08)
- One card per blocked `ask`, rendered in the log flow at the position of the request, and also pinned above the composer while unanswered.
- Content: question text (Body), then single-choice option rows numbered `1` to `4` with Kbd chip at left. Options beyond four show without hotkeys and are reachable by arrow keys. Selecting an option answers immediately (no separate submit); the card then collapses to a one-line answered summary `Answered: {option}`.
- Hotkeys: keys `1` to `4` answer while the composer is not focused and no text input has focus; ignored inside terminal and inputs. Arrow Up/Down move focus, Enter selects. Role `radiogroup` with `aria-label` of the question.
- Extension UI requests: `select` renders as the same card; `confirm` renders two buttons (`Confirm`, `Decline`; initial focus `Decline`); `input` renders TextInput plus `Send answer`; `editor` renders a multi-line textarea (min 4 rows, mono) plus `Send answer` and `Discard input`. `Decline` and `Discard input` send the RPC cancel frame.
- Unanswerable (process exited): card dims, options disabled, caption `This question can no longer be answered.`

### Subagent chips and jobs strip (CHTP-09)
- Chips sit in a wrapping row between the log and the jobs strip. Running chip: spinner 12px, name; finished chip: check icon 12px, name, `muted-foreground`; failed chip: danger icon. Chip click opens a popover with the subagent's last status line.
- `Clear done` text button (Label 12px 600, shown only when at least one finished chip exists) removes finished chips.
- Jobs strip: shown only while the omp process runs and at least one job is unfinished. Collapsed row text `{n} background jobs running`, `1 background job running` for one; click expands to rows with job name and elapsed time (tabular). Disappears when the process ends or jobs finish.

### Shared writer prompt (CHTP-10)
- Sending into a session owned by another pane or window opens `EvaModal` (400px): title `Chat is open elsewhere`, body `Another pane is writing to this chat. Sending from here may interleave messages.`, buttons `Don't send` and `Send anyway`. Initial focus on `Don't send`. Choice is remembered for that session until the owner changes.
- A small `Owned by another pane` Label chip appears in the chat header when the owner is not this pane.

### Settings > Chat (CHTP-07, CHTP-12)
- Rows (each: label Body, description Label muted, control right): `Show thinking` Switch, `Show tool details` Switch, then `Harness` SegmentedControl with `omp` and `Claude Code`. Switches apply live to open chats with no reload and persist as `show_thinking` / `show_tools`. Harness change applies to new chats only; helper text `Applies to new chats.`
- Claude Code unavailable (binary missing): segment stays selectable but shows inline danger notice `Claude Code was not found. Install it, then try again.`

### Inline images and viewer (CHTP-13)
- Prompt and tool-result images render as thumbnails (cap 240px, preserve aspect ratio, reserve space from known dimensions to avoid log jump). Click or Enter opens the viewer `EvaModal` with Esc/close, left/right arrows between images in the same message, and `Download` not offered. Images carry alt text (`Image {n} of {m}`).
- Viewer is a Mantine overlay, so `useOccludeBrowser` applies [P2].

### Icon-only aria-labels
`Attach image`, `Chat actions` (row `...`), `New category`, `Remove image {n}`, `Stop response` (Send button while streaming).

### Motion and accessibility
- Transitions 120 to 200ms ease-out; all motion off under `prefers-reduced-motion`.
- Every control has a visible focus outline per the P2 focus rule (2px accent, offset 2px). Hit targets at least 28px with 36px row height minimum for list rows when hovered/focused.
- Chat list is `role="tree"`; groups `treeitem` with `aria-expanded`; status conveyed by text in an `aria-label`, not color alone.
- Streaming smoothness rule: adding or clearing chips, strips and question cards must not reflow the virtualized log by more than their own height and must keep bottom-pin behavior [P1].

---

## Copywriting Contract

| Element | Copy |
|---------|------|
| Primary CTA (sidebar) | `New chat` |
| Primary CTA (composer) | `Send message` (streaming: `Stop`, aria-label `Stop response`) |
| Composer placeholder | `Message Eva` |
| Chat list empty heading | `No chats yet` |
| Chat list empty body | `Start a new chat to talk with Eva. Your omp sessions appear here.` |
| Search empty | `No chats match "{query}"` (body: `Try a different title.`) |
| Group empty | `No chats in this group` |
| Show more / less | `Show {n} more` / `Show fewer` |
| Archived chip | `Archived` |
| Error: list load | `Could not read your chats. Check that the sessions folder exists, then reload.` |
| Error: send failed | `Message not sent. The chat process is not running. Reopen the chat and try again.` |
| Error: rename failed | `Could not rename this chat. Try again.` |
| Error: image rejected | `Only images can be attached.` |
| Error: omp not found | `omp was not found on PATH. Install it or set EVAOS_OMP_BIN, then try again.` |
| Question answered | `Answered: {option}` |
| Question dead | `This question can no longer be answered.` |
| Jobs strip | `{n} background jobs running` / `1 background job running` |
| Subagent clear | `Clear done` |
| Writer prompt | title `Chat is open elsewhere`; confirm `Send anyway`; cancel `Don't send` (initial focus) |
| Drop overlay | `Drop images to attach` |
| Destructive: Delete chat | title `Delete this chat?`; body `This removes the session file for "{title}". This cannot be undone.`; buttons `Delete chat` (danger) and `Keep chat` (initial focus) |
| Destructive: Delete category | title `Delete category "{name}"?`; body `Chats in it return to their workspace group. No chats are deleted.`; buttons `Delete category` and `Keep category` (initial focus) |
| Archive | no confirmation; toast `Chat archived` with `Undo` action (6s) |
| Extension UI: confirm | buttons `Confirm` / `Decline` (initial focus `Decline`) |
| Extension UI: input | button `Send answer` |
| Extension UI: editor | buttons `Send answer` / `Discard input` (initial focus on textarea) |
| Icon aria-labels | `Attach image`, `Chat actions`, `New category`, `Remove image {n}`, `Stop response` |
| Settings labels | `Show thinking`, `Show tool details`, `Harness`, helper `Applies to new chats.` |

---

## Registry Safety

| Registry | Blocks Used | Safety Gate |
|----------|-------------|-------------|
| shadcn official | none (not applicable, Mantine project) | not required |
| Third-party | none | not applicable, none declared (2026-10-15) |

---

## Checker Sign-Off

- [ ] Dimension 1 Copywriting: PASS
- [ ] Dimension 2 Visuals: PASS
- [ ] Dimension 3 Color: PASS
- [ ] Dimension 4 Typography: PASS
- [ ] Dimension 5 Spacing: PASS
- [ ] Dimension 6 Registry Safety: PASS

**Approval:** pending
