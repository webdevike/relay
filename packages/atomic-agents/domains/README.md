# domains

One folder per area of work. Each domain holds its agent specs (JSON), the adapters those agents use to reach outside systems, optional bench scripts, and tests. Start with the domain README.

| Domain                | Agents                                                                                                                                                                                                                                                       | What it does                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| [design](design/)     | `design-critic`                                                                                                                                                                                                                                              | Scores a rendered UI (URL or screenshot) against Isaac's design rules and returns ranked fixes. |
| [ecard](ecard/)       | `ecard-slack-fetch`, `ecard-slack-triage`, `ecard-slack-reply-drafter`, `ecard-outlook-fetch`, `ecard-outlook-triage`, `ecard-ticket-intake`, `ecard-ticket-mover`, `ecard-ci-triage`, `ecard-review-drafter`, `ecard-meeting-prep`, `ecard-meeting-actions` | eCard work inbox, tickets, CI, reviews and meetings, from Slack, Outlook, Linear and GitHub.    |
| [gmail](gmail/)       | `gmail`                                                                                                                                                                                                                                                      | Read-only triage of Isaac's personal Gmail into needs_isaac, fyi or noise.                      |
| [render](render/)     | `prop-render`                                                                                                                                                                                                                                                | Turns a one-line object description into a Blender-built 3D model and a studio render.          |
| [research](research/) | `web-researcher`                                                                                                                                                                                                                                             | Answers one research question with verified, quoted sources.                                    |
| [widget](widget/)     | `widget`                                                                                                                                                                                                                                                     | Picks the Relay widget block that fits a draft reply and its data, or none.                     |

## Where to go

- Run, bench, or inspect an agent: `cd packages/atomic-agents`, then `bun src/cli.ts list`, `bun src/cli.ts run <agent-id> <job> --input '<json>'`, `bun src/cli.ts bench <agent-id> <job> --input '<json>'`. The exact job ids and inputs are in each domain README.
- Test: `bun test domains/<name>` from `packages/atomic-agents` (all domains: `bun test`).
- Ask an agent from any omp session: the `relay` MCP tools `agents_list`, `agents_ask {agent, request}` and `agents_result {run}` (Eva's `.omp/tools/relay-agents.ts`). They call `bun src/cli.ts catalog`, `request <agent-id> '<json>' --wait 40s` and `result <run> --wait 40s` on the installed service, which print JSON (`src/core/Requests.ts`). An agent with an `asks` pair gets its request event; any other agent gets its job run through `atomic-agents/run.requested`. Every enabled agent with a job shows up with its request schema, reply shape, model and typical seconds and cost; nothing to register.
- Add an agent: put its JSON spec in the domain folder, put its adapters in `adapters/`, and export the pack from the domain's `index.ts`.
- Register a domain: `src/packs.ts` lists every pack the CLI, the service and the benches assemble agents from.

## Rules for the folders

- `index.ts` is the only file code outside the domain may import.
- `adapters/` holds the code that talks to external systems.
- `bench/` holds model comparison scripts; `test/` holds `bun test` files and fixtures.
- Secrets are read from files or env vars named in the domain README. Values are never committed.
