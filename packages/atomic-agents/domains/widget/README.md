# widget

Given an assistant's draft reply and its data, picks the Relay chat widget (an OpenUI Lang program) for it, or none, and guarantees any block passes Relay's parser.

## Agents

One spec, `widget.json` (component `widget`, job `pick`). No code-defined agents.

| Field           | Value                                                                                                                        |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Job             | `widget` / `pick`: "Pick the Relay widget block for a draft reply and its data, or none"                                     |
| Input -> output | `widget.requested` -> `widget.ready`                                                                                         |
| Default model   | `anthropic/claude-sonnet-5-5`, thinking `off`                                                                                |
| Candidates      | `anthropic/claude-sonnet-5-5`, `openrouter/google/gemini-3.8-flash`, `anthropic/claude-haiku-5-5`, `openai-codex/gpt-6-luna` |
| Triggers        | `{ "onEvent": "widget.requested" }` and `manual`                                                                             |
| Timeout         | 30 seconds                                                                                                                   |
| Steps / check   | step `widget.prompt`, check `openui.parse`                                                                                   |
| On failure      | `widget.ready` with `kind: none`, `why: "failed: {{message}}"`                                                               |
| Asks            | request `widget.requested`, reply `widget.ready`, shows `block`                                                              |

Events in the spec:

- `widget.requested`: `requestId`, `draft`, optional `data` (json), `surface` (`phone` | `desktop`), optional `context` (`channel` `text` | `voice`, optional `askedForDetail`), optional `form` (`chart` | `table` | `card`).
- `widget.ready`: `requestId`, `kind` (`openui` | `none`), optional `block`, `why`.
- `widget.logged`: `requestId`, `mode` (`shadow` | `live`), `agent`, `message`, `surface`, `kind` (`openui` | `none` | `timeout`), `ms`, `shown`. Declared in the spec only; nothing in this domain emits it.
- `widget.labeled`: `agent`, `message`, `surface`, `label` (`keep`, `plain`, `chart`, `table`, `card`, `other`), `shown` (`openui` | `none`). Isaac's answer; declared in the spec only.

The system prompt holds the WHEN rules (default none, one widget per reply, never invent data) and the OpenUI Lang rules. `{{check}}` is replaced with the component signatures from the `openui` pack.

## Tools and adapters

- `adapters/widget.ts` (pack `widget`): step `widget.prompt`. Decodes the request and builds the prompt: surface, how Isaac asked (when `context` is set), "Isaac picked the form: X" (when `form` is set), the draft, and `data` as JSON or `(none)`. Pure code, no external systems.
- `adapters/openui.ts` (pack `openui`): check `openui.parse`. Reads `why: ...` then `none` or a program, and validates the program with `parseOpenUI` from `@evaos/chat-core/openui`. Component signatures come from `relayLibrary` in `@evaos/chat-core/openui/library`, limited to the taught list. A rejected program is sent back once with the parser errors; if still broken the answer is `none` with a `why` naming the first error. Passing output fields: `kind`, `block` (program in an ` ```openui ` fence), `why`. Reads no secrets and calls no network or CLI itself; the model call goes through the shared model runner.

## Run, bench, test

From `packages/atomic-agents`:

```
bun src/cli.ts run widget pick --input '{"requestId":"r1","draft":"Same helper in TS and Python.","surface":"phone"}'
bun src/cli.ts run widget pick --input '<json>' --model anthropic/claude-haiku-5-5
bun src/cli.ts bench widget pick --input '<json>' --models a,b
bun domains/widget/bench/widget.ts [--models a,b,c] [--repeat 2]
bun test domains/widget
bun run typecheck
```

- The bench script calls the agent's model stage directly (no bus, no journal) on every case, every model. It reports right kind, renders (first try and after the one repair), p50/p95 seconds, and cost per request. Default models are the spec candidates.
- Cases: `bench/widget-cases.json` (answer key from real assistant drafts; `expect` lists widget keys the block must hold, empty means none) plus Isaac's answers in `<home>/bench/widget/training.jsonl`, loaded when that file exists.
- `test/widget.test.ts` uses a scripted model (no network) over a temp home with the shipped `widget.json`.

## Exports (index.ts)

- `openui`: the pack holding the `openui.parse` check.
- `widget`: the pack holding the `widget.prompt` step.

## Gotchas

- `bench/widget-cases.ts` (`Case`, `trainingCases`, `widgetKeys`) and the `readReply`, `renderErrors`, `fence` helpers in `adapters/openui.ts` are not exported from `index.ts`; bench and tests import them by file path.
- Parser warnings (an orphaned statement) do not block; a dropped node or no renderable root does.
- The reply reader ignores chatter before the first statement and cuts at a closing fence. With no `root =` line, `none` anywhere means none; anything else goes to the parser and fails there.
- Repair is one retry only; then the answer degrades to `none`, never an unparseable block.
- A `form` in the request forces a non-none answer in the prompt, using only the draft's facts.
- `training.jsonl` entries labeled `other` and unreadable lines are skipped; the latest label per reply wins, and a reply carrying its own widget is benched on its prose with the fence removed.
- The bench needs real model access (the omp model runner); the test file does not.
