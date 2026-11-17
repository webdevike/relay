# Style: tokens, type, primitives

Every color comes from the theme's tokens below; never invent a hex. Copy the theme's `<defs>` block as is and draw with its classes, so every diagram shares one skin and the SVG stays short.

## Tokens

| Role     | Dark      | Light     | Use                                                      |
| -------- | --------- | --------- | -------------------------------------------------------- |
| `paper`  | `#2d3142` | `#f5f5f5` | Canvas, label masks                                      |
| `ink`    | `#f5f5f5` | `#2d3142` | Names, title, primary strokes                            |
| `muted`  | `#bfc0c0` | `#4f5d75` | Sublabels, default connectors, arrow labels, legend text |
| `soft`   | `#8e98ac` | `#7a8399` | Dashed write-backs, zone labels, tertiary text           |
| `accent` | `#f08a59` | `#eb6c36` | 1 or 2 focal elements, the headline path                 |
| `link`   | `#6a95d8` | `#2e5aa8` | Calls to external systems, HTTP or API                   |

Node fills are pre-blended onto paper so they are opaque (no mask rect needed under a node):

| Treatment    | When                                        | Dark fill / stroke                 | Light fill / stroke                |
| ------------ | ------------------------------------------- | ---------------------------------- | ---------------------------------- |
| `n-focal`    | 1 or 2 focal nodes                          | `#403a44` / `#f08a59` 1.2          | `#f4eae6` / `#eb6c36` 1.2          |
| `n-step`     | Default step, service, action               | `#393e53` / `#f5f5f5`              | `#ffffff` / `#2d3142`              |
| `n-store`    | State, resource, data that persists         | `#373b4b` / `#bfc0c0`              | `#ebebec` / `#4f5d75`              |
| `n-external` | Outside actor, external system, enemy force | `#33374a` / `#696c78`              | `#efeff0` / `#b9babf`              |
| `n-input`    | Player or user input, trigger               | `#3c3f4f` / `#8e98ac`              | `#e4e6e8` / `#7a8399`              |
| `n-optional` | Optional or conditional                     | `#2f3344` / `#555866` dashed `4 3` | `#f1f1f2` / `#cdced1` dashed `4 3` |
| `n-risk`     | Failure, loss, boundary, game over          | `#373543` / `#8f5e4e` dashed `4 4` | `#f5eeeb` / `#f0b196` dashed `4 4` |
| `n-hub`      | The one accumulated-state center (Loop)     | `#f5f5f5`, text in paper           | `#2d3142`, text in paper           |

## Typography

Three families, no more: Instrument Serif (title and italic callouts), Geist (names, legend), Geist Mono (eyebrows, tags, sublabels, arrow labels). The renderer loads all three.

| Role                | Class        | Font                                      | Size                                         |
| ------------------- | ------------ | ----------------------------------------- | -------------------------------------------- |
| Eyebrow             | `eyebrow`    | Geist Mono 500, uppercase, tracked 0.18em | 8                                            |
| Title               | `title`      | Instrument Serif 400                      | 28                                           |
| Subtitle (optional) | `subtitle`   | Geist 400                                 | 12                                           |
| Node name           | `name`       | Geist 600                                 | 12 (13 or 14 for states and hubs: `name-lg`) |
| Sublabel            | `sub`        | Geist Mono 400                            | 9                                            |
| Type tag in a node  | `tag`        | Geist Mono 500, tracked                   | 7                                            |
| Arrow label         | `label`      | Geist Mono 400, uppercase, tracked 0.06em | 8                                            |
| Zone label          | `zone-label` | Geist Mono 500, uppercase, tracked 0.14em | 7                                            |
| Legend text         | `legend`     | Geist 400                                 | 8.5                                          |
| Callout             | `callout`    | Instrument Serif italic                   | 14                                           |

Nothing smaller than 7. Width budget: characters x font size x 0.60 (sans) or 0.62 (mono, tracked labels add 0.06 to 0.18em per character).

## Dark `<defs>` (copy verbatim)

```svg
<defs>
  <style>
    .paper { fill: #2d3142; }
    .eyebrow { fill: #bfc0c0; font: 500 8px 'Geist Mono', 'SF Mono', Menlo, monospace; letter-spacing: 0.18em; }
    .title { fill: #f5f5f5; font: 400 28px 'Instrument Serif', 'Noto Serif', Georgia, serif; letter-spacing: -0.02em; }
    .subtitle { fill: #bfc0c0; font: 400 12px 'Geist', 'Helvetica Neue', Arial, sans-serif; }
    .name { fill: #f5f5f5; font: 600 12px 'Geist', 'Helvetica Neue', Arial, sans-serif; text-anchor: middle; }
    .name-lg { fill: #f5f5f5; font: 600 14px 'Geist', 'Helvetica Neue', Arial, sans-serif; text-anchor: middle; }
    .name-accent { fill: #f08a59; }
    .sub { fill: #bfc0c0; font: 400 9px 'Geist Mono', 'SF Mono', Menlo, monospace; text-anchor: middle; }
    .tag { fill: #bfc0c0; font: 500 7px 'Geist Mono', 'SF Mono', Menlo, monospace; letter-spacing: 0.08em; text-anchor: middle; }
    .label { fill: #bfc0c0; font: 400 8px 'Geist Mono', 'SF Mono', Menlo, monospace; letter-spacing: 0.06em; text-anchor: middle; }
    .label-accent { fill: #f08a59; }
    .label-soft { fill: #8e98ac; }
    .zone-label { fill: #8e98ac; font: 500 7px 'Geist Mono', 'SF Mono', Menlo, monospace; letter-spacing: 0.14em; text-anchor: middle; }
    .legend { fill: #bfc0c0; font: 400 8.5px 'Geist', 'Helvetica Neue', Arial, sans-serif; }
    .callout { fill: #f5f5f5; font: italic 400 14px 'Instrument Serif', 'Noto Serif', Georgia, serif; }
    .hub-name { fill: #2d3142; font: 600 16px 'Geist', 'Helvetica Neue', Arial, sans-serif; text-anchor: middle; }
    .hub-sub { fill: #2d3142; font: 400 9px 'Geist Mono', 'SF Mono', Menlo, monospace; text-anchor: middle; }
    .mask { fill: #2d3142; }
    .n-focal { fill: #403a44; stroke: #f08a59; stroke-width: 1.2; }
    .n-step { fill: #393e53; stroke: #f5f5f5; stroke-width: 1; }
    .n-store { fill: #373b4b; stroke: #bfc0c0; stroke-width: 1; }
    .n-external { fill: #33374a; stroke: #696c78; stroke-width: 1; }
    .n-input { fill: #3c3f4f; stroke: #8e98ac; stroke-width: 1; }
    .n-optional { fill: #2f3344; stroke: #555866; stroke-width: 1; stroke-dasharray: 4 3; }
    .n-risk { fill: #373543; stroke: #8f5e4e; stroke-width: 1; stroke-dasharray: 4 4; }
    .n-hub { fill: #f5f5f5; }
    .tagbox { fill: none; stroke: #696c78; stroke-width: 0.8; }
    .zone { fill: #33374a; stroke: #454958; stroke-width: 0.8; }
    .rule { stroke: #454958; stroke-width: 0.8; }
    .c { fill: none; stroke: #bfc0c0; stroke-width: 1.2; }
    .c-accent { fill: none; stroke: #f08a59; stroke-width: 1.4; }
    .c-link { fill: none; stroke: #6a95d8; stroke-width: 1.2; }
    .c-dash { fill: none; stroke: #bfc0c0; stroke-width: 1; stroke-dasharray: 5 4; }
    .c-soft { fill: none; stroke: #8e98ac; stroke-width: 1; stroke-dasharray: 5 4; }
    .dot { fill: #f5f5f5; }
  </style>
  <marker id="arrow" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto"><polygon points="0 0, 8 3, 0 6" fill="#bfc0c0"/></marker>
  <marker id="arrow-accent" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto"><polygon points="0 0, 8 3, 0 6" fill="#f08a59"/></marker>
  <marker id="arrow-link" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto"><polygon points="0 0, 8 3, 0 6" fill="#6a95d8"/></marker>
  <marker id="arrow-soft" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto"><polygon points="0 0, 8 3, 0 6" fill="#8e98ac"/></marker>
</defs>
```

## Light `<defs>` (copy verbatim)

```svg
<defs>
  <style>
    .paper { fill: #f5f5f5; }
    .eyebrow { fill: #4f5d75; font: 500 8px 'Geist Mono', 'SF Mono', Menlo, monospace; letter-spacing: 0.18em; }
    .title { fill: #2d3142; font: 400 28px 'Instrument Serif', 'Noto Serif', Georgia, serif; letter-spacing: -0.02em; }
    .subtitle { fill: #4f5d75; font: 400 12px 'Geist', 'Helvetica Neue', Arial, sans-serif; }
    .name { fill: #2d3142; font: 600 12px 'Geist', 'Helvetica Neue', Arial, sans-serif; text-anchor: middle; }
    .name-lg { fill: #2d3142; font: 600 14px 'Geist', 'Helvetica Neue', Arial, sans-serif; text-anchor: middle; }
    .name-accent { fill: #c4521f; }
    .sub { fill: #4f5d75; font: 400 9px 'Geist Mono', 'SF Mono', Menlo, monospace; text-anchor: middle; }
    .tag { fill: #4f5d75; font: 500 7px 'Geist Mono', 'SF Mono', Menlo, monospace; letter-spacing: 0.08em; text-anchor: middle; }
    .label { fill: #4f5d75; font: 400 8px 'Geist Mono', 'SF Mono', Menlo, monospace; letter-spacing: 0.06em; text-anchor: middle; }
    .label-accent { fill: #c4521f; }
    .label-soft { fill: #7a8399; }
    .zone-label { fill: #7a8399; font: 500 7px 'Geist Mono', 'SF Mono', Menlo, monospace; letter-spacing: 0.14em; text-anchor: middle; }
    .legend { fill: #4f5d75; font: 400 8.5px 'Geist', 'Helvetica Neue', Arial, sans-serif; }
    .callout { fill: #2d3142; font: italic 400 14px 'Instrument Serif', 'Noto Serif', Georgia, serif; }
    .hub-name { fill: #f5f5f5; font: 600 16px 'Geist', 'Helvetica Neue', Arial, sans-serif; text-anchor: middle; }
    .hub-sub { fill: #f5f5f5; font: 400 9px 'Geist Mono', 'SF Mono', Menlo, monospace; text-anchor: middle; }
    .mask { fill: #f5f5f5; }
    .n-focal { fill: #f4eae6; stroke: #eb6c36; stroke-width: 1.2; }
    .n-step { fill: #ffffff; stroke: #2d3142; stroke-width: 1; }
    .n-store { fill: #ebebec; stroke: #4f5d75; stroke-width: 1; }
    .n-external { fill: #efeff0; stroke: #b9babf; stroke-width: 1; }
    .n-input { fill: #e4e6e8; stroke: #7a8399; stroke-width: 1; }
    .n-optional { fill: #f1f1f2; stroke: #cdced1; stroke-width: 1; stroke-dasharray: 4 3; }
    .n-risk { fill: #f5eeeb; stroke: #f0b196; stroke-width: 1; stroke-dasharray: 4 4; }
    .n-hub { fill: #2d3142; }
    .tagbox { fill: none; stroke: #b9babf; stroke-width: 0.8; }
    .zone { fill: #f1f1f2; stroke: #e1e1e3; stroke-width: 0.8; }
    .rule { stroke: #e1e1e3; stroke-width: 0.8; }
    .c { fill: none; stroke: #4f5d75; stroke-width: 1.2; }
    .c-accent { fill: none; stroke: #eb6c36; stroke-width: 1.4; }
    .c-link { fill: none; stroke: #2e5aa8; stroke-width: 1.2; }
    .c-dash { fill: none; stroke: #4f5d75; stroke-width: 1; stroke-dasharray: 5 4; }
    .c-soft { fill: none; stroke: #7a8399; stroke-width: 1; stroke-dasharray: 5 4; }
    .dot { fill: #2d3142; }
  </style>
  <marker id="arrow" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto"><polygon points="0 0, 8 3, 0 6" fill="#4f5d75"/></marker>
  <marker id="arrow-accent" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto"><polygon points="0 0, 8 3, 0 6" fill="#eb6c36"/></marker>
  <marker id="arrow-link" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto"><polygon points="0 0, 8 3, 0 6" fill="#2e5aa8"/></marker>
  <marker id="arrow-soft" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto"><polygon points="0 0, 8 3, 0 6" fill="#7a8399"/></marker>
</defs>
```

In light theme, accent text uses the darker `#c4521f` (`name-accent`, `label-accent`) so it stays legible on paper; accent strokes keep `#eb6c36`.

## Primitives

Canvas and header band (W x H is the viewBox):

```svg
<rect class="paper" width="W" height="H"/>
<text class="eyebrow" x="40" y="44">LOOP · SOLSTICE</text>
<text class="title" x="40" y="80">The day and night loop</text>
```

Node box (name plus sublabel, 64 tall; a type tag is optional, use it when node kinds need naming):

```svg
<rect class="n-step" x="X" y="Y" width="160" height="64" rx="6"/>
<rect class="tagbox" x="X+8" y="Y+8" width="36" height="12" rx="2"/>
<text class="tag" x="X+26" y="Y+17">PHASE</text>
<text class="name" x="X+80" y="Y+36">Node name</text>
<text class="sub" x="X+80" y="Y+52">short sublabel</text>
```

Without a tag, center the name at `Y+28` and the sublabel at `Y+46` (48 to 56 tall boxes: name at the vertical middle plus 4). The tag sits inside the box; the name must clear it.

Connectors (draw before nodes):

```svg
<line class="c" x1="X1" y1="Y" x2="X2" y2="Y" marker-end="url(#arrow)"/>
<!-- right then down, elbow at mid with r=8 -->
<path class="c" d="M x1,y1 H mid-8 Q mid,y1 mid,y1+8 V y2-8 Q mid,y2 mid+8,y2 H x2" marker-end="url(#arrow)"/>
<!-- one bend: leave the side facing the target, run across, turn once, enter the top or bottom edge -->
<path class="c" d="M x1,y1 H x2-8 Q x2,y1 x2,y1+8 V y2" marker-end="url(#arrow)"/>
<!-- hop over a crossing at x=cx on a horizontal line -->
<path class="c-dash" d="M x1,y H cx-8 a 8,8 0 0,1 16,0 H x2" marker-end="url(#arrow)"/>
```

The arrowhead tip lands on the target's edge: end the path exactly on the edge (the marker is drawn back from the end point). Headline path: `c-accent` with `url(#arrow-accent)`. External calls: `c-link` with `url(#arrow-link)`. Return, async, optional, write-back: `c-dash` or `c-soft` with the matching marker.

Arrow label (mask first, then text; the mask's bottom edge sits 6 to 10px above a horizontal stroke at ARROW_Y):

```svg
<rect class="mask" x="MID-24" y="ARROW_Y-20" width="48" height="12" rx="2"/>
<text class="label" x="MID" y="ARROW_Y-11">SPENDS</text>
```

Mask width: characters x 5.4 plus 12, rounded up to a multiple of 4. Beside a vertical segment, the mask starts 8px to the side of the line.

Zone (groups 2 or more nodes of one tier, phase or boundary; at most 3 zones; drawn first):

```svg
<rect class="zone" x="ZX" y="ZY" width="ZW" height="ZH" rx="8"/>
<rect class="mask" x="ZX+12" y="ZY+6" width="LABEL_W" height="12" rx="2"/>
<text class="zone-label" x="ZX+12+LABEL_W/2" y="ZY+15">NIGHT</text>
```

Leave 16px or more between the zone label and the first node inside; nodes keep 16px from the zone edge.

Legend strip (bottom of the canvas):

```svg
<line class="rule" x1="40" y1="LY" x2="W-40" y2="LY"/>
<text class="eyebrow" x="40" y="LY+20">LEGEND</text>
<rect class="n-focal" x="120" y="LY+12" width="14" height="10" rx="2"/>
<text class="legend" x="140" y="LY+20">Focal step</text>
<line class="c-dash" x1="280" y1="LY+17" x2="308" y2="LY+17" marker-end="url(#arrow)"/>
<text class="legend" x="316" y="LY+20">Return / async</text>
```

Annotation callout (at most 2, in a margin, never inside the active diagram):

```svg
<text class="callout" x="X" y="Y" text-anchor="end">survive night 3 and the region is yours</text>
<path d="M x1 y1 Q cx cy x2 y2" fill="none" stroke="#8e98ac" stroke-width="1" stroke-dasharray="4,3"/>
<circle class="dot" cx="x2" cy="y2" r="2"/>
```

Start and end markers (State, Flowchart): start is a filled `dot` circle `r=6`; end is a ring `r=8` (no fill, ink stroke) around a filled `r=5` dot. Flowchart decision: a diamond `<polygon>` in `n-step` with at most 3 exits, every exit labeled.
