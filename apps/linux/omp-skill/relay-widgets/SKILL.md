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

Inline player: play/pause, a progress bar Isaac taps to seek, elapsed/total time. Plays even with the phone on silent.

```ui
{"widget":"audio","title":"Pocket TTS · eve","src":"/drops/<id>/<token>"}
```

- Share the file first, same as compare: `cd ~/Code/relay/apps/linux && bun run src/main.ts share <path>` prints `shared file <id> /drops/<id>/<token>`; use that path as `src`. An absolute `https://` URL also works; local paths are rejected.
- Formats AVPlayer streams: wav, m4a/aac, mp3. Generate speech with `pocket-tts generate --text "…" --voice eve --output-path /tmp/x.wav` (`eve` is Isaac's default voice).
- `title`: optional heading.

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
- `divider`: a hairline.
- `tone` (rows, badge): `"accent" | "ok" | "warn" | "danger" | "muted"`; unknown tones render neutral.
- Limits: containers nest at most 4 deep, 24 children each; past either the spec falls back to code.

## When not to use

- Prose answers, code, or a few rows of mixed text: use Markdown (tables, lists) instead.
- Never put numbers you did not compute or were not given into a spec — the widget must reflect real data.
