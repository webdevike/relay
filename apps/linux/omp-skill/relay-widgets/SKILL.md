---
name: relay-widgets
description: >
  Render a native chart, stat card, paged ticket carousel, before/after image slider, or
  audio player in the Relay phone app's chat by emitting a ```ui fenced block whose body
  is a JSON widget spec. Use when a reply is better shown as a bar/line chart, a headline
  metric, a swipeable list of ticket summaries (Linear issues, PRs), visual proof, or a
  clip Isaac should hear (TTS output, recordings) than as prose or a Markdown table. The Relay app
  parses the block and draws it natively; in a plain terminal it degrades to a code
  block, so it is always safe to emit.
---

# Relay widgets

Emit a fenced block tagged `ui` whose body is a single JSON object. The Relay phone
app renders it as a native widget; anywhere else it shows as a normal code block.
Keep the JSON minimal and valid — a malformed spec silently falls back to code.

Every spec is a node with a `widget` key. Nodes are either whole widgets (chart, stat,
tickets, compare, audio), small blocks (text, rows, badge, divider), or containers
(stack, card) whose `children` hold any other nodes. Do not invent fields or node types;
one bad node anywhere rejects the whole tree.

## Chart

```ui
{"widget":"chart","kind":"bar","title":"Weekly calls","labels":["W1","W2","W3","W4","W5","W6"],"series":[{"name":"calls","points":[120,180,150,240,300,260]}]}
```

- `kind`: `"bar"` or `"line"`.
- `stacked`: optional `true` — bars in a group stack instead of sitting side by side (bar only).
- `title`: optional heading.
- `labels`: optional x-axis labels, one per point.
- `series`: one or more `{ points: number[], name?, color? }`. `color` is a hex string; omit it to use the default palette. Multiple series draw grouped bars or overlaid lines, with a legend.

Stacked, multi-series, custom pastel colors:

```ui
{"widget":"chart","kind":"bar","stacked":true,"title":"Calls by outcome","labels":["W1","W2","W3"],"series":[{"name":"connected","color":"#A7F3D0","points":[40,60,55]},{"name":"voicemail","color":"#FDE68A","points":[50,70,60]}]}
```

## Stat

A single headline metric, optionally with a change indicator.

```ui
{"widget":"stat","label":"Collected","value":"$7.9k","delta":{"value":"12%","direction":"up"}}
```

- `label`, `value`: strings (format the value yourself — `$7.9k`, `1,357`, `92%`).
- `delta`: optional `{ value: string, direction: "up" | "down" | "flat" }`. `up` is green, `down` red, `flat` grey.

## Tickets

A paged carousel, one ticket per card; Isaac swipes or taps the chevrons to step through.

```ui
{"widget":"tickets","title":"My Linear tickets","tickets":[{"id":"ENG-5514","title":"Black Buttons: more stragglers","summary":"Merged; waiting on Steve's QA on dev before closing.","state":"In QA","stateType":"started","priority":"Low","updated":"2d ago","url":"https://linear.app/ecard-systems/issue/ENG-5514/black-buttons-more-stragglers"}]}
```

- `tickets`: one or more `{ id, title, summary, state?, stateType?, priority?, assignee?, updated?, url? }`.
- `summary`: 1–3 sentences you wrote from the issue (description, latest comments): what it is, where it stands, what's next. Not the raw description.
- `stateType`: Linear's workflow-state type (`triage`, `backlog`, `unstarted`, `started`, `completed`, `canceled`); colors the `state` pill.
- `url`: the issue's canonical link, copied verbatim from Linear (`linear issue url ENG-<n>`, or the issue's `url` field). Never build it by hand: a guessed workspace slug or a missing title slug lands on Linear's home instead of the issue. Renders an "Open in Linear" tap target.

## Compare

Before/after image slider: both images in one frame, a divider Isaac drags (or taps) to reveal more of either side. Use it for visual proof (UI before/after).

```ui
{"widget":"compare","title":"Admin tabs","before":{"src":"/drops/<id>/<token>","label":"Before · dev"},"after":{"src":"/drops/<id>/<token>","label":"After · local"}}
```

- Images must reach the phone: share each file with `cd ~/Code/relay/apps/linux && bun run src/main.ts share <path>`, which prints `shared image <id> /drops/<id>/<token>`; use that path as `src`. An absolute `https://` URL also works. Local file paths are rejected.
- Use two images with the same frame and size (e.g. `proof.ts` framed shots); the frame takes the after image's aspect ratio.
- `label`: optional corner tags; default "Before" / "After".
- Shared images also appear in the phone's Drops list (max 100, oldest roll off).

## Audio

Inline player: play/pause, a progress bar Isaac taps to seek, elapsed/total time, and a speed pill (1x, 1.25x, 1.5x, 1.75x, 2x; pitch-corrected, remembered across clips). Plays even with the phone on silent. Never render per-speed copies of a clip; one widget covers all speeds.

```ui
{"widget":"audio","title":"Pocket TTS · eve","src":"/drops/<id>/<token>"}
```

- Share the file first, same as compare: `cd ~/Code/relay/apps/linux && bun run src/main.ts share <path>` prints `shared file <id> /drops/<id>/<token>`; use that path as `src`. An absolute `https://` URL also works; local paths are rejected.
- Formats AVPlayer streams: wav, m4a/aac, mp3. Generate speech with `pocket-tts generate --text "…" --voice eve --output-path /tmp/x.wav` (`eve` is Isaac's default voice).
- `title`: optional heading.

## Video

Inline video player: a frame sized to the video's aspect ratio (16:9 until it loads) showing the first frame, tap the picture or the play button to play or pause, the same progress bar and elapsed/total time as audio, and a corner button that opens the system full-screen player. Plays even with the phone on silent. Use it for screen recordings and repro clips.

```ui
{"widget":"video","title":"Checkout repro","src":"/drops/<id>/<token>"}
```

- Share the file first, same as audio: `cd ~/Code/relay/apps/linux && bun run src/main.ts share <path>` prints `shared file <id> /drops/<id>/<token>`; use that path as `src`. An absolute `https://` URL also works; local paths are rejected.
- Formats AVPlayer streams: mp4 or mov with h264 (or hevc) video and aac audio. Encode with `-movflags +faststart` so playback starts before the whole file arrives: `ffmpeg -i in.mov -c:v libx264 -c:a aac -movflags +faststart out.mp4`.
- `title`: optional heading.

## Gallery

Image carousel for references (Dribbble shots, screenshots, mockups): one image per page, swipe or tap the chevrons, title and caption under each, an open-link icon when `url` is set. Tapping an image opens a full-screen pager: swipe between images, pinch or double tap to zoom, drag to pan while zoomed, tap to close.

```ui
{"widget":"gallery","title":"Data tables","images":[{"src":"https://cdn.dribbble.com/userupload/<...>.png?resize=1600x1200","title":"Nested Data Table","caption":"Jon Moore · 561 likes","url":"https://dribbble.com/shots/15627284"}]}
```

- `images`: 1 to 50 `{ src, title?, caption?, url? }`. `src` is a host drop path (share the file first, same as compare) or an absolute `https://` URL; local paths are rejected. `url` is the source page (http(s) only).
- Prefer large sources (Dribbble CDN `resize=1600x1200`) so zoom stays sharp; the carousel frame is 4:3 and images fit inside it.

## Building a new widget (app side)

Isaac's rule (2026-10-06): never build a widget's UI in isolation. Break it into reusable base elements in `apps/mobile/src/ui/` (image frame, pager, page controls, link button, overlay tag, caption, placeholder, ...) and have the widget only compose them. Reuse what exists first; add a missing piece as a primitive, then use it. The current list lives in `apps/mobile/AGENTS.md`.

Every widget must also render in EvaOS, Eva's desktop app (`~/Eva/apps/evaos`, Rust/GPUI, parser + renderer in `src/rich/widgets.rs`, image/audio loading in `src/rich/media.rs`). A new widget or field ships in both the same day: same JSON spec, zod schema in `apps/mobile/src/agents/widget.ts`, serde parser in EvaOS, a parser test on each side, and an `apps/evaos/examples/showcase.md` block checked with `cargo run --example snapshot -- /tmp/reply.png --reply examples/showcase.md`. EvaOS follows the same primitive rule: shared helpers (pager controls, dots, link button, image frame, caption) in `widgets.rs`, composed per widget. A widget only one side understands falls back to a code block on the other, so never emit it until both have it.

## Building blocks

Compose anything from containers and small blocks. Any widget above can be a child.

```ui
{"widget":"card","title":"Morning brief","children":[{"widget":"stack","direction":"horizontal","children":[{"widget":"stat","label":"Open tickets","value":"12"},{"widget":"stat","label":"In review","value":"1"}]},{"widget":"divider"},{"widget":"rows","rows":[{"label":"ENG-5533","value":"In Review","tone":"accent"},{"label":"ENG-5514","value":"Waiting on QA","tone":"warn"}]},{"widget":"stack","direction":"horizontal","gap":"xs","children":[{"widget":"badge","label":"eCard","tone":"accent"},{"widget":"badge","label":"Dev green","tone":"ok"}]}]}
```

- `stack`: `children` (1–24), `direction` `"vertical"` (default) or `"horizontal"` (equal-width columns), `gap` `"xs" | "sm" | "md" | "lg"` (default `sm`).
- `card`: `children`, optional `title`. A card at the root is the widget's frame; nested cards draw their own hairline border, so don't nest cards for decoration.
- `text`: `text`, `style` `"heading" | "body" | "caption" | "muted"` (default body).
- `rows`: label left, value right, hairline between: `rows: [{ label, value, tone? }]`.
- `badge`: `label`, optional `tone`.
- `diff`: `patch` (unified diff text, one file, ≤ 50k chars; `git diff -- <file>` output as-is), optional `file` (path; its extension picks syntax colors). Zed-style: collapsible header (name, dimmed directory), new-file line numbers, gutter bar per change block (green added, yellow modified, red deleted), tinted rows, no +/- markers, sideways scroll; long diffs show 60 rows then "Show N more". Use one `diff` per file inside a `stack` for a multi-file change.
- `emails`: `emails: [{ from, subject, snippet?, date?, unread?, url? }]` (1–50), optional `title`. Flat inbox rows: unread dot + bold sender, time right, subject, 2-line snippet (tap a row to expand), open glyph when `url` is set. Gmail (personal, `secrets/gmail.env`, IMAP app password): fetch with `BODY.PEEK[]` + `X-GM-THRID` so reading never marks mail read; `url` = `https://mail.google.com/mail/u/0/#all/<thrid hex>`. Strip CR/LF folding from subjects.
- `divider`: a hairline.
- `tone` (rows, badge): `"accent" | "ok" | "warn" | "danger" | "muted"`; unknown tones render neutral.
- Limits: containers nest at most 4 deep, 24 children each; past either the spec falls back to code.

## When not to use

- Prose answers, code, or a few rows of mixed text: use Markdown (tables, lists) instead.
- Never put numbers you did not compute or were not given into a spec — the widget must reflect real data.
