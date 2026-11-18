---
id: eta-report
kind: code
purpose: Every Wednesday morning, report how Nova's delegated-work estimates compared with actual run times.
job: report
cron: "0 9 * * 3" # Wednesday 09:00 host local time (America/New_York); config.json components.eta-report.cron.report overrides
model: none # a packaged job: its value is these instructions and the runtime's traces, health and missed-tick checks
event: ops.eta-report
---

This is a code agent, so it has no `AGENT.md`: the loader only builds `AGENT.md` folders into model agents, and a `kind: "code"` agent is declared by `../eta-report.json` pointing at `agent.ts`. This file is the job's instructions, kept next to the code that follows them.

## The job

Nova quotes an ETA on every delegated helper run (`--estimate <dur>` on `agent-session.ts start`). Each Wednesday at 09:00 the runtime runs `report`:

1. Read the week: `bun $EVA_ROOT/.omp/tools/agent-session.ts estimates --owner nova --since 7d --json`. Read the context: the same with `--since 30d --baseline --json` (the owner's finished-run count and median wall time).
2. Compute from the runs (`compute.ts`, pure): the median actual/estimate ratio, the share of runs within ±50% of their estimate, and the job kind whose median ratio is furthest from 1. A ratio below 1 means the run beat its quote (the quote was too long).
3. Compare with last week's numbers, kept in the agent's state dir (`<home>/state/eta-report/last-week.json`). No saved week, or a week with no estimates, means no comparison.
4. Rewrite the `## Last week` section of `$EVA_ROOT/work/eva/agents/nova/estimates.md` (added before the first other section when missing).
5. Tell Nova's thread, in 2-3 plain-text lines: `bun $EVA_ROOT/.omp/tools/eva-thread.ts --agent nova "[eta-report] ..."`. Nova forwards what matters to Isaac.
6. Save this week's numbers for next week, then emit `ops.eta-report` with the fields below.

A week with no finished run that has an estimate still reports: it says so, and the event has `n: 0`.

## The event `ops.eta-report`

`owner`, `since`, `at`, `n`, `medianRatio?`, `within50?` (0-1), `worstKind?` `{kind, n, medianRatio}`, `change?` `{medianRatio, within50Points}` (this week minus last), `baseline?` `{n, medianMinutes}`, `summary` (the thread message without its prefix).

## When it fails

Any unreadable tool output, missing `estimates.md`, or a non-zero exit fails the run, which the trace and `health` show. State is saved only after the thread message went out, so a failed run does not become next week's comparison. Run it by hand: `bun src/cli.ts run eta-report`.
