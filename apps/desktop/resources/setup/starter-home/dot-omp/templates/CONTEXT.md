# Templates: blank shapes to copy when starting a new file

One job: hold the empty shape of each kind of record, so a new one starts by copying a file instead of recalling prose.

| Template | Copy to | How |
|:--|:--|:--|
| `workspace.md` | `workspaces/<name>.md` (card), topic files in `workspaces/<name>/` | by hand; keep the card about a page |
| `runbook.md` | `workflows/<task>.md` | by hand |
| `job.md` | `work/jobs/<name>.md` | by hand; a job is a runbook an assistant runs on a schedule |
| `ledger.md` | `work/items/<key>.md` | by hand, below its marker line |

- `<like-this>` placeholders are replaced by hand.
- Load only the template being used. Don't load this folder at the start of a session.
- `bun .omp/tools/icm-lint.ts` checks the result: H1 first, size budgets, every backticked path resolves. Record a deliberate exception where it lives, as `<!-- icm: budget N, reason -->` or `<!-- icm: no-h1, reason -->`.
