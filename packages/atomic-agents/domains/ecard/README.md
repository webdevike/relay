# ecard

Read-only (shadow mode) triage, routing and drafting agents for Isaac Weber's eCard Systems work across Slack, Outlook, Linear and GitHub; nothing here posts, moves or writes to those systems.

## Agents

Each agent has one job, triggered by its input event or `manual`. Model fields: default model, with candidates `anthropic/claude-haiku-5-5` and `anthropic/claude-sonnet-5-5` unless noted. All have `thinking: off`.

| Agent id (job)                                        | What it does                                                                                                                                                                | Input -> output event                                  | Default model | Triggers                     |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ------------- | ---------------------------- |
| `ecard-slack-fetch` (`activity`, `fetch`; code agent, no model) | `activity`: what is new in Isaac's Slack since `since` (DMs, group DMs, his channels, @-mentions, with reactions) plus the threads of `urls`, for Eva's `jobs/ecard-slack-triage`. `fetch`: each new item Elysia flagged, with its thread. Claude proxy first, Slack desktop on failure | `activity`: `{since?, urls?, source?}` -> `activity.fetched`; `fetch`: cron -> `item.fetched`, `fetch.completed` | none | `activity` manual (what `request` runs); `fetch` cron `20 * * * *`, manual |
| `ecard-main-watch` (`replay`, `watch`; code agent, no model) | `watch`: when develop is promoted to `main` (what staging deploys) in the eCard repos Isaac works in, which of his ENG tickets reached it and which are still only on develop, found by ancestry (merge commits' second parents included); waits up to an hour for the staging deploy. `replay`: the same for one given `toSha`. Eva's heartbeat relays `main.promoted` to Astra as a `[main]` line | `replay`: `{repo, toSha, fromSha?}` -> `promotion.replayed`; `watch`: cron -> `main.promoted`, `repos.derived` | none | `replay` manual (what `request` runs); `watch` cron `*/5 * * * *`, manual |
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

The fetch and watch agents are declared by `ecard-slack-fetch.json`, `ecard-outlook-fetch.json` and `ecard-main-watch.json` (`kind: "code"`) pointing at the `.ts` modules. Knowledge files read by agents (under `${EVA_ROOT:-~/Eva}/references/`): `slack-voice.md` (slack-reply-drafter) and `ecard-platform-repos/review-rules.md`, `review-rules-contracts.md`, `review-rules-data.md`, `review-rules-ui.md`, `review-rules-ui-state.md` (review-drafter).

## Tools and adapters

- `adapters/pack.ts`: `ecardPack`, the step adapters that lay each event out as the prompt and the tools above (`ecard.linear_issue`, `linear_search`, `isaac_open_issues`, `isaac_recent`, `meeting_notes`, `github_prs`, `read_file`, `git_log`, `workflow_runs`, `failed_log`), plus source `ecard.needs_isaac`. Tools take `repo`, `ref`, `runId`, `asOf` from the item, not from the model.
- `adapters/services.ts`: `Linear` (GraphQL at `https://api.linear.app/graphql`, queries only, 30 s timeout; key from env `LINEAR_API_KEY` or the `LINEAR_API_KEY=` line of `<EVA_ROOT>/secrets/linear.env`), `GitHub` (`gh api --method GET`, 60 s timeout), `Meetings` (reads `<EVA_ROOT>/work/meetings/*.json`).
- `adapters/slack.ts`: `Slack.read({since?, urls}, source?)` over two readers with one output (`authedUser`, `items`, `threads`) plus `source`: `claude-proxy` (`claude -p` with the claude.ai Slack connector, built-in tools disallowed, 8 minute timeout; an `{error}` answer or no authed user counts as a failure) and `slack-desktop` (the Slack desktop app on CDP `SLACK_CDP_URL`, default `http://127.0.0.1:9333`: one `Runtime.evaluate` in the `app.slack.com/client` page calling an allowlist of read-only Web API methods with the client's session; never opens a conversation, types or sends; 4 minute timeout). `auto` (default) tries the proxy, then the desktop app, and records `fallbackReason`; `source` on the job input or env `ECARD_SLACK_SOURCE` forces one reader with no fallback. `Flags` reads `<EVA_ROOT>/work/elysia/slack.md`, the `## Needs your attention` bullets with a permalink, via `flaggedItems`.
- `adapters/outlook.ts`: `Outlook` (inbox since a timestamp via `claude -p` with the claude.ai Microsoft 365 connector, 15 minute timeout, at most 15 emails per run, body 3000 chars).
- `adapters/promotions.ts`: `Promotions` (GitHub REST over `fetch` with `GH_TOKEN`/`GITHUB_TOKEN` or `gh auth token`, GET only, 30 s timeout: branch heads read with `If-None-Match` so an unchanged head is a 304 that costs no rate limit, `base...head` compares, the newest 100 commits of a ref, PRs, staging deployments and their latest status, branch existence, and the repos with Isaac's PRs or commits since a date via the search API) and `Ledgers` (Eva's `work/items/ENG-<n>.md` ledgers: their keys, and the `repo:` each names).
- `ecard-main-watch.ts`: `watch` keeps `main.json` in the state dir (login, the derived repos and when, per repo the last reported main head, its ETag and a head waiting for its staging deploy). Repos: Isaac's PRs and default-branch commits in the org over the last 60 days plus the ledgers' repos, kept when they have a `develop` branch, re-derived daily (`repos.derived`). First sight of a repo records its head silently. A moved head is reported once its staging deploy succeeded, failed, or an hour passed (`staging` `deployed`, `failed`, `not-deployed`; `none` for repos with no staging environment), as one `main.promoted {repo, fromSha, toSha, compare, staging, tickets, pendingOnDevelop, otherTickets}` when it carries Isaac's tickets or some are still only on develop. Tickets: ENG keys in the non-bot commits newly reachable from the new head (and merged PRs' titles and branches); Isaac's when he authored a commit or PR carrying the key or a ledger exists. Pending: his keys in commits on develop not reachable from the new head, unless a main commit with the key landed at or after them (Noah re-commits develop work onto main). The heartbeat bridge reads it only while the component's `mode` is `live`.
- `ecard-slack-fetch.ts`: `activity` reads at most 150 items (DMs and mentions kept first) and 20 permalinks, default `since` 24 h back, `cursor` = the newest item's ts; `fetch` keeps `seen.json` (last 500 URLs) in the agent state dir, at most 12 items per run.
- `ecard-outlook-fetch.ts`: keeps `cursor.json` (received time plus ids) in the state dir; first run starts 24 h back.
- Proxy binary: env `CLAUDE_BIN`, else `~/.local/bin/claude`.

## Run, bench, test

From `packages/atomic-agents`:

```
bun src/cli.ts list
bun src/cli.ts run ecard-ticket-intake route --input '{"key":"ENG-1234","title":"...","creator":"Steve Arms"}'
bun src/cli.ts run ecard-outlook-fetch fetch --input '{}'
bun src/cli.ts run ecard-main-watch replay --input '{"repo":"react-client-reports-app","toSha":"588aa37d"}'
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
- Local paths required: `<EVA_ROOT>/work/elysia/slack.md`, `<EVA_ROOT>/work/meetings/`, `<EVA_ROOT>/secrets/linear.env` (or `LINEAR_API_KEY`), the `references/` knowledge files, a `gh` CLI login, and a `claude` binary with the Slack and Microsoft 365 connectors. The Slack fallback needs Slack desktop running with `--remote-debugging-port=9333` (Eva's `references/tools/accounts-and-messaging.md`, "Slack desktop").
- Slack fetch marks items seen once tried, so an item neither source could read is not retried.
- `ecard-slack-reply-drafter` produces no item for a `skip` verdict.
- `ecard.isaac_recent` and `ecard.meeting_notes` fail with "this item has no asOf" when the item lacks `asOf`; `read_file`, `git_log` and `workflow_runs` need `repo` (and `ref` or `runId`) on the item.
- `ecard.read_file` returns at most 200 lines; `failed_log` returns the last 6000 chars.
- Replays read Linear and GitHub as of the item's moment (state and comments replayed from issue history).
- `meeting_notes` looks back 14 days for the same series, else 7 days, at most 6 meetings.
