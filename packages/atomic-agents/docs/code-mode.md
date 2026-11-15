# Tool modes: when to use code mode, when to use tools mode

Every chef with tools runs in one of two tool modes. **tools** (the default): the model calls one tool per turn and reads each result. **code**: the model's only tool is `run_code`; it writes one TypeScript script per turn against the chef's tools as typed functions (`src/CodeMode.ts`), which runs in a sandbox (no network except through the functions, writes only in a temp dir, 240 s, 512 MB) and returns only what the answer needs.

## Use code mode for

- **Chained, dependent calls**: search, then read the top hits, then look up what they name, in one turn instead of one model round trip each.
- **Filtering or looping over large results**: read whole pages or long lists and keep only the lines a regex or a condition picks, so the model's window holds the evidence, not the haystack.
- **Large tool catalogs**: the tools are one typed API in the prompt, not a menu the model picks from turn by turn.
- **Bulk, repeatable data work**: the same steps over many items, such as a Marketplace sweep, a NAS photo cleanup, bulk Linear or GitHub reads.

## Use tools mode for

- **Simple tasks with a few known tools**: one or two calls the model makes anyway (ecard-ticket-intake reads one ticket).
- **Read-and-judge work**, such as plain web search over broad questions: the model should see the text and decide what matters, not pre-filter it with a regex.

## What the evidence says

From the web-researcher bake-off, 3 rounds, Haiku 5.5 and Opus 5.5 (write-up: `~/Eva/work/atomic-agents-proof/web-researcher-bench/needle/results-codemode.md` on the Mac Mini, outside this repo; summary in `PLAN.md` § Code mode):

- **The example script decides script quality.** With a one-call example (`const r = await search(...); return r`) Haiku copied it, returned raw search results, once called `read` as if it were a tool, and scored needle 5/6. With the chef's `codeExample`, which searches, reads the top 3 pages at once and keeps the passages a regex matches, it scored 11/12 over two rounds. Every chef with tools must ship a `job.codeExample` showing the pattern it wants.
- **Haiku regresses on broad questions in code mode**: 20/30 hits vs 26/30 in tools mode on the original set. Its regex-trimmed snippets drop context the answer needs. On single-fact needle questions it gains: 16/18 vs 14/18, half the cost, p50 21 s vs 46 s.
- **Opus is as good or better in code mode**: needles 18/18 vs 17/18, broad questions 29/30 vs 27/30, 23% cheaper on the broad set. Quote validity was equal in both modes.

So the mode is a per model and per question kind choice, not a blanket switch. Bake it off.

## Switching and comparing

- Chef file default: `job.toolMode` (`tools` when absent). Every shipped chef stays `tools`.
- Live, per chef: `atomic-agents use <chef> --tool-mode code` (or with a model: `use <chef> <model> --tool-mode code`), or a `config.set` patch `{"components": {"<chef>": {"toolMode": "code"}}}`. The service applies it from the next run; the `config.changed` event's `undo` patch, emitted back as `config.set`, reverts it. A chef without tools has no tool mode and config refuses one.
- Bake-off: `atomic-agents bench <chef> <job> --models a,b --tool-modes tools,code` runs every model in every mode; `rate` and `wins` track each arm as `model [mode]`. The scripted benches take the same flag (`bun src/bench/web-researcher.ts <dir> --tool-modes tools,code`, `bun src/bench/ecard.ts <chef> --tool-modes tools,code`).

## Writing a chef for both modes

- Give every tool adapter a `returns` schema next to the code that builds its value: it becomes the script's return type.
- Write `job.codeExample` as the pattern you want: independent calls in `Promise.all`, cut long text down, return only the fields the answer needs with their source (url, key, sha).
