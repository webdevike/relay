# creative

Creative choices left open: a name, copy, a concept or a visual direction. The agent returns N distinct options that are not the average pick, each with the obvious pick it moved away from and why it fits this project. Its method is the antialgorithm skill by mankidev (https://github.com/mankidev/antialgorithm, MIT, Copyright (c) 2026 mankidev; the license is kept in [`LICENSE-antialgorithm`](LICENSE-antialgorithm)), rewritten as an agent folder that stands alone.

## Agents

| id                                              | job                                                                                  | request -> reply                                                                                                                                                                                                                           | default model                                    | triggers                                |
| ----------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------ | --------------------------------------- |
| `anti-average` (`agents/anti-average/AGENT.md`) | `options`: brief (seeds when the context is thin), one model call, check, one repair | `creative.requested` `{kind: name\|copy\|concept\|visual-direction, brief, context?, count? 1-8, default 5}` -> `creative.options` `{kind, brief, options: [{option, avoided, why}], pick, pickWhy, text, model, attempts, cost, seconds}` | `anthropic/claude-sonnet-5-5`, thinking `medium` | `onEvent: creative.requested`, `manual` |

- Asked as a pair (`show: text`): `agents_ask {agent: "anti-average", request: {kind: "name", brief: "...", context: "...", count: 4}}` answers the options as Markdown.
- No tools: one model call makes the options, the check parses and measures them, one repair call fixes.
- Candidates: `anthropic/claude-haiku-5-5`, `anthropic/claude-sonnet-5-5`, `openai-codex/gpt-6.1-sol` (subscription models on native providers). Only Sonnet 5.5 has been run in the bake-off; the default is not a measured winner over the others.

## Start point: context or seed

The skill's first rule: the start point comes from outside the model's own taste. With `context` of 200 characters or more, every option starts from a fact in it. With less (or none), the `creative.brief` step rolls one seed per option from the skill's pools, in code (`adapters/seed.ts`, a port of `scripts/seed.py`: voice, entry and register for names and copy; verb, constraint, scale and pressure for concepts; method, color, layout, type, verb and scale for visual directions; plus a setting, a region and an anchor) and the agent ties each seed to the subject with a reason. Give real context whenever there is some: it is what makes an option fit.

## Knowledge (`agents/anti-average/knowledge/`, loaded whole, about 12 KB)

- `rules.md`: where to start, the default and moving away, options and the pick, the escapes that become defaults, the check before replying.
- `text.md`: the marks of default AI text and how a real person would write it, plus what makes a default name (names and copy).
- `ideas.md`: verb, scale, constraint and pressure for concepts; every idea names its cost or failure case.
- `visual.md`: the finish that gives a machine-made image away, methods and their marks, when not to roughen (interfaces), what must keep its job.

Not ported: `scripts/rough.py` and `scripts/check.py`, which roughen and render an SVG. This agent answers in words and returns no image; a caller that draws the direction runs those on its own output.

## Adapters (`adapters/`)

- `pack.ts`, the `creative` pack: schemas, the `creative.brief` step (the request as the model's brief, seeds only when thin) and the `creative.options` check. The check parses one JSON object and sends one repair turn when it is not valid JSON, has the wrong number of options, an empty field, an option equal to its own `avoided`, two options that are the same, a `pick` outside the list, or an exclamation mark in copy; a reply still broken after the repair fails the run.
- `seed.ts`, the seed pools and roll (random source: `crypto.getRandomValues`; tests pass their own).

## Run, bench, test

From `packages/atomic-agents`:

```
bun src/cli.ts run anti-average options --input '{"kind":"name","brief":"...","context":"...","count":4}'
bun src/cli.ts ask anti-average '{"kind":"copy","brief":"...","context":"..."}' --timeout 120s
bun domains/creative/agents/anti-average/bench/bake.ts --out <judge dir> --key <key dir> [--model m] [--only id,id]
bun test domains/creative
```

- `bench/cases.json`: six real briefs from Isaac's projects: the Solstice orbital ability (name), the Solstice promo tagline (copy), the Soundly picks agent (name), the GoodOps demand letter page headline (copy), the Solstice HUD and the Solstice promo (visual directions).
- `bench/bake.ts` answers every case twice on one model: the agent as shipped, and a plain prompt (the same brief, context, count and reply shape, no method, knowledge or seed). It writes `sheet.md` to `--out` (per case the request, then option sets A and B in random order per case, rendered identically, and a ballot; nothing names an arm) and `key.json` (which arm is A, cost, seconds, calls per set), `results.md` and the raw runs to `--key`.
