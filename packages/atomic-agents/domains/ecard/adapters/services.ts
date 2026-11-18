import { Context, Effect, FileSystem, Layer, Path, Redacted, Schema } from "effect"
import { ChildProcessSpawner } from "effect/process"
import { EvaRoot } from "../../../src/core/adapters/eva.ts"
import { exec } from "../../../src/core/exec.ts"

/**
 * Read-only eCard services behind the ecard pack's tools: Linear (GraphQL, queries only) and GitHub (`gh api`, GET
 * only). Neither has a write operation, so an agent cannot move, comment or post through them.
 */

export class LinearError extends Schema.TaggedError<LinearError>()("LinearError", { message: Schema.String }) {}
export class GitHubError extends Schema.TaggedError<GitHubError>()("GitHubError", { message: Schema.String }) {}

/*
 * What the services answer, as schemas: the TypeScript types below come from them, and the ecard tools hand the same
 * schemas to code mode as their `returns`, so a script's typed API cannot drift from what the tools return.
 */
export const IssueComment = Schema.Struct({ at: Schema.String, by: Schema.String, body: Schema.String })
export type IssueComment = typeof IssueComment.Type

export const Issue = Schema.Struct({
  key: Schema.String,
  title: Schema.String,
  url: Schema.String,
  /** State and assignee as of `asOf` when given (replayed from the issue history), else now. */
  state: Schema.String,
  assignee: Schema.NullOr(Schema.String),
  parent: Schema.NullOr(Schema.String),
  description: Schema.String,
  /** Newest last, at most 6, only those made before `asOf`. */
  comments: Schema.Array(IssueComment)
})
export type Issue = typeof Issue.Type

export const IssueSummary = Schema.Struct({
  key: Schema.String,
  title: Schema.String,
  state: Schema.String,
  assignee: Schema.NullOr(Schema.String),
  parent: Schema.NullOr(Schema.String),
  createdAt: Schema.String
})
export type IssueSummary = typeof IssueSummary.Type

export class Linear extends Context.Service<Linear, {
  /** One issue by key (`ENG-1234`); `asOf` (ISO) replays its state, assignee and comments to that moment. */
  issue(key: string, asOf?: string): Effect.Effect<Issue, LinearError>
  /** ENG issues whose title or description matches `text`, newest first, at most 8; `before` (ISO) drops later ones. */
  search(text: string, before?: string): Effect.Effect<ReadonlyArray<IssueSummary>, LinearError>
  /** ENG issues assigned to Isaac Weber not Done or Canceled (as of now), at most 50. */
  isaacOpen(): Effect.Effect<ReadonlyArray<IssueSummary>, LinearError>
}>()("atomic-agents/ecard/Linear") {
  static readonly layer = Layer.effect(
    Linear,
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const keyFile = path.join(yield* EvaRoot, "secrets", "linear.env")
      // Read per call, never logged: a rotated key applies without a restart.
      const apiKey = Effect.gen(function*() {
        if (process.env["LINEAR_API_KEY"]) return Redacted.make(process.env["LINEAR_API_KEY"])
        const text = yield* fs.readFileString(keyFile).pipe(Effect.mapError(() => new LinearError({ message: `no LINEAR_API_KEY and no ${keyFile}` })))
        const line = text.split("\n").find((candidate) => /^\s*(export\s+)?LINEAR_API_KEY=/.test(candidate))
        if (line === undefined) return yield* new LinearError({ message: `${keyFile} has no LINEAR_API_KEY` })
        return Redacted.make(line.replace(/^\s*(export\s+)?LINEAR_API_KEY=/, "").trim().replace(/^["']|["']$/g, ""))
      })
      const query = <A>(gql: string, variables: Record<string, unknown>) =>
        Effect.gen(function*() {
          const key = yield* apiKey
          const body = yield* Effect.tryPromise({
            try: async () => {
              const response = await fetch("https://api.linear.app/graphql", {
                method: "POST",
                headers: { "Content-Type": "application/json", Authorization: Redacted.value(key) },
                body: JSON.stringify({ query: gql, variables }),
                signal: AbortSignal.timeout(30_000)
              })
              return (await response.json()) as { data?: A; errors?: ReadonlyArray<{ message: string }> }
            },
            catch: (error) => new LinearError({ message: `linear: ${String(error)}` })
          })
          if (body.errors?.length || body.data === undefined) {
            return yield* new LinearError({ message: `linear: ${body.errors?.map((error) => error.message).join("; ") ?? "no data"}` })
          }
          return body.data
        })

      type Node = {
        identifier: string
        title: string
        url: string
        createdAt: string
        state: { name: string }
        assignee: { name: string } | null
        parent: { identifier: string } | null
      }
      const summary = (node: Node): IssueSummary => ({
        key: node.identifier,
        title: node.title,
        state: node.state.name,
        assignee: node.assignee?.name ?? null,
        parent: node.parent?.identifier ?? null,
        createdAt: node.createdAt
      })
      const FIELDS = "identifier title url createdAt state { name } assignee { name } parent { identifier }"

      return Linear.of({
        issue: (key, asOf) =>
          query<{
            issue: Node & {
              description: string | null
              history: { nodes: ReadonlyArray<{ createdAt: string; fromState: { name: string } | null; toState: { name: string } | null; fromAssignee: { name: string } | null; toAssignee: { name: string } | null; actor: unknown }> }
              comments: { nodes: ReadonlyArray<{ createdAt: string; body: string; user: { name: string } | null }> }
            }
          }>(
            `query($id: String!) { issue(id: $id) { ${FIELDS} description
              history(first: 100) { nodes { createdAt fromState { name } toState { name } fromAssignee { name } toAssignee { name } actor { id } } }
              comments(first: 50) { nodes { createdAt body user { name } } } } }`,
            { id: key }
          ).pipe(Effect.map(({ issue }) => {
            let state = issue.state.name
            let assignee = issue.assignee?.name ?? null
            if (asOf !== undefined) {
              // Undo every change made after asOf, newest first.
              const later = issue.history.nodes.filter((entry) => entry.createdAt > asOf).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
              for (const entry of later) {
                if (entry.toState !== null && entry.fromState !== null) state = entry.fromState.name
                if (entry.toAssignee !== null || entry.fromAssignee !== null) assignee = entry.fromAssignee?.name ?? null
              }
            }
            const comments = issue.comments.nodes
              .filter((comment) => asOf === undefined || comment.createdAt <= asOf)
              .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
              .slice(-6)
              .map((comment) => ({ at: comment.createdAt, by: comment.user?.name ?? "?", body: comment.body.slice(0, 600) }))
            return {
              key: issue.identifier,
              title: issue.title,
              url: issue.url,
              state,
              assignee,
              parent: issue.parent?.identifier ?? null,
              description: (issue.description ?? "").slice(0, 1500),
              comments
            }
          })),
        search: (text, before) =>
          query<{ searchIssues: { nodes: ReadonlyArray<Node> } }>(
            `query($term: String!) { searchIssues(term: $term, first: 20, filter: { team: { key: { eq: "ENG" } } }) { nodes { ${FIELDS} } } }`,
            { term: text }
          ).pipe(Effect.map(({ searchIssues }) =>
            searchIssues.nodes.filter((node) => before === undefined || node.createdAt <= before).slice(0, 8).map(summary))),
        isaacOpen: () =>
          query<{ issues: { nodes: ReadonlyArray<Node> } }>(
            `query { issues(first: 50, orderBy: updatedAt, filter: { team: { key: { eq: "ENG" } }, assignee: { name: { eq: "Isaac Weber" } }, state: { type: { nin: ["completed", "canceled"] } } }) { nodes { ${FIELDS} } } }`,
            {}
          ).pipe(Effect.map(({ issues }) => issues.nodes.map(summary)))
      })
    })
  )
}

export const Commit = Schema.Struct({ sha: Schema.String, message: Schema.String, author: Schema.String, date: Schema.String, files: Schema.Array(Schema.String) })
export type Commit = typeof Commit.Type

export const PullSummary = Schema.Struct({
  repo: Schema.String,
  number: Schema.Int,
  title: Schema.String,
  /** As of the search's `before` when given, else now: merged, closed without merging (abandoned), or open. */
  state: Schema.Literals(["open", "merged", "closed"]),
  author: Schema.String,
  createdAt: Schema.String,
  mergedAt: Schema.NullOr(Schema.String)
})
export type PullSummary = typeof PullSummary.Type

export const WorkflowRun = Schema.Struct({
  id: Schema.Int,
  branch: Schema.String,
  sha: Schema.String,
  event: Schema.String,
  conclusion: Schema.NullOr(Schema.String),
  attempt: Schema.Int,
  createdAt: Schema.String
})
export type WorkflowRun = typeof WorkflowRun.Type

export const WorkflowRuns = Schema.Struct({ workflow: Schema.String, branch: Schema.String, runs: Schema.Array(WorkflowRun) })
export type WorkflowRuns = typeof WorkflowRuns.Type

export class GitHub extends Context.Service<GitHub, {
  /** A commit's message, author, date and changed files (`gh api repos/<repo>/commits/<sha>`). */
  commit(repo: string, sha: string): Effect.Effect<Commit, GitHubError>
  /**
   * eCardSystems PRs whose title or body matches `text`, newest first, at most 8; `before` (ISO) drops later ones and
   * replays each PR's state to then (a PR merged or closed after `before` was still open).
   */
  searchPrs(text: string, before?: string): Effect.Effect<ReadonlyArray<PullSummary>, GitHubError>
  /** The workflow of run `runId` and its other runs (any branch) created before `before` (ISO, else now), newest first, at most 15. */
  workflowRuns(repo: string, runId: number, before?: string): Effect.Effect<WorkflowRuns, GitHubError>
  /** The failed steps' log of one attempt of a run (`gh run view --log-failed`), last 6000 chars. */
  failedLog(repo: string, runId: number, attempt: number): Effect.Effect<string, GitHubError>
}>()("atomic-agents/ecard/GitHub") {
  static readonly layer = Layer.effect(
    GitHub,
    Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const gh = (args: ReadonlyArray<string>) =>
        exec("gh", args).pipe(
          Effect.timeoutOrElse({ duration: "60 seconds", orElse: () => Effect.fail(new GitHubError({ message: `gh ${args.join(" ")} timed out` })) }),
          Effect.catchTag("PlatformError", (error) => Effect.fail(new GitHubError({ message: error.message }))),
          Effect.flatMap((result) =>
            result.exitCode === 0
              ? Effect.succeed(result.stdout)
              : Effect.fail(new GitHubError({ message: `gh ${args.join(" ")}: ${(result.stderr || result.stdout).trim().slice(-300)}` }))),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner)
        )
      const json = (route: string, jq?: string) =>
        gh(["api", "--method", "GET", route, ...(jq === undefined ? [] : ["--jq", jq])]).pipe(Effect.flatMap((stdout) =>
          Effect.try({ try: (): unknown => JSON.parse(stdout), catch: () => new GitHubError({ message: `gh api ${route}: not JSON` }) })))
      const safe = (value: string) => /^[\w.-]+\/[\w.-]+$/.test(value)
      return GitHub.of({
        commit: (repo, sha) =>
          !safe(repo) || !/^[0-9a-f]{7,40}$/i.test(sha)
            ? Effect.fail(new GitHubError({ message: `bad repo or sha: ${repo} ${sha}` }))
            : json(`repos/${repo}/commits/${sha}`, "{sha, message: .commit.message, author: .commit.author.name, date: .commit.author.date, files: [.files[].filename]}").pipe(
              Effect.map((value) => value as Commit)
            ),
        searchPrs: (text, before) => {
          const terms = text.replace(/[^\w\s.#-]/g, " ").trim()
          const query = `${terms} org:eCardSystems is:pr${before === undefined ? "" : ` created:<=${before.slice(0, 10)}`}`
          return json(
            `search/issues?per_page=8&sort=created&order=desc&q=${encodeURIComponent(query)}`,
            `[.items[] | {repo: (.repository_url | split("/") | .[-2:] | join("/")), number, title, author: .user.login, createdAt: .created_at, closedAt: .closed_at, mergedAt: .pull_request.merged_at}]`
          ).pipe(Effect.map((value) =>
            (value as ReadonlyArray<{ repo: string; number: number; title: string; author: string; createdAt: string; closedAt: string | null; mergedAt: string | null }>)
              // The search API says "closed" for merged PRs too; the merge time tells them apart.
              .map(({ closedAt, mergedAt, ...pull }): PullSummary => {
                const cutoff = before ?? "9999"
                const merged = mergedAt !== null && mergedAt <= cutoff
                return { ...pull, state: merged ? "merged" : closedAt !== null && closedAt <= cutoff ? "closed" : "open", mergedAt: merged ? mergedAt : null }
              })
          ))
        },
        workflowRuns: (repo, runId, before) =>
          !safe(repo)
            ? Effect.fail(new GitHubError({ message: `bad repo ${repo}` }))
            : Effect.gen(function*() {
              const run = (yield* json(`repos/${repo}/actions/runs/${runId}`, "{workflow: .workflow_id, name, branch: .head_branch, created: .created_at}")) as {
                workflow: number
                name: string
                branch: string
                created: string
              }
              const cutoff = before ?? new Date().toISOString()
              const runs = (yield* json(
                `repos/${repo}/actions/workflows/${run.workflow}/runs?per_page=50`,
                `[.workflow_runs[] | {id, branch: .head_branch, sha: .head_sha[0:8], event, conclusion, attempt: .run_attempt, createdAt: .created_at}]`
              )) as ReadonlyArray<WorkflowRun>
              // Reruns of `runId` itself happen later, so its own attempts are left out: the replay sees only what existed then.
              return { workflow: run.name, branch: run.branch, runs: runs.filter((entry) => entry.id !== runId && entry.createdAt <= cutoff).slice(0, 15) }
            }),
        failedLog: (repo, runId, attempt) =>
          !safe(repo)
            ? Effect.fail(new GitHubError({ message: `bad repo ${repo}` }))
            : gh(["run", "view", String(runId), "-R", repo, "--attempt", String(attempt), "--log-failed"]).pipe(Effect.map((log) => log.slice(-6000)))
      })
    })
  )
}
