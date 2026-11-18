# ops

Packaged jobs for Isaac's own operations: no model, a fixed read and a computation, kept as agents for their instructions and the runtime's observability (traces, health, missed-tick checks).

## Agents

| Agent id (job)                                | What it does                                                                                                                                                                                                                                                                                                                                                      | Output event     | Triggers                                   |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | ------------------------------------------ |
| `eta-report` (`report`; code agent, no model) | Reads Nova's estimate-vs-actual runs (`agent-session.ts estimates --owner nova --since 7d --json`, plus a 30-day `--baseline`), computes the median actual/estimate ratio, the share within ±50% and the worst job kind, compares with last week's saved numbers, tells Nova's thread and rewrites the `Last week` section of `work/eva/agents/nova/estimates.md` | `ops.eta-report` | cron `0 9 * * 3` (Wednesday 09:00), manual |

The agent is declared by `agents/eta-report.json` (`kind: "code"`) pointing at `agents/eta-report/agent.ts`; `compute.ts` is the pure part (the numbers, the message, the markdown section) and `INSTRUCTIONS.md` is the job written out. A code agent cannot be an `AGENT.md` folder, so there is none.

## Schedule

The cron is host local time, which is America/New_York on Isaac's Mac. Change it in `config.json`: `{"components": {"eta-report": {"cron": {"report": "0 9 * * 3"}}}}`.

## Tools

`EtaSources` (in `agent.ts`) runs, with the same `bun` as the service and `EVA_ROOT` (default `~/Eva`), `.omp/tools/agent-session.ts estimates ...` and `.omp/tools/eva-thread.ts --agent nova "[eta-report] ..."`, each with a 120 s timeout. A non-zero exit fails the run.

## State

`<home>/state/eta-report/last-week.json`: `{at, week}` of the last report that went out, the next report's comparison. Written only after the thread message was sent.

## Run and test

```
bun src/cli.ts run eta-report          # the manual trigger: runs `report` now (tells Nova's thread for real)
bun src/cli.ts traces --agent eta-report
bun test domains/ops
```
