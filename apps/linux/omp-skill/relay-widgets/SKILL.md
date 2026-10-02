---
name: relay-widgets
description: >
  Render a native chart, stat card, or paged ticket carousel in the Relay phone app's
  chat by emitting a ```ui fenced block whose body is a JSON widget spec. Use when a
  reply is better shown as a bar/line chart, a headline metric, or a swipeable list of
  ticket summaries (Linear issues, PRs) than as prose or a Markdown table. The Relay app
  parses the block and draws it natively; in a plain terminal it degrades to a code
  block, so it is always safe to emit.
---

# Relay widgets

Emit a fenced block tagged `ui` whose body is a single JSON object. The Relay phone
app renders it as a native widget; anywhere else it shows as a normal code block.
Keep the JSON minimal and valid — a malformed spec silently falls back to code.

Only three widgets exist today. Do not invent fields; unknown shapes do not render.

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
{"widget":"tickets","title":"My Linear tickets","tickets":[{"id":"ENG-5514","title":"Fix export totals","summary":"Merged; waiting on Steve's QA on dev before closing.","state":"In Review","stateType":"started","priority":"High","updated":"2d ago","url":"https://linear.app/ecardsystems/issue/ENG-5514"}]}
```

- `tickets`: one or more `{ id, title, summary, state?, stateType?, priority?, assignee?, updated?, url? }`.
- `summary`: 1–3 sentences you wrote from the issue (description, latest comments): what it is, where it stands, what's next. Not the raw description.
- `stateType`: Linear's workflow-state type (`triage`, `backlog`, `unstarted`, `started`, `completed`, `canceled`); colors the `state` pill.
- `url`: the issue link; renders an "Open in Linear" tap target.

## When not to use

- Prose answers, code, or a few rows of mixed text: use Markdown (tables, lists) instead.
- Never put numbers you did not compute or were not given into a spec — the widget must reflect real data.
