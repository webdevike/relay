---
name: relay-widgets
description: >
  Render native widgets (chart, stat, ticket carousel, table, before/after slider, audio, 3D
  model, PR, recipe, gallery, compositions) in the Relay phone and Relay desktop chat by emitting
  a ```openui fenced block written in OpenUI Lang, or a bespoke interactive tool with real Mantine
  components (```mantine-widget JSX) or raw HTML (```html-widget). Use when a reply is better seen
  than read: bar/line charts, headline metrics, swipeable ticket summaries, visual proof, clips to
  hear, choices to tap, a small custom tool. Relay parses and renders the block; anywhere else it
  degrades to a code block, so it is always safe to emit.
---

# Relay widgets (OpenUI Lang)

Emit a fenced block tagged `openui` whose body is an OpenUI Lang program. Relay (phone) and
Relay desktop stream-render it natively while you type; anywhere else it shows as code.

```openui
root = Stat("Collected", "$7.9k", Delta("12%", "up"))
```

- ```` ```ui ```` JSON blocks are **legacy**: Relay still renders them for old history only. Never emit them.
- EvaOS native (Rust/GPUI) does not parse OpenUI Lang; it shows `openui` blocks as code. Accepted (Isaac, 2026-10-23).
- Parser/prompt source of truth: `~/Eva/work/relay/packages/protocol/src/openui/` (`library.ts` holds every component). Check a reply: `cd ~/Eva/work/relay && bun packages/protocol/src/openui/check.ts < reply.md` prints `{blocks:[{line,unclosed,ok,widget,complete,errors}]}`. `.omp/hooks/widget-check.ts` runs it after each turn.

## Syntax rules

1. One statement per line: `identifier = Expression`.
2. `root` is the entry point. Write `root = ...` FIRST so the shell streams in immediately.
3. Expressions: strings `"..."` (double quotes, backslash escapes), numbers, `true`/`false`, `null`, arrays `[...]`, objects `{...}`, component calls `Type(arg1, arg2, ...)`.
4. Arguments are POSITIONAL. `Stack([a, b], "horizontal", "xs")`, never `direction: "horizontal"` (colon syntax silently breaks).
5. Omit trailing optional arguments; write `null` to skip an optional argument before one you set.
6. Use references (`name = ...` then `name`) for readability and streaming; references may be used before they're defined (hoisting).
7. Every variable except `root` MUST be reachable from `root`; unreferenced ones are dropped silently.
8. Literals only: no prose, comments, expressions, `$variables`, Query/Mutation. The only `@` steps are `@ToAssistant` and `@OpenUrl`, in a Button's action slot.
9. `root` may be `Card(...)` (framed), a `Stack(...)`, or one standalone widget (`root = Chart(...)`).
10. Use only the components and arguments below. A node that fails validation is dropped; an invalid root drops the whole widget (renders as code under "Widget couldn't render"). Never invent fields.

## Component signatures

`?` = optional. `tone` is `"accent" | "ok" | "warn" | "danger" | "muted"` everywhere. Every widget can be a child of Card, Stack, Grid, Tab, Collapse; sub-components (Series, Delta, Row, Ticket, Column, Cell, ListItem, Tab, Side, ...) only go inside the widget that takes them.

### Layout
- `Card(children: Component[], title?, width?: "compact"|"full")`: hairline frame with optional heading. Don't nest cards for decoration. `width: "compact"` keeps a small tool (calculator, keypad, short form) phone-sized (~380px) on the desktop chat column; phones always use full width. Default `full`.
- `Stack(children, direction?: "vertical"|"horizontal", gap?: "xs"|"sm"|"md"|"lg")`: column (default) or row of equal-width columns; gap default `sm`. A Button fills its column.
- `Grid(children, columns?: 2|3|4, gap?)`: rows of equal cells (default 2); a Button fills its cell at a comfortable tap height (keypads, choice grids); phones may drop columns.
- `Tabs(tabs: Tab[])` with `Tab(label, children)`: 2-6 tabs, first shown.
- `Collapse(title, children, open?)`: open defaults to false.
- Limits: containers nest at most 4 deep, at most 24 children each (per tab); past either the widget falls back to code.

### Text blocks
- `Text(text, style?: "heading"|"body"|"caption"|"muted"|"display", align?: "left"|"center"|"right")`: `display` is a large tabular readout (calculator screen, counter); align defaults to left.
- `Rows(rows: Row[])`, `Row(label, value, tone?)`: label left, value right.
- `Badge(label, tone?)`: put several in `Stack([...], "horizontal", "xs")`.
- `Divider()`
- `Callout(text, title?, tone?)`: tone (default accent) picks the icon.
- `Quote(text, cite?)`
- `List(items: (string|ListItem)[], style?: "bullet"|"number"|"check")`, `ListItem(text, caption?, checked?)`: 1-50 items; checks are static, checked items mute and strike through.

### Rich blocks
- `Progress(value, max?, label?, caption?, tone?)`: max default 100, value clamps, shows rounded percent.
- `Avatar(name, subtitle?, src?)`: initials without src.
- `Timeline(items: TimelineEntry[])`, `TimelineEntry(title, time?, text?, tone?)`: 1-30 events.
- `Code(code, language?, title?)`: ≤ 50k chars.
- `Diff(patch, file?)`: one file's unified diff (`git diff -- <file>` output as-is, ≤ 50k chars); file extension picks syntax colors. Zed-style: collapsible header, new-file line numbers, gutter bar per change, long diffs show 60 rows then "Show N more". One `Diff` per file inside a `Stack` for multi-file changes.

### Actions
- `Button(label, action?: @ToAssistant("text") | @OpenUrl("https://..."), url?, variant?: "primary"|"secondary"|"subtle", tone?)`: `@ToAssistant` sends text as Isaac's next turn in this session; `@OpenUrl` (or `url`) opens a link; with neither, tapping sends the label. Several steps: `Action([@OpenUrl(...), @ToAssistant(...)])`. Put several buttons in a horizontal Stack.
- `Link(label, url)`: http(s).
- `Input(placeholder?, button?, reply?, multiline?)`: `reply` must contain `{value}` (default `"{value}"`); button default "Send"; shows "Sent" after submit.
- Buttons and inputs are disabled where there is no session (dashboards).

### Data
- `Stat(label, value, delta?: Delta)`, `Delta(value, direction?: "up"|"down"|"flat")`: format value yourself (`$7.9k`, `1,357`, `92%`). up green, down red, flat (default) grey.
- `Chart(kind: "bar"|"line", series: Series[], labels?: string[], title?, stacked?)`, `Series(points: number[], name?, color?)`: labels one per point; several series draw grouped bars / overlaid lines with a legend; `stacked` is bar only; color is hex (omit for default palette).
- `Table(columns: (string|Column)[], rows: (string|number|Cell)[][], title?)`, `Column(label, align?: "left"|"right"|"center")`, `Cell(text, tone?, bold?, url?, icon?: "github"|"linear")`: 1-8 columns, 1-100 rows, exactly one cell per column per row; scrolls sideways. `url` (http(s) only) makes the cell a link; one link per cell, so two links means two columns. `icon` draws the brand logo; text may be `""` for icon-only.
- `Tickets(tickets: Ticket[], title?)`, `Ticket(id, title, summary, url?, state?, stateType?, priority?, assignee?, updated?)`: paged carousel, one ticket per card.
  - `summary`: 1-3 sentences you wrote from the issue (description, latest comments): what it is, where it stands, what's next. Not the raw description.
  - `stateType`: Linear's workflow-state type (`triage`, `backlog`, `unstarted`, `started`, `completed`, `canceled`); colors the state pill.
  - `url`: the issue's canonical link copied verbatim from Linear (`linear issue url ENG-<n>`, or the issue's `url` field). Never build it by hand: a guessed workspace slug or missing title slug lands on Linear's home. Renders "Open in Linear".

### Records
- `Emails(emails: Email[], title?)`, `Email(from, subject, snippet?, date?, unread?, url?)`: 1-50 inbox rows. Gmail (personal, `secrets/gmail.env`, IMAP app password): fetch with `BODY.PEEK[]` + `X-GM-THRID` so reading never marks mail read; `url` = `https://mail.google.com/mail/u/0/#all/<thrid hex>`. Strip CR/LF folding from subjects.
- `Pr(repo, number, title, state?: "open"|"draft"|"merged"|"closed", url?, author?, branch?, base?, body?, reviewers?: Reviewer[], checks?: PrCheck[], files?: PrFile[])`: GitHub-mobile style with Overview, Checks, Files tabs. `Reviewer(name, state?: "approved"|"changes"|"pending"|"commented")`, `PrCheck(name, status?: "success"|"failure"|"pending"|"skipped", duration?, url?)`, `PrFile(file, patch, additions?, deletions?)`.
- `Recipe(title, ingredients: Ingredient[], directions: string[], meta?: string[], source?)`, `Ingredient(item, section?)`: use when the source recipe already has ingredients and directions. 1-50 ingredients (set `section` only where a new group starts), 1-30 steps, 1-4 meta facts (time, servings), source an absolute http(s) URL.

### Media
- `Image(src, alt?, caption?, url?, aspect?)`: aspect width/height 0.25-4 (default natural); tap for full-screen zoom.
- `Gallery(images: GalleryImage[], title?)`, `GalleryImage(src, title?, caption?, url?)`: 1-50 references (Dribbble shots, screenshots, mockups); 4:3 frame, tap opens a zoomable pager. Prefer large sources (Dribbble CDN `resize=1600x1200`) so zoom stays sharp. `url` is the source page.
- `Compare(before: Side, after: Side, title?)`, `Side(src, label?)`: before/after slider for visual proof. Use two images of the same frame and size (e.g. `proof.ts` shots); the frame takes the after image's aspect. Labels default "Before"/"After".
- `Audio(src, title?)`: play/pause, seek, speed pill (1x-2x, pitch-corrected, remembered), plays on silent. Never render per-speed copies. Formats: wav, m4a/aac, mp3. Speech: `pocket-tts generate --text "…" --voice stuart_bell --output-path /tmp/x.wav` (`stuart_bell` is Isaac's default voice).
- `Video(src, title?)`
- `Model(src, title?, caption?, autoRotate?)`: GLB (or `.gltf` with buffers/images embedded as data URIs; sidecar files fail). PBR + embedded textures render; Draco meshes and KTX2 textures don't, so export plain GLB: `bpy.ops.export_scene.gltf(filepath=..., export_format="GLB")`. Drag orbits, pinch zooms; `autoRotate` spins until touched.
- Media `src`: share the file first, `cd ~/Code/relay/apps/linux && bun run src/main.ts share <path>` prints `shared image|file|video <id> /drops/<id>/<token>` (and a ready `embed ![...](...)` line); use that path, or an absolute `https://` URL. Local file paths are rejected (the hook flags them). Shared files also appear in the phone's Drops list (max 100, oldest roll off). Videos (mp4/mov/webm) are capped at 25 MB and get a poster; outside a widget, the plain markdown `![caption](/drops/<id>/<token>)` of a video drop already plays inline in chats.
- Mac Mini (2026-10-10): plain-http drop paths render blank on the phone. Use the full https URL: `https://isaacs-mac-mini.tail80fdb0.ts.net/drops/<id>/<token>` (tailscale serve --bg 7817 proxies the Relay host).

## Examples

Stacked multi-series chart with pastel colors:

```openui
root = Chart("bar", [Series([40, 60, 55], "connected", "#A7F3D0"), Series([50, 70, 60], "voicemail", "#FDE68A")], ["W1", "W2", "W3"], "Calls by outcome", true)
```

Tickets (`null` skips optional args):

```openui
root = Tickets([t1], "My Linear tickets")
t1 = Ticket("ENG-5514", "Black Buttons: more stragglers", "Merged; waiting on Steve's QA on dev before closing.", "https://linear.app/ecard-systems/issue/ENG-5514/black-buttons-more-stragglers", "In QA", "started", "Low", null, "2d ago")
```

Before/after proof:

```openui
root = Compare(Side("/drops/abc/tok1", "Before · dev"), Side("/drops/def/tok2", "After · local"), "Admin tabs")
```

Audio and 3D model:

```openui
root = Stack([Audio("/drops/abc/tok", "Pocket TTS · stuart_bell"), Model("/drops/def/tok", "Mug on a coaster", "Blender export · 54 KB", true)])
```

Gallery:

```openui
root = Gallery([GalleryImage("https://cdn.dribbble.com/userupload/123/file.png?resize=1600x1200", "Nested Data Table", "Jon Moore · 561 likes", "https://dribbble.com/shots/15627284")], "Data tables")
```

Recipe:

```openui
root = Recipe("Smashed Pork Tacos", [Ingredient("1 lb ground pork", "Tacos"), Ingredient("6 corn tortillas"), Ingredient("3 tbsp soy sauce", "Glaze")], ["Mix and portion the pork.", "Sear each taco meat-side down."], ["15 minutes", "Serves 6"], "https://example.com/recipe")
```

Composition with building blocks:

```openui
root = Card([stats, Divider(), status, tags], "Morning brief")
stats = Stack([Stat("Open tickets", "12"), Stat("In review", "1")], "horizontal")
status = Rows([Row("ENG-5533", "In Review", "accent"), Row("ENG-5514", "Waiting on QA", "warn")])
tags = Stack([Badge("eCard", "accent"), Badge("Dev green", "ok")], "horizontal", "xs")
```

Review card with callout, table (link + icon cells), progress and buttons:

```openui
root = Card([note, checks, bar, actions], "ENG-6211 review")
note = Callout("Two approvals needed before merge.", "Waiting on Noah", "warn")
checks = Table(["Item", "Check", Column("Time", "right")], [[Cell("#412", null, false, "https://github.com/o/r/pull/412", "github"), "lint", "42s"], [Cell("ENG-6211", null, false, "https://linear.app/team/issue/ENG-6211", "linear"), Cell("e2e", "danger", true), "6m"]])
bar = Progress(7, 9, "Checks", null, "ok")
actions = Stack([Button("Nudge Noah", @ToAssistant("nudge Noah on ENG-6211"), null, "primary"), Button("Open PR", @OpenUrl("https://github.com/o/r/pull/412"))], "horizontal")
```

Tabs, list, timeline, input:

```openui
root = Tabs([Tab("Plan", [plan]), Tab("History", [history]), Tab("Reply", [Input("Name the branch", "Use", "call the branch {value}")])])
plan = List(["Write migration", ListItem("Backfill", "~2h", true)], "check")
history = Timeline([TimelineEntry("Opened", "Mon", "Filed by Steve"), TimelineEntry("Merged", "Wed", null, "ok")])
```

## State and interactive widgets

- Declare state with `$name = default` (string or number). Read it anywhere in expressions: arithmetic `+ - * / %`, comparisons, ternaries `$op == "+" ? a : b`, string concatenation `"Count: " + $n`. `+` concatenates if either side is a string; use `$cur * 1` to turn text into a number; dividing by zero gives 0; `"" + @Round($x, 2)` controls decimals. Undeclared `$vars` start as null.
- Buttons change state: `@Set($var, expression)`, `@Reset($a, $b, ...)` (back to declared defaults). `Action([...])` runs steps in order; each `@Set` sees the earlier ones. @Set/@Reset run on the device and send no turn; add `@ToAssistant` only when the result should become Isaac's next message. Keep self-contained tools (calculator, counter, converter) fully local.
- `Input(..., value: $var)` (5th positional arg) keeps the typed text in `$var` for other widgets to read; in `reply`, `{value}` is still the submitted text.
- State is local to that widget on that device and resets on app reload/re-render from scratch; it is never sent back to the agent.
- No Query, Mutation or @Run: no data fetching or server calls from a widget.
- EvaOS (and any surface without the OpenUI runtime) shows the fence as code.

Counter:

```openui
root = Card([label, row], "Counter")
$n = 0
label = Text("Count: " + $n, "heading")
row = Stack([Button("−", @Set($n, $n - 1)), Button("+", @Set($n, $n + 1), null, "primary"), Button("Reset", @Reset($n), null, "subtle")], "horizontal")
```

Calculator (pocket-calculator semantics: `12+7*2=` shows 38, `0.1+0.2=` shows 0.3):

```openui
root = Card([screen, keys, clear], "Calculator", "compact")
$display = "0"
$cur = ""
$acc = 0
$op = ""
screen = Text($display, "display", "right")
keys = Grid([k7, k8, k9, kdiv, k4, k5, k6, kmul, k1, k2, k3, ksub, k0, kdot, keq, kadd], 4, "xs")
result = $cur == "" ? $acc : ($op == "+" ? $acc + $cur * 1 : ($op == "-" ? $acc - $cur : ($op == "*" ? $acc * $cur : ($op == "/" ? $acc / $cur : $cur * 1))))
k7 = Button("7", Action([@Set($cur, $cur + "7"), @Set($display, $cur)]))
k8 = Button("8", Action([@Set($cur, $cur + "8"), @Set($display, $cur)]))
k9 = Button("9", Action([@Set($cur, $cur + "9"), @Set($display, $cur)]))
k4 = Button("4", Action([@Set($cur, $cur + "4"), @Set($display, $cur)]))
k5 = Button("5", Action([@Set($cur, $cur + "5"), @Set($display, $cur)]))
k6 = Button("6", Action([@Set($cur, $cur + "6"), @Set($display, $cur)]))
k1 = Button("1", Action([@Set($cur, $cur + "1"), @Set($display, $cur)]))
k2 = Button("2", Action([@Set($cur, $cur + "2"), @Set($display, $cur)]))
k3 = Button("3", Action([@Set($cur, $cur + "3"), @Set($display, $cur)]))
k0 = Button("0", Action([@Set($cur, $cur + "0"), @Set($display, $cur)]))
kdot = Button(".", Action([@Set($cur, $cur + "."), @Set($display, $cur)]))
kdiv = Button("÷", Action([@Set($acc, result), @Set($op, "/"), @Set($cur, ""), @Set($display, "" + @Round($acc, 10))]), null, "secondary", "accent")
kmul = Button("×", Action([@Set($acc, result), @Set($op, "*"), @Set($cur, ""), @Set($display, "" + @Round($acc, 10))]), null, "secondary", "accent")
ksub = Button("−", Action([@Set($acc, result), @Set($op, "-"), @Set($cur, ""), @Set($display, "" + @Round($acc, 10))]), null, "secondary", "accent")
kadd = Button("+", Action([@Set($acc, result), @Set($op, "+"), @Set($cur, ""), @Set($display, "" + @Round($acc, 10))]), null, "secondary", "accent")
keq = Button("=", Action([@Set($acc, result), @Set($op, ""), @Set($cur, ""), @Set($display, "" + @Round($acc, 10))]), null, "primary")
clear = Button("Clear", @Reset($display, $cur, $acc, $op), null, "subtle")
```

## Custom UI: ```mantine-widget and ```html-widget

When no OpenUI component fits (a configurator, a mini app, a bespoke chart or form), write the UI yourself. Prefer `openui` whenever it can express the thing: it streams, is checked by the hook, and renders in more places. Both custom fences run in a sandboxed web view on the phone and a sandboxed iframe on Relay desktop: **no network at all** (no fetch, CDN, fonts, images except `data:`), no navigation, sized to their content (up to ~1200px, then scroll inside), transparent over the chat, drawn only once the fence closes. State is local and resets when the message re-renders. Never put data you did not compute or were not given into one.

`relay` is in scope in both:
- `relay.reply(text)`: sends `text` as Isaac's next message in this session. Only works inside a tap/click handler (user gesture); calls on load are ignored. Returns `true` when sent.
- `relay.colorScheme`: `"light" | "dark"`. `relay.theme`: `{ dark, colors: { fg, muted, faint, border, surface, raised, accent, ok, warn, danger, bg }, font, radius }` (the host palette).

### ```mantine-widget (preferred custom fence)

The body is the body of a React function component: hooks and constants, then `return <JSX/>`. A single JSX element alone also works. Everything is already in scope as plain names, no imports (import lines are ignored): every `@mantine/core` component (`Card`, `Stack`, `Group`, `SimpleGrid`, `Button`, `ActionIcon`, `SegmentedControl`, `TextInput`, `NumberInput`, `Select`, `Slider`, `Switch`, `Checkbox`, `Badge`, `Text`, `Title`, `Table`, `Progress`, `RingProgress`, `Tabs`, `Accordion`, `Alert`, `ThemeIcon`, ...), every `@mantine/charts` chart (`BarChart`, `LineChart`, `AreaChart`, `DonutChart`, `PieChart`, `Sparkline`, `RadarChart`, `ScatterChart`, `BubbleChart`, `Heatmap`, ...), every `@mantine/hooks` hook (`useDisclosure`, `useCounter`, `useListState`, `useInterval`, ...), React (`React`, `useState`, `useEffect`, `useMemo`, `useRef`, `useReducer`, `useCallback`, `useId`, `useTransition`, `Fragment`) and `relay`. TypeScript annotations are fine. Mantine 9.7 + React 19.3, with the Relay desktop theme (Settings > Theme on desktop, the Default preset on the phone) in the host's light/dark scheme: use theme colors (`color="blue"`, `c="dimmed"`, `"blue.6"` in chart series) instead of hex so both schemes work. No `@tabler/icons-react` (not bundled); use text, emoji or `ThemeIcon` with a character. A compile or render error shows a small red "Widget error" alert with the message instead of the widget; fix and repost.

```mantine-widget
const [range, setRange] = useState("Week");
const [note, setNote] = useState("");
const data = range === "Week"
  ? [{ day: "Mon", runs: 3 }, { day: "Tue", runs: 5 }, { day: "Wed", runs: 2 }]
  : [{ day: "W1", runs: 14 }, { day: "W2", runs: 19 }, { day: "W3", runs: 11 }];
return (
  <Card withBorder padding="md">
    <Stack gap="sm">
      <Group justify="space-between">
        <Title order={4}>Agent runs</Title>
        <Badge variant="light">{range}</Badge>
      </Group>
      <SegmentedControl fullWidth value={range} onChange={setRange} data={["Week", "Month"]} />
      <BarChart h={160} data={data} dataKey="day" series={[{ name: "runs", color: "blue.6" }]} tickLine="none" />
      <TextInput label="Note" placeholder="Anything to add?" value={note} onChange={(e) => setNote(e.currentTarget.value)} />
      <Button fullWidth onClick={() => relay.reply(`Runs by ${range.toLowerCase()}${note ? `: ${note}` : ""}`)}>Send summary</Button>
    </Stack>
  </Card>
);
```

A one-element widget:

```mantine-widget
<Alert color="green" title="Deploy finished">dev is on 4f2c1aa, all 212 checks green.</Alert>
```

### ```html-widget (raw HTML)

The body is an HTML fragment (markup, `<style>`, inline `<script>`) placed in the page body; use it for things Mantine does not help with (canvas drawings, custom SVG). Host palette as CSS variables: `--fg --muted --faint --border --surface --raised --accent --ok --warn --danger --bg`, `--font --mono`, `--radius-sm --radius --radius-lg`; the body already uses the system font and transcript text size. Inline `onclick` handlers work.

```html-widget
<button onclick="n.textContent = +n.textContent + 1" style="font-size:20px;padding:8px 16px;border-radius:var(--radius);border:1px solid var(--border);background:var(--surface)">+1</button>
<span id="n" style="margin:0 12px">0</span>
<button onclick="relay.reply('Counter is ' + n.textContent)" style="background:var(--accent);color:#fff;border:0;padding:8px 16px;border-radius:var(--radius)">Send</button>
```

Where they render: Relay phone (TestFlight build 11+, both fences; JS updates arrive over the air) and Relay desktop (evaos-electron main 402ba81+, installed in ~/Applications/Relay.app). EvaOS native shows them as code. Source: `~/Eva/work/relay/packages/widget-runtime` (`src/frame.ts` pages, `src/runtime/` Mantine runtime, `src/theme.ts` the one theme shared with the desktop app; rebuild the bundle with `pnpm -C packages/widget-runtime build`).

## Tap-to-answer replies: `[[replies: ...]]`

When a message ends on a question to Isaac that he can answer in a few words from a small set of clear answers (yes or no, which of the options just named, a time or day), add one last line:

```
[[replies: Yes, push it | Not yet | Show me the diff]]
```

- Two to four answers in his words, split on `|`, each at most 24 characters (about four words). Longer ones and repeats are dropped; fewer than two left shows nothing.
- Relay shows them as tap-to-reply buttons under the newest bubble and sends the one he taps as his message. Nothing is sent without a tap.
- Write each the way he would say it; on a yes to anything hard to undo, name the action ("Yes, deploy it", not "Yes"); for a choice, the answer is the option itself ("Keep Workspace", not "Yes, keep it"). Offer only answers the message already gives. Keep the question in words.
- It must be the very last line (a token in mid-text shows as text). After a `[[signin:<url>]]` token is fine.
- Skip it for open questions (what should it say, what do you think, anything else, or something else?), when he would pick several things at once, when the question is for someone else (inside a draft or a quote), when there is no question, and on voice-call turns.
- The same rule is in each assistant's prime (`~/Eva/.omp/assistant/agents/<id>/prime.md`); the eval behind its wording is `evals/reply-chips/`.
- The Relay Host strips it for the phone (`AssistantMessage.replies`), pushes and calls; Relay desktop strips it in its chat renderer. Parser: `apps/linux/src/assistant/replies.ts`.

## Building a new widget (app side)

Isaac's rule (2026-10-06): never build a widget's UI in isolation. Break it into reusable base elements in `apps/mobile/src/ui/` (image frame, pager, page controls, link button, overlay tag, caption, placeholder, ...) and have the widget only compose them. Reuse what exists first; add a missing piece as a primitive. The current list lives in `apps/mobile/AGENTS.md`.

A new widget or field ships on every Relay surface the same day:
- Protocol: zod schema in `apps/mobile/src/agents/widget.ts` / the protocol package, AND its OpenUI component in `packages/protocol/src/openui/library.ts` (signature, positional arg order, description). The converted WidgetSpec must be the same shape the JSON spec produces, so renderers stay unchanged. Regenerate/inspect the prompt (`relayWidgetPrompt()`), add a parser test, and copy the new signature into this skill.
- Relay desktop (Electron, `~/Eva/work/evaos-electron`, `~/Applications/Relay.app`): zod 4 port in `packages/chat-core/src/widget.ts` (header names the protocol commit it follows) plus the chat-core port of the OpenUI module/library; registry in `apps/desktop/src/renderer/chat/widgets/Widget.tsx`, rich widgets in `chat/widgets/rich/`, media through `relay-media:` (`src/main/chat/widget-media.ts`); a block in `fixtures/agent-widgets` checked by `e2e/widgets.spec.ts`.
- EvaOS native (`~/Eva/apps/evaos`) only parses legacy ```ui JSON and shows `openui` blocks as code; no EvaOS work is required for OpenUI widgets.
- Upstream OpenUI fork: `~/Eva/work/openui-fork` (only `packages/lang-core` is used).

Adding, renaming or removing a widget also updates its one-line WHEN rule in `~/Eva/.omp/response-formats/<active>.md` § Widgets (loaded into every Eva session). Field specs stay here only.

## When not to use

- Prose answers, code, or a few rows of mixed text: use Markdown (tables, lists).
- Never put numbers you did not compute or were not given into a widget; it must reflect real data.
