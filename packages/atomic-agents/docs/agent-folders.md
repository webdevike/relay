# Agent folders (`AGENT.md`)

An agent can be a folder instead of a single `<id>.json` or `<id>.yaml` file. The folder keeps everything the agent is: its instructions, its knowledge and its bake-off. `domains/diagram/agents/diagram/` is the first one and the template for new ones.

```
domains/<domain>/
├── schema.ts                 request and reply (and answer) as Effect Schema Structs
├── adapters/pack.ts          the pack: steps, checks, tools, and `schemas` registered by name
├── index.ts
└── agents/<id>/
    ├── AGENT.md              YAML frontmatter + the instructions in Markdown
    ├── knowledge/*.md        loaded up front, appended to the instructions
    └── bench/                cases and the bake-off script
```

## Where folders load from

The loader (`src/core/Agent.ts`) reads, in every agent dir, the `<id>.json|yaml|yml` files and every `<id>/AGENT.md` one level down. The agent dirs are each domain's `domains/<domain>/` and, when it exists, `domains/<domain>/agents/`, then `<home>/agents/` (Isaac's own; an id there replaces a built-in). Hot reload is the same as for files: an edit to `AGENT.md` swaps the agent in within a second, a bad edit is `config.rejected` and the last good version keeps running. Knowledge files are read on every run, so an edit there applies to the next run without a reload. Existing JSON and YAML agents are unchanged; nothing is migrated.

## Editing from Relay

Relay's Agents page lists `atomic-agents list --json` (every agent in load order, disabled ones and files that failed to load too, with their settings, trial mode (`trial: {on, arms}`) and run stats) and opens an agent's folder, or a JSON or YAML spec and its knowledge files. A save writes the installed copy the service runs (`<home>/app/atomic-agents`), which hot-reloads as above, and the page commits the edit back to the repo named in `<home>/app/source.json` (written by `service install`: `gitDir`, `package`, `commit`, `installedAt`). Its run list is `runs --every --agent <id>`, and `result <run>` opens any of them, request or job run. A trial arm no request started is not a job run there: the page folds trial arms from the journal itself and keeps them blind until Isaac picks.

## `AGENT.md`

```markdown
---
id: diagram # kebab-case, must equal the folder name
purpose: Turn a description of a flow, loop, architecture or structure into one polished diagram image.
model: anthropic/claude-sonnet-5-5
candidates: [anthropic/claude-sonnet-5-5, openai-codex/gpt-6-sol]
thinking: medium # optional: off, minimal, low, medium, high
trial: true # optional: a taste agent Isaac picks the model of blind (A / B / C cards in Relay); needs 3 models among model + candidates
request: diagram.requested # a schema a pack registers; also the request event's name
reply: diagram.rendered # a schema a pack registers; also the reply event's name
show: image # the reply field `atomic-agents ask` prints
job: draw # the job id
description: Draw the description as one SVG ...
steps: [diagram.brief] # optional step adapters, run before the model
prompt: "{{brief}}" # per-call data through {{field}} placeholders (request, source and step fields)
timeout: 420 # optional, seconds per model call
check: diagram.render # optional check adapter (one repair turn)
knowledge: [rules.md, style.md] # optional: file names in knowledge/, in load order; default every file, by name
---

The instructions, in Markdown: the agent's system prompt. `{{check}}` places the check adapter's contract.
```

Also accepted, as in a JSON spec: `harness` (`omp` default, `codex` or `claude-code`: the CLI the model runs in, same prompt and check), `triggers` (default: the request event, and manual runs), `source`, `attach`, `tools`, `mode` (`tools` or `code`, only with `tools`), `codeExample` (required with `tools`), `answer` (a registered schema: the JSON a tool loop answers), `answerExample`, `maxSteps`, `tiers` (below). Unknown keys are a load error.

## Tiers: a request field picks the model, effort and budget

Any agent (folder or JSON spec, as `agent.tiers`) can let one field of its request choose how it runs, so a quick question does not pay for Opus and a hard one does not get Haiku:

```yaml
model: anthropic/claude-sonnet-5-5 # defaults, for a request no tier covers
thinking: medium
tiers:
  by: depth # a field of the request (a string)
  default: standard # the tier of an absent or empty field
  levels:
    quick: { model: anthropic/claude-haiku-5-5, thinking: low, maxSteps: 6, timeout: 120 }
    standard: { model: anthropic/claude-sonnet-5-5, thinking: medium, maxSteps: 10, timeout: 180 }
    deep:
      {
        model: anthropic/claude-opus-5-5,
        thinking: high,
        maxSteps: 40,
        timeout: 300,
        candidates: [..],
      }
```

A level has `model`, and optionally `thinking`, `maxSteps` (model calls in the tool loop, replaces `maxSteps`), `timeout` (seconds per model call, tool time excluded, replaces `timeout`) and `candidates` (the models a trial compares inside this tier, else the agent's). `by` must be a request, source or step field; `default` must be a level. A value with no level runs on `model`.

The runner resolves the tier per run from the job input (`Settings.effective(...).tier`). Precedence for the model: a bake-off or trial arm's own model (`--model`), then `config.json` `components.<id>.model` (one explicit choice for every tier), then the tier's, then the agent's; thinking the same without the arm. The budget is always the tier's. Trial mode arms are the tier's model plus its `candidates`, so a trial compares models only within one tier; a fallback model still applies after a failure.

It compiles to the same agent spec a JSON file does (`src/core/AgentDoc.ts` `toAgentSpec`, then `AgentSpec.ts`): one job, the request in, the reply out, and the `asks` pair, so `agents_list` shows it and `agents_ask` answers it with nothing to register.

## Schemas stay typed in code

Request, reply and answer are Effect Schema Structs in the domain's `schema.ts`, registered by the domain's pack under a name:

```ts
export const schemas = { "diagram.requested": DiagramRequested, "diagram.rendered": DiagramRendered }
// adapters/pack.ts
pack({ name: "diagram", layer, schemas, steps: [...], checks: [...] })
```

`AGENT.md` refers to them by that name; an unknown name is a load error listing the registered ones. Optional fields are `Schema.optionalKey`, and `annotate({ description })` on a field shows up in the request JSON Schema `agents_list` hands to assistants. A reply schema declares `requestId` (optional) like every ask pair, plus the run stats it wants (`model`, `attempts`, `cost`, `seconds`). JSON specs may use the same names in `events` and `job.answer` instead of field shapes.

## Knowledge, and what an agent may read

Knowledge is loaded whole, up front: every file in `knowledge/` (or the ones `knowledge` lists, in that order) is appended to the instructions on every call. Prefer that while it fits (the diagram agent's four files are about 37 KB); add a router only when it does not. Entries are plain file names inside `knowledge/`; a path that would leave the folder is a load error, so nothing outside the agent's folder reaches its prompt. An agent that needs a read tool gets one fenced to its own folder.

## Authoring checklist

- One-sentence purpose; one request in, one reply out; the smallest tool set (none is fine).
- Distill the knowledge: rules, patterns, a couple of finished examples. It must stand alone (no skill read at run time).
- A check adapter that measures the output and sends one repair turn with what failed, when the output can be checked.
- `bench/`: cases and a bake-off between subscription models on native providers (never OpenRouter for Anthropic or OpenAI); Isaac judges blind (A/B, sides random, key kept apart). Default the model to the winner.
- `bun src/cli.ts agent validate <folder>/AGENT.md`, `bun test domains/<domain>`, prettier on the new files.
