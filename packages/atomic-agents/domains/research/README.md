# research

Answers one research question with cited, quote-verified sources from the web, agent-reach and Muse (Meta AI in its macOS desktop app).

## Agents

One spec, `web-researcher.json` (component `web-researcher`, job `answer`).

| Field         | Value                                                                                                                                                                                                      |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Purpose       | Answer one research question with cited sources, read-only.                                                                                                                                                |
| Input event   | `research.asked`: `question`, optional `requestId`, `platforms` (web, github, youtube, reddit, x, xiaohongshu, instagram, facebook, marketplace), `depth` (quick, standard, deep)                          |
| Output event  | `research.answered`: `answer`, `citations[{url, quote, verified, checked (page, excerpt, muse, none), via}]`, `route`, `toolCalls`, `model`, `attempts`, `cost`, `seconds`, plus the echoed request fields |
| Default model | `anthropic/claude-haiku-5-5`, thinking `low`; candidates: claude-opus-5-5, claude-sonnet-5-5, claude-haiku-5-5, `openai-codex/gpt-6.1-sol`, `openai-codex/gpt-6-astra`, `openai-codex/gpt-6-luna`          |
| Triggers      | `onEvent: research.asked`, `manual`. No cron.                                                                                                                                                              |
| Limits        | `timeout` 480, `maxSteps` 10, check `research.citations`                                                                                                                                                   |
| Tools         | `web.search`, `web.read`, `muse.social_search`, `reach.fallback_search`, `reach.fallback_read`, `reach.platform_search`                                                                                    |

The spec also has `asks` (request `research.asked`, reply `research.answered`, show `answer`). The source order is in the system prompt: web first; Muse first when the request names instagram, facebook or marketplace; agent-reach only as fallback or for named platforms.

## Tools and adapters

`adapters/pack.ts` builds `researchPack`: the six tools above plus the `research.citations` check. Gates are enforced in code with a per-item ledger, not left to the prompt. The check normalizes markdown, HTML, quotes, dashes and case, verifies each quote on its page (else on search excerpts, else on Muse's words for a Muse link), gives one repair turn, then ships the answer with `verified: false`. `route` is a `+` join of primary, muse, platform, fallback.

- `adapters/http.ts`: `ResearchError`, `Hit`, `Page`, `fetchText` (45 s timeout), `mcpCall` (stateless JSON-RPC to a keyless MCP endpoint).
- `adapters/web.ts`: `Web` service. Search through `https://search.parallel.ai/mcp`. Read through the `omp read <url>:1-100000` CLI (90 s timeout). A page under 80 chars or navigation only (`navOnly`) counts as failed.
- `adapters/reach.ts`: `Reach` service. Search and fetch through Exa's MCP (`https://mcp.exa.ai/mcp`), read through Jina (`https://r.jina.ai/`) then Exa fetch, GitHub through `gh search` (repos, issues, code; 45 s timeout), other platforms through Exa filtered to that platform's hosts.
- `adapters/muse.ts`: `Muse` service, one question at a time (semaphore), 20 s gap between questions. `musePrompt` adds read-only guard rails. Failures become `ResearchError` naming the kind.
- `adapters/muse/ask.machine.ts`: pure XState machine for one question; failure kinds unavailable, signed_out, busy, ui_changed, rate_limited, timeout.
- `adapters/muse/driver.ts`: binds the machine to cua-driver and drives the Muse app (bundle `com.meta.endo`): unhides and parks the window, presses "New side chat", types the question, presses Return once, then only reads. Uses a JXA call for unhide/activate.
- `adapters/muse/cua.ts`: stdio MCP client for `cua-driver mcp`; uses `--direct` if the process has Accessibility and Screen Recording, else the CuaDriver.app daemon. 60 s per call.
- `adapters/muse/screen.ts`: pure parser of Muse's accessibility snapshot into text, links, preview-card count and Marketplace listing titles; `rateLimited` detector.

No secrets are read: the endpoints are keyless. `gh` uses its own login.

## Run, bench, test

From `packages/atomic-agents`:

```
bun src/cli.ts run web-researcher answer --input '{"question":"When did Go 1.2 ship?","depth":"quick"}'
bun src/cli.ts run web-researcher answer --input '{"question":"...","platforms":["github"]}' --tool-mode code
bun src/cli.ts bench web-researcher answer --input '{"question":"..."}' --models anthropic/claude-haiku-5-5,anthropic/claude-sonnet-5-5
bun domains/research/bench/web-researcher.ts <dir with cases.json> [--models a,b] [--tool-modes tools,code] [--judge model] [--out dir]
bun test domains/research
bun run typecheck
```

The bench script reads `cases.json` (`{id, question, platforms?, depth?, answer, accept, evidence, source}`), runs each model by tool mode through the shipped agent with no bus, grades with a judge (default `anthropic/claude-opus-5-5`), and writes `<out>/<model>/<tool mode>/<case>.json`, `results.md` and `results.json` (default out `<dir>/runs/<timestamp>`). Models default to the spec's candidates.

Tests: `test/web-researcher.test.ts` (gates, quote check, `find`, code mode, Muse routes, with fake layers and fixtures in `test/fixtures/research`), `test/muse.test.ts` (recorded Muse snapshots in `test/fixtures/muse`, fake cua, machine with a simulated clock), `test/machine-docs.test.ts` (checks `docs/state-machines/` pages match `askMachine`).

## Exports via index.ts

- `researchPack`: the adapter pack, `researchPack(web?, reach?, muse?)`; each layer defaults to the live service and can be replaced with a fake.

## Gotchas

- `muse.social_search` is accepted only for instagram, facebook and marketplace, only when the request names it, once per platform per item, and takes about a minute.
- Muse needs macOS, the Muse app signed in, cua-driver installed and Accessibility plus Screen Recording grants (directly or through the CuaDriver.app daemon). It reports `busy` if Muse is the frontmost app, and nothing is touched then. It parses Muse 9.0 UI labels, so a UI change gives `ui_changed`.
- Muse cards and Marketplace listings expose no URL or price, so they cannot be cited.
- `reach.fallback_search` stays closed until the primary search failed, returned under 3 results or ran twice, and until Muse was asked for any named Muse platform. `reach.fallback_read` opens only for a URL `web.read` failed on. `reach.platform_search` only searches platforms in the request, and refuses a Muse platform after Muse answered with links.
- Read-only: nothing posts or signs in anywhere. On this Mac reddit.com and x.com fail TLS and Reddit and Xiaohongshu have no logged-in backend, so those go through Exa results only (per comments in `reach.ts`).
- A tool result shown to the model is cut to 4500 characters; use `find` on `web.read` to pull passages from long pages.
- `UPDATE_MACHINE_DOCS=1 bun test` rewrites the state-machine docs instead of failing.
