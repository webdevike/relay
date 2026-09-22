---
name: relay-widgets
description: >
  Render a native chart or stat card in the Relay phone app's chat by emitting a
  ```ui fenced block whose body is a JSON widget spec. Use when a reply is better
  shown as a bar/line chart or a headline metric than as prose or a Markdown table —
  weekly counts, breakdowns by category, trends over time, a single KPI with a
  delta. The Relay app parses the block and draws it on Skia; in a plain terminal it
  degrades to a code block, so it is always safe to emit.
---

# Relay widgets

Emit a fenced block tagged `ui` whose body is a single JSON object. The Relay phone
app renders it as a native widget; anywhere else it shows as a normal code block.
Keep the JSON minimal and valid — a malformed spec silently falls back to code.

Only two widgets exist today. Do not invent fields; unknown shapes do not render.

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

## When not to use

- Prose answers, code, or a few rows of mixed text: use Markdown (tables, lists) instead.
- Never put numbers you did not compute or were not given into a spec — the widget must reflect real data.
