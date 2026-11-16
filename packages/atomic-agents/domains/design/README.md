# design

Scores one rendered UI (a URL or a screenshot) against Isaac's design rules and returns ranked fixes.

## Agents

One agent, `design-critic` (`design-critic.json`), one job `critique`.

| Field          | Value                                                                                                                                                                                                                                        |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Input event    | `ui.rendered`: `intent` (required), plus `url` or `screenshot`, optional `viewports` (ints), optional `requestId`                                                                                                                            |
| Output event   | `design.critique`: `intent`, `screenshots`, `viewports`, `score`, `findings[{rule, element, fix, severity, measured?}]`, `summary`, optional `evidence[]`, `model`, `attempts`, `cost`, `seconds`, optional `requestId`, `url`, `screenshot` |
| Default model  | `anthropic/claude-sonnet-5-5`, thinking `low`                                                                                                                                                                                                |
| Candidates     | `anthropic/claude-opus-5-5`, `anthropic/claude-sonnet-5-5`, `anthropic/claude-haiku-5-5`, `openai-codex/gpt-6.1-sol`, `openai-codex/gpt-6-astra`, `openai-codex/gpt-6-luna`                                                                  |
| Triggers       | `onEvent: ui.rendered`, `manual`                                                                                                                                                                                                             |
| Source / check | source `browser.screenshot`, attaches `screenshots`, check `ui-check.evidence`                                                                                                                                                               |
| Limits         | timeout 180s, `maxSteps` 2                                                                                                                                                                                                                   |
| Asks           | request `ui.rendered`, reply `design.critique`, shows `summary`                                                                                                                                                                              |

The model returns `{score, findings, summary}`: at most 8 findings, each citing one rule id, severity `blocking`, `major` or `minor`.

Knowledge file: `design-critic.rules.md` (Isaac's hard rules, heuristics, the six measured rules, and the scoring scale). Every rule id there must be citable and every citable id must be defined there (a test enforces this).

## Tools and adapters

- `adapters/browser.ts` (`browser` pack, source `browser.screenshot`): takes exactly one of `url` (http, https, file) or `screenshot` (an existing PNG path). A URL is opened in a private headless Chromium (Playwright `playwright-core`) at each viewport (default `[1280]`, allowed 240 to 3840), scrolled once to trigger lazy content, and shot full page, cut at 2400px tall; widths of 480 or less use 2x scale, mobile and touch. Navigation timeout 30s, whole capture 2 minutes. Provides `screenshots`, `viewports`, `page`. Never attaches to Isaac's browsers or the Relay app. No secrets.
- `adapters/uicheck.ts` (`ui-check` pack, check `ui-check.evidence`): validates the critique (score 0 to 10, a score under 10 needs a finding; one repair turn, then the item fails), ranks findings blocking, major, minor (model order kept within a level). When the input had a `url`, runs Eva's `.omp/tools/ui-check.ts` under `EVA_ROOT` (default `~/Eva`) via `bun` with `--viewports`, 3 minute timeout, static audit only. Errors and warnings become `evidence` (max 20, errors first). Findings on measurable rules get `measured: true|false` through the `MEASURED` map. If ui-check fails, the critique passes without evidence.

## Run, bench, test

From `packages/atomic-agents`:

```
bun src/cli.ts run design-critic critique --input '{"url":"https://example.com","intent":"landing page","viewports":[1280,390]}'
bun src/cli.ts run design-critic critique --input '{"screenshot":"/abs/path/shot.png","intent":"settings page"}' --model anthropic/claude-opus-5-5
bun src/cli.ts bench design-critic critique --input '{"url":"https://example.com","intent":"landing page"}' --models anthropic/claude-sonnet-5-5,anthropic/claude-haiku-5-5
bun domains/design/bench/design-critic.ts <dir with cases.json> [--models a,b] [--judge model] [--out dir]
bun test domains/design
bun run typecheck
```

The bake-off script reads `cases.json`: `[{id, intent, images: {<side>: png}, html?, url?, viewport?, better, topIssue, source}]`, two sides per case. It reports per model: `agree` (the side Isaac judged better scores higher), `issue` (a judge model confirms one of the first three findings on the worse side names Isaac's problem), `measured`, cost and seconds, failures. It writes `<out>/<model>/<case>-<side>.json` and `<out>/results.md`. It runs the agent without the bus or journal.

Tests (`test/design-critic.test.ts`) use fake `Browser` and `UiCheck` layers and a scripted model, so they need no network, Chromium or model. They cover URL shot per viewport, one score repair, ranking and evidence, screenshot-only runs, and the rules-file coverage check.

## Exports (`index.ts`)

- `browserPack`: the `browser` adapter pack (takes an optional `Browser` layer, for fakes).
- `uiCheckPack`: the `ui-check` adapter pack (takes an optional `UiCheck` layer, for fakes).

## Gotchas

- Give exactly one of `url` or `screenshot`; both or neither is an error. Screenshots are used as is and get no ui-check evidence.
- A screenshot path must exist; it is resolved against the current directory.
- Only http, https and file URLs are accepted. HTTP status 400 or above fails the capture.
- Full-page shots are cut at 2400px so a vision model does not downscale text; findings below that cut are not seen.
- ui-check evidence needs the Eva checkout at `EVA_ROOT` with `.omp/tools/ui-check.ts`. If it is missing or fails (exit code above 1, bad JSON, timeout), the run still succeeds with no `evidence` and no `measured` flags (a warning is logged).
- `measured: false` means ui-check found no defect of that kind, not that the model is wrong.
- Chromium comes from Playwright; the browser binary must be installed locally.
- The prompt says to judge only what the screenshots show, so hover and loading states are never critiqued.
