# ecard

Read-only (shadow mode) triage, routing and drafting agents for Isaac Weber's eCard Systems work across Slack, Outlook, Linear and GitHub; nothing here posts, moves or writes to those systems.

## Agents

Each agent has one job, triggered by its input event or `manual`. Model fields: default model, with candidates `anthropic/claude-haiku-5-5` and `anthropic/claude-sonnet-5-5` unless noted. All have `thinking: off`.

| Agent id (job)                                        | What it does                                                                                                                                                                | Input -> output event                                  | Default model | Triggers                     |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ------------- | ---------------------------- |
| `ecard-slack-fetch` (`fetch`, code agent, no model)   | Reads new items Elysia flagged, fetches each thread read-only                                                                                                               | cron -> `item.fetched`, `fetch.completed`              | none          | cron `20 * * * *`, manual    |
| `ecard-slack-triage` (`triage`)                       | Says whether a Slack item still needs Isaac, checks if he replied                                                                                                           | `ecard-slack-fetch/item.fetched` -> `item.triaged`     | haiku-5-5     | that event, manual           |
| `ecard-slack-reply-drafter` (`draft`)                 | Drafts Isaac's Slack reply in his voice; emits nothing unless verdict is `needs-isaac` (source `ecard.needs_isaac`)                                                         | `ecard-slack-triage/item.triaged` -> `reply.drafted`   | sonnet-5-5    | that event, manual           |
| `ecard-outlook-fetch` (`fetch`, code agent, no model) | Reads new inbox emails with thread via the proxy                                                                                                                            | cron -> `email.fetched`, `fetch.completed`             | none          | cron `10,40 * * * *`, manual |
| `ecard-outlook-triage` (`triage`)                     | Classifies an email: `needs-isaac`, `fyi` or `skip`                                                                                                                         | `ecard-outlook-fetch/email.fetched` -> `email.triaged` | haiku-5-5     | that event, manual           |
| `ecard-ticket-intake` (`route`)                       | Routes a newly assigned ENG ticket to `auto-work` or `needs-isaac` with size S/M/L; tool `ecard.linear_issue`                                                               | `ticket.assigned` -> `intake.routed`                   | haiku-5-5     | `ticket.assigned`, manual    |
| `ecard-ticket-mover` (`propose`)                      | After code lands on develop, proposes `In QA` (assignee Steve Arms, retest comment) or `none`; tools `linear_issue`, `git_log`, `github_prs`                                | `change.merged` -> `move.proposed`                     | sonnet-5-5    | `change.merged`, manual      |
| `ecard-review-drafter` (`draft`)                      | Drafts Isaac's answer to a PR review comment: `fix-plan` or `reply`; tool `read_file`                                                                                       | `comment.received` -> `draft.ready`                    | haiku-5-5     | `comment.received`, manual   |
| `ecard-ci-triage` (`triage`)                          | Classifies a failed GitHub check as `flaky`, `bug` or `env` with evidence and next step; tools `workflow_runs`, `failed_log`                                                | `check.failed` -> `ci.triaged`                         | haiku-5-5     | `check.failed`, manual       |
| `ecard-meeting-actions` (`extract`)                   | Lists Isaac's action items from a meeting protocol, each matched to an ENG ticket or flagged as a new sub-issue; tools `isaac_open_issues`, `linear_search`, `linear_issue` | `protocol.ready` -> `actions.extracted`                | sonnet-5-5    | `protocol.ready`, manual     |
| `ecard-meeting-prep` (`prep`)                         | Briefs Isaac before a meeting: up to 6 tickets, 4 PRs, 4 questions; tools `meeting_notes`, `linear_search`, `isaac_recent`, `linear_issue`, `github_prs`                    | `meeting.upcoming` -> `brief.ready`                    | haiku-5-5     | `meeting.upcoming`, manual   |

The fetch agents are declared by `ecard-slack-fetch.json` and `ecard-outlook-fetch.json` (`kind: "code"`) pointing at the `.ts` modules. Knowledge files read by agents (under `${EVA_ROOT:-~/Eva}/references/`): `slack-voice.md` (slack-reply-drafter) and `ecard-platform-repos/review-rules.md`, `review-rules-contracts.md`, `review-rules-data.md`, `review-rules-ui.md`, `review-rules-ui-state.md` (review-drafter).

## Tools and adapters

- `adapters/pack.ts`: `ecardPack`, the step adapters that lay each event out as the prompt and the tools above (`ecard.linear_issue`, `linear_search`, `isaac_open_issues`, `isaac_recent`, `meeting_notes`, `github_prs`, `read_file`, `git_log`, `workflow_runs`, `failed_log`), plus source `ecard.needs_isaac`. Tools take `repo`, `ref`, `runId`, `asOf` from the item, not from the model.
- `adapters/services.ts`: `Linear` (GraphQL at `https://api.linear.app/graphql`, queries only, 30 s timeout; key from env `LINEAR_API_KEY` or the `LINEAR_API_KEY=` line of `<EVA_ROOT>/secrets/linear.env`), `GitHub` (`gh api --method GET`, 60 s timeout), `Meetings` (reads `<EVA_ROOT>/work/meetings/*.json`).
- `adapters/slack.ts`: `Slack` (threads by permalink via `claude -p` with the claude.ai Slack connector, built-in tools disallowed, 15 minute timeout) and `Flags` (reads `<EVA_ROOT>/work/elysia/slack.md`, the `## Needs your attention` bullets with a permalink, via `flaggedItems`).
- `adapters/outlook.ts`: `Outlook` (inbox since a timestamp via `claude -p` with the claude.ai Microsoft 365 connector, 15 minute timeout, at most 15 emails per run, body 3000 chars).
- `ecard-slack-fetch.ts`: keeps `seen.json` (last 500 URLs) in the agent state dir, at most 12 items per run.
- `ecard-outlook-fetch.ts`: keeps `cursor.json` (received time plus ids) in the state dir; first run starts 24 h back.
- Proxy binary: env `CLAUDE_BIN`, else `~/.local/bin/claude`.

## Run, bench, test

From `packages/atomic-agents`:

```
bun src/cli.ts list
bun src/cli.ts run ecard-ticket-intake route --input '{"key":"ENG-1234","title":"...","creator":"Steve Arms"}'
bun src/cli.ts run ecard-outlook-fetch fetch --input '{}'
bun src/cli.ts bench ecard-ci-triage triage --input '<json>' --models anthropic/claude-haiku-5-5,anthropic/claude-sonnet-5-5
bun domains/ecard/bench/ecard.ts <agent> [--models a,b] [--tool-modes tools,code] [--concurrency 4]
bun test domains/ecard
bun run typecheck
```

`bench/ecard.ts` scores against `<home>/bench/<agent>/cases.json` (`[{id, input, expect}]`) and writes `<home>/bench/<agent>/results-<stamp>.json`. Scorers in `bench/ecard-score.ts` exist for: `ecard-slack-triage`, `ecard-review-drafter`, `ecard-ticket-mover`, `ecard-meeting-actions`, `ecard-slack-reply-drafter`, `ecard-outlook-triage`, `ecard-meeting-prep`, `ecard-ticket-intake`, `ecard-ci-triage`. Tests (`test/ecard.test.ts`) use fake services and a temp Eva root, with no env gating. Run `bun install` in `packages/atomic-agents` first (the package has its own install).

## Exports via index.ts

- `ecardPack`: the ecard adapter pack (steps, tools, `ecard.needs_isaac` source), registered in `src/packs.ts`. It is the only export.

## Gotchas

- Everything is read-only; the proxy prompts forbid posting, replying or changing mail, and the Linear and GitHub services have no write calls.
- Local paths required: `<EVA_ROOT>/work/elysia/slack.md`, `<EVA_ROOT>/work/meetings/`, `<EVA_ROOT>/secrets/linear.env` (or `LINEAR_API_KEY`), the `references/` knowledge files, a `gh` CLI login, and a `claude` binary with the Slack and Microsoft 365 connectors.
- Slack fetch marks items seen once tried, so an item the proxy could not read is not retried.
- `ecard-slack-reply-drafter` produces no item for a `skip` verdict.
- `ecard.isaac_recent` and `ecard.meeting_notes` fail with "this item has no asOf" when the item lacks `asOf`; `read_file`, `git_log` and `workflow_runs` need `repo` (and `ref` or `runId`) on the item.
- `ecard.read_file` returns at most 200 lines; `failed_log` returns the last 6000 chars.
- Replays read Linear and GitHub as of the item's moment (state and comments replayed from issue history).
- `meeting_notes` looks back 14 days for the same series, else 7 days, at most 6 meetings.
