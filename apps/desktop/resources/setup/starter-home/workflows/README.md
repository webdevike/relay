# Workflows: runbooks for recurring tasks

A runbook says how a kind of task gets done: the files it needs, the steps, what it produces and how to tell it worked. Assistants check here before improvising, and write a runbook after they finish a new kind of task for the first time.

## Add one
1. Copy `.omp/templates/runbook.md` to `workflows/<task>.md`.
2. Fill in Inputs, Steps, Outputs and Check.
3. When it grows past about a page, keep the file as a router and move each step's detail into `workflows/<task>/<topic>.md`.

## Runbooks
| Runbook | Use it for |
|---|---|
| `workflows/first-steps.md` | getting this home base working for you: the sample runbook |
