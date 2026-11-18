# atomic-agents

Atomic specialist agents: one narrow agent plus its jobs, tools, knowledge and typed events per component, run by one service (`ai.eva.atomic-agents`). What is built and why: [`PLAN.md`](PLAN.md). Agent folders: [`docs/agent-folders.md`](docs/agent-folders.md). Tool modes: [`docs/code-mode.md`](docs/code-mode.md).

## Install

```
bun src/cli.ts service install [--base origin/main] [--force]
```

Run from a checkout of `origin/main`. It never stops the running service before the replacement is ready (`src/core/Service.ts`, gates in `src/core/InstallGate.ts`):

1. **Stage.** The package and the chat-core sources it imports are copied to `<home>/app.next`, production dependencies installed there.
2. **Gate.** Refused, with every reason printed and the running service untouched, when the source checkout has uncommitted changes, is not an ancestor-or-equal of `--base` (fetched first), or does not contain the commit in `<home>/app/source.json` (behind or diverged); or when the staged copy's `list --json` would drop an agent the installed copy loads, or one `config.json` sets to mode `live` or `shadow`. `--force` installs anyway and prints what it forced past.
3. **Swap.** Stop, rename `<home>/app` to `<home>/app.prev` and the stage to `<home>/app`, start. A start that fails puts `app.prev` back. `app.prev` stays until the next install, for a manual rollback.

## Tracing

Every agent run is one trace, kept on disk next to the journal, so an agent debugging a run reads its span tree instead of grepping `logs/serve.log`.

```
bun src/cli.ts traces [--agent <id>] [--run <run or request id>] [--errors] [--slow] [--since 1h] [--limit 5] [--json]
```

```
2026-11-18 14:33:39  agent.run probe/flaky run 20261118T143339-682d657c test/default (fell back)  5ms ok
├─ event.emit probe/job.started  0ms
├─ agent.attempt test/default  0ms  ✗ Boom: provider down
├─ event.emit probe/job.started  0ms
├─ agent.attempt test/backup fallback from test/default  2ms
│  ├─ tool.call lookup {"id":"x"}  0ms
│  ├─ tool.call lookup {"id":"y"}  0ms  ✗ Error: no y
│  ├─ tool.call delete_all {}  0ms  ✗ Error: no tool delete_all; you may only call: lookup
│  └─ event.emit probe/probe.done  0ms
└─ event.emit probe/job.succeeded  0ms
```

Newest runs first (`--slow`: slowest first), default the last 24 h (with `--run`, everything kept). `--errors` keeps runs with any failed span, a fallback that saved the run included. `--json` prints one line, `{traces: [{traceId, root, open, spans, errors}]}`, each `root` a span tree (`name`, `start`, `ms`, `attributes`, `error {tag, message}`, `logs`, `children`); assistants get the same through the `relay` MCP server's `agents_traces`.

**Design: Effect's own OTLP tracer, a file instead of a collector.** The spans are Effect spans (`Effect.withSpan`, `Effect.fn`), exported by `effect/observability`'s `OtlpTracer`, which batches them, serializes OTLP/JSON and flushes when the process ends. Its HTTP transport is swapped for a file (`src/core/observability/Tracing.ts`): each batch it would POST to a collector is appended as one line to `<home>/traces/<UTC hour>.jsonl`. OpenCode does the same tracing with `OTEL_EXPORTER_OTLP_ENDPOINT` pointed at [motel](https://github.com/kitlangton/motel), a local OTLP server with SQLite and a TUI that agents query over HTTP. Here a file wins:

- Nothing else runs: no daemon, container or port (the Colima VM is short on memory; Jaeger or Grafana would be a second service to keep alive). Short CLI runs (`run`, `bench`) and the service write the same files, and nothing is lost while no server is up.
- The lines are standard OTLP/JSON, the OpenTelemetry file exporter's format, so a collector's `otlpjsonfile` receiver can load them into any backend later, and pointing the exporter at motel or a collector is a change of transport, not of instrumentation.
- Reader and retention are one small file (`Traces.ts`), and the files are the whole store.

**Spans.** The core opens them once for every domain (`src/core/observability/Spans.ts`), so an agent needs no instrumentation of its own:

| span                                    | where                                               | attributes                                                                                                                                    |
| --------------------------------------- | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent.run`                             | `Runner.run`                                        | `agent.job`, `agent.request`, `model.id`, `agent.tool_mode`, `agent.trial`, `agent.queued_ms`, `run.model`, `run.fell_back`                   |
| `agent.attempt`                         | each try on a model                                 | `model.id`; on the retry `fallback.from`, `fallback.reason`                                                                                   |
| `agent.item`                            | each item of an agent spec                          |                                                                                                                                               |
| `source.fetch`, `step.run`, `check.run` | adapter packs (`Adapter.ts` `pack`)                 | `source.name` and `source.items`, `step.name`, `check.name`, `check.attempt`, `check.pass`                                                    |
| `model.call`                            | model adapters (every harness)                      | `model.harness`, `model.id`, `model.thinking`, `model.provider`, `tokens.input`, `tokens.output`, `tokens.cached`, `cost.usd`, `prompt.chars` |
| `tool.call`                             | `Model.ts` `tool`, the tool loop, code-mode scripts | `tool.name`, `tool.caller` (`model` or `script`), `tool.args` (200 characters), `tool.result_chars`                                           |
| `event.emit`                            | `EventBus.publish`                                  | `event.type`                                                                                                                                  |

Every span of a run also carries `agent.id`, `agent.run` and `agent.tier`, so a run still in progress (its root not written yet) is found by agent and run too. A failed span has OTLP status error with the failure's message, plus `error.tag` (its `_tag`, `Error` for an untagged failure) and `error.message`. A run reports failure as data (`job.failed`), yet its `agent.run` span still ends failed with the original typed error. Logs written inside a span are its events (Effect records every log there) and print under its line. Spans outside a run (config reloads, CLI publishes, benches, orchestrator ticks) are not sampled.

**Retention.** One file per UTC hour. Whenever a batch is written (at most every 10 minutes) the writer deletes hours that ended more than 7 days ago, then the oldest hours until all files fit in 64 MB; one hour's file stops taking batches at 16 MB, so a runaway loop cannot spend the budget in an hour (`RETENTION` in `Traces.ts`).
