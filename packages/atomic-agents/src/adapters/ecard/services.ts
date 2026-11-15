import { Context, Effect, FileSystem, Layer, Path, Redacted, Schema } from "effect"
import { ChildProcessSpawner } from "effect/process"
import { EvaRoot } from "../eva.ts"
import { exec } from "../../exec.ts"

/**
 * Read-only eCard services behind the ecard pack's tools: Linear (GraphQL, queries only) and GitHub (`gh api`, GET only).
 * Neither service has a write operation, so a chef cannot move, comment or post through them.
 */

export class LinearError extends Schema.TaggedError<LinearError>()("LinearError", { message: Schema.String }) {}
export class GitHubError extends Schema.TaggedError<GitHubError>()("GitHubError", { message: Schema.String }) {}

export interface IssueComment {
  readonly at: string
  readonly by: string
  readonly body: string
}

export interface Issue {
  readonly key: string
  readonly title: string
  readonly url: string
  /** State and assignee as of `asOf` when given (replayed from the issue history), else now. */
  readonly state: string
  readonly assignee: string | null
  readonly parent: string | null
  readonly description: string
  /** Newest last, at most 6, only those made before `asOf`. */
  readonly comments: ReadonlyArray<IssueComment>
}

export interface IssueSummary {
  readonly key: string
  readonly title: string
  readonly state: string
  readonly assignee: string | null
  readonly parent: string | null
  readonly createdAt: string
}

export class Linear extends Context.Service<Linear, {
  /** One issue by key (`ENG-1234`); `asOf` (ISO) replays its state, assignee and comments to that moment. */
  issue(key: string, asOf?: string): Effect.Effect<Issue, LinearError>
  /** ENG issues whose title or description matches `text`, newest first, at most 8; `before` (ISO) drops later ones. */
  search(text: string, before?: string): Effect.Effect<ReadonlyArray<IssueSummary>, LinearError>
  /** ENG issues assigned to Isaac Weber not Done or Canceled (as of now), at most 50. */
  isaacOpen(): Effect.Effect<ReadonlyArray<IssueSummary>, LinearError>
  /**
   * ENG issues Isaac Weber is assigned or filed that were in flight at `asOf` (ISO): created by then, not canceled
   * by then, open or completed in the 7 days before. Most recent activity (created, started, completed) first, at
   * most 15, with the state as of then (Todo, In Progress or Done, from those dates).
   */
  isaacRecent(asOf: string): Effect.Effect<ReadonlyArray<IssueSummary>, LinearError>
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
          ).pipe(Effect.map(({ issues }) => issues.nodes.map(summary))),
        isaacRecent: (when) => {
          // Linear dates are UTC ISO; a calendar start carries an offset, so normalize before comparing strings.
          const asOf = new Date(when).toISOString()
          const weekBefore = new Date(Date.parse(asOf) - 7 * 86_400_000).toISOString()
          return query<{ issues: { nodes: ReadonlyArray<Node & { startedAt: string | null; completedAt: string | null }> } }>(
            `query($asOf: DateTimeOrDuration!, $weekBefore: DateTimeOrDuration!) { issues(first: 100, filter: { team: { key: { eq: "ENG" } }, createdAt: { lte: $asOf },
              and: [{ or: [{ assignee: { name: { eq: "Isaac Weber" } } }, { creator: { name: { eq: "Isaac Weber" } } }] },
                { or: [{ completedAt: { null: true } }, { completedAt: { gte: $weekBefore } }] },
                { or: [{ canceledAt: { null: true } }, { canceledAt: { gte: $asOf } }] }] }) { nodes { ${FIELDS} startedAt completedAt } } }`,
            { asOf, weekBefore }
          ).pipe(Effect.map(({ issues }) =>
            issues.nodes
              .map((node) => {
                // Dates after asOf had not happened yet.
                const started = node.startedAt !== null && node.startedAt <= asOf ? node.startedAt : null
                const completed = node.completedAt !== null && node.completedAt <= asOf ? node.completedAt : null
                return { node, activity: completed ?? started ?? node.createdAt, state: completed !== null ? "Done" : started !== null ? "In Progress" : "Todo" }
              })
              .sort((a, b) => b.activity.localeCompare(a.activity))
              .slice(0, 15)
              .map(({ node, state }) => ({ ...summary(node), state }))))
        }
      })
    })
  )
}

export interface Commit {
  readonly sha: string
  readonly message: string
  readonly author: string
  readonly date: string
  readonly files: ReadonlyArray<string>
}

export interface PullSummary {
  readonly repo: string
  readonly number: number
  readonly title: string
  readonly state: string
  readonly author: string
  readonly createdAt: string
}

export interface WorkflowRun {
  readonly id: number
  readonly branch: string
  readonly sha: string
  readonly event: string
  readonly conclusion: string | null
  readonly attempt: number
  readonly createdAt: string
}

export class GitHub extends Context.Service<GitHub, {
  /** A commit's message, author, date and changed files (`gh api repos/<repo>/commits/<sha>`). */
  commit(repo: string, sha: string): Effect.Effect<Commit, GitHubError>
  /** A file at a ref, numbered lines `from`..`to` (1-based, at most 200 lines). */
  file(repo: string, ref: string, filePath: string, from: number, to: number): Effect.Effect<string, GitHubError>
  /** The PR's other review comments in that file and the replies to `commentId` (author, body). */
  thread(repo: string, pr: number, commentId: number): Effect.Effect<unknown, GitHubError>
  /** eCardSystems PRs whose title or body matches `text`, newest first, at most 8; `before` (ISO) drops later ones. */
  searchPrs(text: string, before?: string): Effect.Effect<ReadonlyArray<PullSummary>, GitHubError>
  /** The workflow of run `runId` and its other runs (any branch) created before `before` (ISO, else now), newest first, at most 15. */
  workflowRuns(repo: string, runId: number, before?: string): Effect.Effect<{ readonly workflow: string; readonly branch: string; readonly runs: ReadonlyArray<WorkflowRun> }, GitHubError>
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
        file: (repo, ref, filePath, from, to) =>
          !safe(repo)
            ? Effect.fail(new GitHubError({ message: `bad repo ${repo}` }))
            : json(`repos/${repo}/contents/${filePath.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(ref)}`, ".content").pipe(
              Effect.map((content) => {
                const lines = Buffer.from(String(content), "base64").toString("utf8").split("\n")
                const start = Math.max(1, from)
                const end = Math.min(lines.length, to, start + 199)
                return lines.slice(start - 1, end).map((line, index) => `${start + index}: ${line}`).join("\n")
              })
            ),
        thread: (repo, pr, commentId) =>
          !safe(repo)
            ? Effect.fail(new GitHubError({ message: `bad repo ${repo}` }))
            : json(`repos/${repo}/pulls/${pr}/comments?per_page=100`, `[.[] | select(.id == ${commentId} or .in_reply_to_id == ${commentId}) | {author: .user.login, at: .created_at, body: .body[0:800]}]`),
        searchPrs: (text, before) => {
          const terms = text.replace(/[^\w\s.#-]/g, " ").trim()
          const query = `${terms} org:eCardSystems is:pr${before === undefined ? "" : ` created:<=${before.slice(0, 10)}`}`
          return json(
            `search/issues?per_page=8&sort=created&order=desc&q=${encodeURIComponent(query)}`,
            `[.items[] | {repo: (.repository_url | split("/") | .[-2:] | join("/")), number, title, state, author: .user.login, createdAt: .created_at}]`
          ).pipe(Effect.map((value) => value as ReadonlyArray<PullSummary>))
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
