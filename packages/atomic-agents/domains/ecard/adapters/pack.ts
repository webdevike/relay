import { Effect, FileSystem, Layer, Schema } from "effect"
import type { BunServices } from "@effect/platform-bun/BunServices"
import { pack, type StepAdapter, toolAdapter } from "../../../src/core/Adapter.ts"
import type { ToolsError } from "../../../src/core/Component.ts"
import { Email } from "./outlook.ts"
import { Commit, GitHub, Issue, IssueSummary, Linear, Meetings, PriorMeeting, PullSummary, WorkflowRuns } from "./services.ts"
import { Item, Message } from "./slack.ts"

/**
 * The eCard agents' adapters (`domains/ecard/ecard-*.json`). Every one reads; nothing here writes to Slack, Outlook, Linear
 * or GitHub (shadow mode). Steps lay one request out as the model's `prompt` (and `asOf`, the moment a replay reads
 * Linear and GitHub as of); tools read `repo`, `ref`, `runId` and `asOf` from the item, so the model never repeats them.
 */

class PromptError extends Schema.TaggedError<PromptError>()("PromptError", { message: Schema.String }) {}
class ToolError extends Schema.TaggedError<ToolError>()("ToolError", { message: Schema.String }) {}

/** A step that decodes the item with `schema` and lays it out as `prompt` plus `extra` fields. */
const promptStep = <S extends Schema.Decoder<unknown>>(spec: {
  readonly name: string
  readonly description: string
  readonly schema: S
  readonly extra?: ReadonlyArray<string>
  readonly build: (request: S["Type"]) => Effect.Effect<Readonly<Record<string, unknown>>, PromptError, BunServices>
}): StepAdapter<never> => ({
  name: spec.name,
  description: spec.description,
  provides: ["prompt", ...(spec.extra ?? [])],
  run: (fields) =>
    Schema.decodeUnknownEffect(spec.schema)(fields).pipe(
      Effect.mapError((error) => new PromptError({ message: `${spec.name}: ${error.message}` })),
      Effect.flatMap(spec.build)
    )
})

const text = (fields: Readonly<Record<string, unknown>>, name: string) => {
  const value = fields[name]
  return typeof value === "string" && value !== "" ? value : undefined
}

/** A field a tool needs that the item must carry (its agent's step or input provides it). */
const needed = <A>(value: A | undefined, name: string) =>
  value === undefined ? Effect.fail(new ToolError({ message: `this item has no ${name}` })) : Effect.succeed(value)

const Triaged = Schema.Struct({ ...Item.fields, reason: Schema.String })
const Comment = Schema.Struct({ repo: Schema.String, pr: Schema.Int, author: Schema.String, path: Schema.String, body: Schema.String, diffHunk: Schema.String, commit: Schema.optionalKey(Schema.String) })
const Merged = Schema.Struct({ repo: Schema.String, shas: Schema.Array(Schema.String), ticket: Schema.String, branch: Schema.String, pr: Schema.optionalKey(Schema.Int), at: Schema.optionalKey(Schema.String) })
const Upcoming = Schema.Struct({ title: Schema.String, start: Schema.String, end: Schema.optionalKey(Schema.String), organizer: Schema.optionalKey(Schema.String), attendees: Schema.Array(Schema.String), body: Schema.String })
const Assigned = Schema.Struct({ key: Schema.String, title: Schema.String, creator: Schema.String, at: Schema.optionalKey(Schema.String) })
const Failed = Schema.Struct({ repo: Schema.String, pr: Schema.optionalKey(Schema.Int), runId: Schema.Int, check: Schema.String, branch: Schema.String, sha: Schema.String, at: Schema.optionalKey(Schema.String), log: Schema.String })

const thread = (request: { readonly ts: string; readonly messages: ReadonlyArray<typeof Message.Type> }, reactions: boolean) =>
  request.messages.map((message) =>
    `[${message.ts}] ${message.author}${message.ts === request.ts ? " (FLAGGED)" : ""}: ${message.text}${reactions && message.reactions?.length ? `  {reactions: ${message.reactions.join(", ")}}` : ""}`)

const steps: ReadonlyArray<StepAdapter<never>> = [
  promptStep({
    name: "ecard.slack_item",
    description: "Lay out a fetched Slack item (ecard-slack-fetch/item.fetched): channel, flagged ts, Elysia's note, the messages with reactions.",
    schema: Item,
    build: (request) =>
      Effect.succeed({
        prompt: [`Channel: ${request.channel}`, `Flagged message ts: ${request.ts}`, `Flag note: ${request.summary || "(none)"}`, "Messages (time order):", ...thread(request, true)].join("\n")
      })
  }),
  promptStep({
    name: "ecard.slack_triaged",
    description: "Lay out a triaged Slack item (ecard-slack-triage/item.triaged): channel, why it needs Isaac, the messages.",
    schema: Triaged,
    build: (request) =>
      Effect.succeed({ prompt: [`Channel: ${request.channel}`, `Why it needs Isaac: ${request.reason}`, "Messages (time order):", ...thread(request, false)].join("\n") })
  }),
  promptStep({
    name: "ecard.review_comment",
    description: "Lay out a review comment on Isaac's PR (repo, PR, file, reviewer, hunk, comment); ref = the commented commit, else the PR head.",
    schema: Comment,
    extra: ["ref"],
    build: (request) =>
      Effect.succeed({
        ref: request.commit ?? `refs/pull/${request.pr}/head`,
        prompt: [`Repo: ${request.repo}  PR #${request.pr}`, `File: ${request.path}`, `Reviewer: ${request.author}`, "Diff hunk the comment is on:", request.diffHunk, "Comment:", request.body].join("\n")
      })
  }),
  promptStep({
    name: "ecard.merged_change",
    description: "Lay out code that landed for a ticket (ticket, repo, PR, branch, commits, when); asOf = when it landed.",
    schema: Merged,
    extra: ["asOf"],
    build: (request) =>
      Effect.succeed({
        ...(request.at === undefined ? {} : { asOf: request.at }),
        prompt: [
          `Ticket: ${request.ticket}`,
          `Repo: ${request.repo}${request.pr === undefined ? "" : ` PR #${request.pr}`}`,
          `Branch: ${request.branch}`,
          `Commits: ${request.shas.join(", ")}`,
          ...(request.at === undefined ? [] : [`Landed at: ${request.at}`])
        ].join("\n")
      })
  }),
  promptStep({
    name: "ecard.meeting_protocol",
    description: "Read the meeting protocol at path (without its transcript, first 20000 chars); asOf = the end of its **Date:** day.",
    schema: Schema.Struct({ path: Schema.String }),
    extra: ["asOf"],
    build: ({ path }) =>
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const protocol = yield* fs.readFileString(path).pipe(Effect.mapError((error) => new PromptError({ message: `${path}: ${error.message}` })))
        const day = /\*\*Date:\*\*\s*(\d{4}-\d{2}-\d{2})/.exec(protocol)?.[1]
        // Without its transcript: summary, decisions, the Tasks table and open questions carry the actions.
        return { ...(day === undefined ? {} : { asOf: `${day}T23:59:59Z` }), prompt: `Protocol ${path}:\n\n${protocol.split(/\n## Full Transcript/i)[0]!.slice(0, 20_000)}` }
      })
  }),
  promptStep({
    name: "ecard.email",
    description: "Lay out a fetched eCard email (ecard-outlook-fetch/email.fetched): headers, body (3000 chars), earlier thread messages (800 each).",
    schema: Email,
    build: (request) =>
      Effect.succeed({
        prompt: [
          `From: ${request.from}`,
          `To: ${request.to.join(", ") || "-"}`,
          `Subject: ${request.subject}`,
          `Received: ${request.received}`,
          "Body:",
          request.body.slice(0, 3000),
          ...(request.thread.length === 0 ? [] : ["Earlier in the thread (oldest first):", ...request.thread.map((message) => `[${message.at}] ${message.from}: ${message.body.slice(0, 800)}`)])
        ].join("\n")
      })
  }),
  promptStep({
    name: "ecard.meeting_upcoming",
    description: "Lay out an upcoming calendar event (title, when, organizer, attendees, description); asOf = its start in UTC.",
    schema: Upcoming,
    extra: ["asOf"],
    build: (request) =>
      Effect.succeed({
        // Linear and GitHub dates are UTC ISO; the calendar start carries an offset.
        asOf: new Date(request.start).toISOString(),
        prompt: [
          `Meeting: ${request.title}`,
          `When: ${request.start}${request.end === undefined ? "" : ` to ${request.end}`}`,
          ...(request.organizer === undefined ? [] : [`Organizer: ${request.organizer}`]),
          `Attendees: ${request.attendees.join(", ") || "(none listed)"}`,
          "Description:",
          request.body.slice(0, 2000) || "(empty)"
        ].join("\n")
      })
  }),
  promptStep({
    name: "ecard.ticket_assigned",
    description: "Lay out a ticket newly assigned to Isaac (key, title, filed by, when); asOf = when it was assigned.",
    schema: Assigned,
    extra: ["asOf"],
    build: (request) =>
      Effect.succeed({
        ...(request.at === undefined ? {} : { asOf: request.at }),
        prompt: [`Ticket: ${request.key} "${request.title}"`, `Filed by: ${request.creator}`, ...(request.at === undefined ? [] : [`Assigned at: ${request.at}`])].join("\n")
      })
  }),
  promptStep({
    name: "ecard.check_failed",
    description: "Lay out a failed GitHub check (repo, PR, check, run, branch, sha, when, the last 6000 chars of its log); asOf = when it failed.",
    schema: Failed,
    extra: ["asOf"],
    build: (request) =>
      Effect.succeed({
        ...(request.at === undefined ? {} : { asOf: request.at }),
        prompt: [
          `Repo: ${request.repo}${request.pr === undefined ? "" : `  PR #${request.pr}`}`,
          `Check: ${request.check}  run ${request.runId}`,
          `Branch: ${request.branch}  sha ${request.sha.slice(0, 8)}`,
          ...(request.at === undefined ? [] : [`Failed at: ${request.at}`]),
          "Failed log excerpt:",
          request.log.slice(-6000)
        ].join("\n")
      })
  })
]

/** The ecard adapters over `layer` (the real Linear GraphQL, `gh` and meeting-ledger readers, or test fakes). */
export const ecardPack = (
  layer: Layer.Layer<Linear | GitHub | Meetings, ToolsError, BunServices> = Layer.mergeAll(Linear.layer, GitHub.layer, Meetings.layer)
) =>
  pack({
    name: "ecard",
    layer,
    sources: [{
      name: "ecard.needs_isaac",
      description: "The input as the one item when its verdict is needs-isaac, else no item (nothing to do, nothing emitted).",
      provides: [],
      summary: [],
      fetch: (input) => Effect.succeed({ items: input["verdict"] === "needs-isaac" ? [{ fields: {}, commit: Effect.void }] : [], done: Effect.void, summary: {} })
    }],
    steps,
    tools: [
      toolAdapter({
        name: "ecard.linear_issue",
        description: "One ENG ticket by key: title, state, assignee, parent, description and its latest comments, as of the item's moment (when the code landed, the ticket was assigned, the meeting) when it has one.",
        args: Schema.Struct({ key: Schema.NonEmptyString }),
        example: `{"key": "ENG-1234"}`,
        returns: Issue,
        run: ({ key }, fields) => Effect.gen(function*() { return yield* (yield* Linear).issue(key, text(fields, "asOf")) })
      }),
      toolAdapter({
        name: "ecard.linear_search",
        description: "ENG tickets whose title or description matches the words, newest first, at most 8, created by the item's moment when it has one.",
        args: Schema.Struct({ text: Schema.NonEmptyString }),
        example: `{"text": "wallet pass"}`,
        returns: Schema.Array(IssueSummary),
        run: (args, fields) => Effect.gen(function*() { return yield* (yield* Linear).search(args.text, text(fields, "asOf")) })
      }),
      toolAdapter({
        name: "ecard.isaac_open_issues",
        description: "Isaac's open ENG tickets now (key, title, state, parent).",
        args: Schema.Struct({}),
        example: "{}",
        returns: Schema.Array(IssueSummary),
        run: () => Effect.gen(function*() { return yield* (yield* Linear).isaacOpen() })
      }),
      toolAdapter({
        name: "ecard.isaac_recent",
        description: "Isaac's ENG tickets (assigned or filed by him) in flight at the item's moment: open, or completed in the week before, with their state then; most recent activity first.",
        args: Schema.Struct({}),
        example: "{}",
        returns: Schema.Array(IssueSummary),
        run: (_, fields) => Effect.gen(function*() { return yield* (yield* Linear).isaacRecent(yield* needed(text(fields, "asOf"), "asOf")) })
      }),
      toolAdapter({
        name: "ecard.meeting_notes",
        description: "Eva's notes of what happened since this group last met (never this meeting): the last meeting of the same series and the eCard meetings after it, each with series, summary, tasks with who owns them, open questions, ENG keys named; at most 6.",
        args: Schema.Struct({}),
        example: "{}",
        returns: Schema.Array(PriorMeeting),
        run: (_, fields) => Effect.gen(function*() { return yield* (yield* Meetings).before(yield* needed(text(fields, "asOf"), "asOf"), text(fields, "title") ?? "") })
      }),
      toolAdapter({
        name: "ecard.github_prs",
        description: "eCardSystems PRs whose title or body matches the words (an ENG key works), newest first, at most 8, opened by the item's moment when it has one; state then: open, merged, or closed (closed without merging, abandoned).",
        args: Schema.Struct({ text: Schema.NonEmptyString }),
        example: `{"text": "ENG-1234"}`,
        returns: Schema.Array(PullSummary),
        run: (args, fields) => Effect.gen(function*() { return yield* (yield* GitHub).searchPrs(args.text, text(fields, "asOf")) })
      }),
      toolAdapter({
        name: "ecard.read_file",
        description: "Lines of a file in this PR at the commit the comment was made on (numbered, at most 200).",
        args: Schema.Struct({ path: Schema.NonEmptyString, from: Schema.Int, to: Schema.Int }),
        example: `{"path": "src/file.ts", "from": 1, "to": 120}`,
        returns: Schema.String,
        run: ({ path, from, to }, fields) =>
          Effect.gen(function*() {
            return yield* (yield* GitHub).file(yield* needed(text(fields, "repo"), "repo"), yield* needed(text(fields, "ref"), "ref"), path, from, to)
          })
      }),
      toolAdapter({
        name: "ecard.git_log",
        description: "One commit of this repo: message, author, date and changed files.",
        args: Schema.Struct({ sha: Schema.NonEmptyString }),
        example: `{"sha": "<sha>"}`,
        returns: Commit,
        run: ({ sha }, fields) => Effect.gen(function*() { return yield* (yield* GitHub).commit(yield* needed(text(fields, "repo"), "repo"), sha) })
      }),
      toolAdapter({
        name: "ecard.workflow_runs",
        description: "The other recent runs of this check's workflow (branch, sha, event, conclusion), before this failure.",
        args: Schema.Struct({}),
        example: "{}",
        returns: WorkflowRuns,
        run: (_, fields) =>
          Effect.gen(function*() {
            const runId = fields["runId"]
            return yield* (yield* GitHub).workflowRuns(yield* needed(text(fields, "repo"), "repo"), yield* needed(typeof runId === "number" ? runId : undefined, "runId"), text(fields, "asOf"))
          })
      }),
      toolAdapter({
        name: "ecard.failed_log",
        description: "The full failed-steps log of this run's first attempt (last 6000 chars), when the excerpt cuts off the error.",
        args: Schema.Struct({}),
        example: "{}",
        returns: Schema.String,
        run: (_, fields) =>
          Effect.gen(function*() {
            const runId = fields["runId"]
            return yield* (yield* GitHub).failedLog(yield* needed(text(fields, "repo"), "repo"), yield* needed(typeof runId === "number" ? runId : undefined, "runId"), 1)
          })
      })
    ]
  })
