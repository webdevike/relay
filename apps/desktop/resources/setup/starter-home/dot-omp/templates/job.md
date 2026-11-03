---
every: 24h
enabled: false
max_run: 20m
keep: 30m
---
# <name>: <what one run produces>

Goal: <one sentence: what a run produces, and what it must never do>.

1. <Step one: a command in backticks, what it does and what it prints.>
2. <Judgment step: what to decide, which rubric file in `references/` to apply, and where the result goes.>
3. Write a short summary: <counts, then one line per result>.

## Check
First line `pass` if <an observable condition on the outputs>, else `fail: <why>`.
