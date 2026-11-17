# diagram

Turns a description of a flow, loop, architecture or structure into one polished diagram image: an SVG the model lays out by hand on an editorial design system, rendered to PNG in headless Chromium and checked before it is returned. The first agent written as a folder (`agents/diagram/AGENT.md`, format in `docs/agent-folders.md`); its knowledge is distilled from the diagram-design skill and stands alone.

## Agents

| id                                    | job                                                       | request -> reply                                                                                                                                                                                                                                    | default model                                    | triggers                               |
| ------------------------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | -------------------------------------- |
| `diagram` (`agents/diagram/AGENT.md`) | `draw`: brief, draw one SVG, render and check, one repair | `diagram.requested` `{description, kind?: flow\|loop\|sequence\|architecture\|state\|timeline, title?, theme?: dark\|light}` -> `diagram.rendered` `{image, svg, source, summary, warnings?, theme, width, height, model, attempts, cost, seconds}` | `anthropic/claude-sonnet-5-5`, thinking `medium` | `onEvent: diagram.requested`, `manual` |

- Asked as a pair (`show: image`): `agents_ask {agent: "diagram", request: {description: "..."}}` answers the PNG path.
- `schema.ts`: `DiagramRequested` and `DiagramRendered` (Effect Schema), registered by the pack as `diagram.requested` and `diagram.rendered`.
- Candidates: `anthropic/claude-sonnet-5-5`, `openai-codex/gpt-6-sol`, `anthropic/claude-opus-5-5`. No tools: one model call draws, the check measures, one repair call fixes.

## Knowledge (`agents/diagram/knowledge/`, loaded whole, about 37 KB)

- `rules.md`: philosophy (deletion first, density 4/10, accent on 1 or 2 elements), choosing the type, fitting a big description (merge, collapse, drop, never invent), anti-patterns, the six connector rules, layout grid and margins, words, accessible SVG, the taste gate.
- `style.md`: dark and light tokens, node treatments pre-blended to opaque fills, the type ramp (Instrument Serif, Geist, Geist Mono), a `<defs>` block per theme to copy (classes and the four arrow markers), and the primitives (header band, node, connectors, arrow label, zone, legend, callout).
- `types.md`: layout grammar per kind: flowchart, loop (with the ring and spoke geometry), sequence, architecture, state machine and lifecycle map, timeline, plus tree and layer stack for structures.
- `examples.md`: two finished diagrams (dark loop, light flowchart) that pass the render check (a test keeps them passing).

## Adapters (`adapters/`)

- `pack.ts`, the `diagram` pack: schemas, the `diagram.brief` step (the request as the model's brief; theme defaults to dark) and the `diagram.render` check.
  - The check takes the SVG from the reply (fenced or bare) and the words around it as `summary`, makes it standalone (SVG namespace, Google Fonts `@import` after `<title>` and `<desc>`), writes `diagram-<attempt>.svg` and renders `diagram-<attempt>.png` in the run dir.
  - Any problem gets one repair turn listing every problem plus the SVG. After the repair, legibility leftovers ship as `warnings`; a render that is not usable (unparsable, unframed, blank, too few labels) fails the run, unless the first render was usable, which then ships with its warnings.
- `renderer.ts`, the `Renderer` service: Playwright's headless shell per render (no window, never Isaac's browsers), theme paper behind, fonts loaded, the SVG at its viewBox size, shot at 2x. Limits: font 7px and up, contrast 3:1, viewBox 480 to 1920 wide and 240 to 1920 tall, at least 3 labels, overlap 15%, 2px slack.
- `page.ts`, the measurement run in the page: XML parse, frame, `<title>` first and `<desc>`, a painted canvas corner, dangling `url(#id)`, then per text its size, edge clipping, contrast against the shapes painted under it (composited), sideways spill out of its rect, and text-on-text overlap; finally the share of inked pixels.

## Run, bench, test

From `packages/atomic-agents`:

```
bun src/cli.ts run diagram draw --input '{"description":"...","kind":"loop"}'
bun src/cli.ts ask diagram '{"description":"..."}' --timeout 300s
bun domains/diagram/agents/diagram/bench/bake.ts --models anthropic/claude-sonnet-5-5,openai-codex/gpt-6-sol --out <judge dir> --key <key dir>
bun test domains/diagram
```

- `bench/cases.json`: the Solstice day and night loop (loop, dark), how a specialist answers in Relay (architecture, dark), a Solstice building's lifecycle (state, light).
- `bench/bake.ts` draws every case with two models through the agent's model stage, then writes the blind pick (side-by-side `<case>.png` with random A/B sides, full-size `<case>-A.png` and `-B.png`, `README.md`) to `--out` and the key (`key.json`, `results.md`, run dirs) to `--key`.
- The tests run the agent with a scripted model and a fake renderer (brief, instructions, repair, warnings, fallback, failure), and the real renderer on the knowledge examples and on a defective SVG.
- Needs Playwright's headless shell for playwright-core 1.64.1 (`node_modules/.bin/playwright-core install chromium-headless-shell`, revision 1248) and network for the fonts (without it the render falls back to system fonts).
