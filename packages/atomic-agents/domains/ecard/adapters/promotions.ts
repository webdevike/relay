import { Context, Effect, FileSystem, Layer, Path, Schema } from "effect"
import { ChildProcessSpawner } from "effect/process"
import { EvaRoot } from "../../../src/core/adapters/eva.ts"
import { exec } from "../../../src/core/exec.ts"

/**
 * eCard GitHub as ecard-main-watch reads it: branch heads, the commits between two refs, staging deployments and the
 * repos Isaac worked in. REST over `fetch` with the `gh` CLI's token, GET only. The branch-head read is conditional
 * (`If-None-Match` with the last ETag): an unchanged head answers 304, which GitHub does not count against the rate limit.
 */

export const ORG = "eCardSystems"

export class PromotionsError extends Schema.TaggedError<PromotionsError>()("PromotionsError", { message: Schema.String }) {}

export interface GhCommit {
  readonly sha: string
  readonly message: string
  /** GitHub login of the author; null when the commit's email maps to no account. */
  readonly author: string | null
  readonly bot: boolean
  /** Committer date (ISO): when it landed on the branch. */
  readonly date: string
  readonly parents: ReadonlyArray<string>
}

export interface Pull {
  readonly title: string
  readonly author: string
  readonly branch: string
}

/** A staging deployment of a sha: `deployed` (success, or since superseded), `deploying`, `failed`, `missing` (the repo deploys to staging but not this sha yet) or `none` (the repo has no staging environment). */
export type Staging = "deployed" | "deploying" | "failed" | "missing" | "none"

/* GitHub's REST answers, only the fields read here (other keys are ignored when decoding). */
const RawCommit = Schema.Struct({
  sha: Schema.String,
  author: Schema.NullOr(Schema.Struct({ login: Schema.String, type: Schema.optionalKey(Schema.String) })),
  commit: Schema.Struct({ message: Schema.String, committer: Schema.Struct({ date: Schema.String }) }),
  parents: Schema.Array(Schema.Struct({ sha: Schema.String }))
})
const Login = Schema.Struct({ login: Schema.String })
const Ref = Schema.Struct({ object: Schema.Struct({ sha: Schema.String }) })
const Compare = Schema.Struct({ commits: Schema.Array(RawCommit) })
const RawPull = Schema.Struct({ title: Schema.String, user: Login, head: Schema.Struct({ ref: Schema.String }) })
const Deployments = Schema.Array(Schema.Struct({ id: Schema.Number }))
const Statuses = Schema.Array(Schema.Struct({ state: Schema.String }))
const PrSearch = Schema.Struct({ items: Schema.Array(Schema.Struct({ repository_url: Schema.String })) })
const CommitSearch = Schema.Struct({ items: Schema.Array(Schema.Struct({ repository: Schema.Struct({ name: Schema.String }) })) })

const toCommit = (raw: typeof RawCommit.Type): GhCommit => ({
  sha: raw.sha,
  message: raw.commit.message,
  author: raw.author?.login ?? null,
  bot: raw.author?.type === "Bot" || /\[bot\]$/.test(raw.author?.login ?? ""),
  date: raw.commit.committer.date,
  parents: raw.parents.map((parent) => parent.sha)
})

export class Promotions extends Context.Service<Promotions, {
  /** The authenticated user's login (Isaac's account). */
  readonly login: Effect.Effect<string, PromotionsError>
  /** A branch head; `not-modified` when it still matches `etag`. */
  head(repo: string, branch: string, etag?: string): Effect.Effect<{ readonly sha: string; readonly etag?: string } | "not-modified", PromotionsError>
  /** One commit by sha or ref. */
  commit(repo: string, ref: string): Effect.Effect<GhCommit, PromotionsError>
  /** Every commit reachable from `head` and not from `base`, merge parents included (GitHub's `base...head` compare), oldest first. */
  between(repo: string, base: string, head: string): Effect.Effect<ReadonlyArray<GhCommit>, PromotionsError>
  /** The newest 100 commits reachable from `ref` (all parents). */
  history(repo: string, ref: string): Effect.Effect<ReadonlyArray<GhCommit>, PromotionsError>
  pull(repo: string, number: number): Effect.Effect<Pull, PromotionsError>
  staging(repo: string, sha: string): Effect.Effect<Staging, PromotionsError>
  hasBranch(repo: string, branch: string): Effect.Effect<boolean, PromotionsError>
  /** Repos in the org where `login` opened a PR or authored a default-branch commit since `since` (YYYY-MM-DD). */
  activeRepos(login: string, since: string): Effect.Effect<ReadonlyArray<string>, PromotionsError>
}>()("atomic-agents/ecard/Promotions") {
  static readonly layer = Layer.effect(
    Promotions,
    Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      // Env first, else `gh auth token` once per process: a re-login applies after the service restarts.
      let token: string | undefined = process.env["GH_TOKEN"] || process.env["GITHUB_TOKEN"] || undefined
      const auth = Effect.gen(function*() {
        if (token !== undefined) return token
        const result = yield* exec("gh", ["auth", "token"]).pipe(
          Effect.catchTag("PlatformError", (error) => Effect.fail(new PromotionsError({ message: `gh auth token: ${error.message}` }))),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner)
        )
        if (result.exitCode !== 0 || result.stdout.trim() === "") return yield* new PromotionsError({ message: `gh auth token: ${result.stderr.trim() || "no token"}` })
        token = result.stdout.trim()
        return token
      })
      const get = (route: string, etag?: string) =>
        Effect.gen(function*() {
          const bearer = yield* auth
          return yield* Effect.tryPromise({
            try: async () => {
              const response = await fetch(`https://api.github.com/${route}`, {
                headers: {
                  Accept: "application/vnd.github+json",
                  Authorization: `Bearer ${bearer}`,
                  "X-GitHub-Api-Version": "2022-11-28",
                  ...(etag === undefined ? {} : { "If-None-Match": etag })
                },
                signal: AbortSignal.timeout(30_000)
              })
              const body: unknown = response.status === 304 ? undefined : await response.json().catch(() => undefined)
              return { status: response.status, etag: response.headers.get("etag") ?? undefined, body }
            },
            catch: (error) => new PromotionsError({ message: `GET ${route}: ${String(error)}` })
          })
        })
      /** A 200 answer decoded with `schema`; anything else fails naming the route. */
      const ok = <A>(route: string, schema: Schema.Decoder<A>) =>
        get(route).pipe(
          Effect.flatMap((response) =>
            response.status === 200
              ? Effect.succeed(response.body)
              : Effect.fail(new PromotionsError({ message: `GET ${route}: ${response.status} ${JSON.stringify(response.body ?? "").slice(0, 200)}` }))),
          Effect.flatMap((body) =>
            Schema.decodeUnknownEffect(schema)(body).pipe(Effect.mapError((error) => new PromotionsError({ message: `GET ${route}: ${error.message}` }))))
        )
      const repoPath = (repo: string): Effect.Effect<string, PromotionsError> =>
        /^[\w.-]+$/.test(repo) ? Effect.succeed(`repos/${ORG}/${repo}`) : Effect.fail(new PromotionsError({ message: `bad repo: ${repo}` }))

      return Promotions.of({
        login: ok("user", Login).pipe(Effect.map((user) => user.login)),
        head: (repo, branch, etag) =>
          Effect.gen(function*() {
            const route = `${yield* repoPath(repo)}/git/ref/heads/${encodeURIComponent(branch)}`
            const response = yield* get(route, etag)
            if (response.status === 304) return "not-modified" as const
            if (response.status !== 200) return yield* new PromotionsError({ message: `GET ${route}: ${response.status}` })
            const { object } = yield* Schema.decodeUnknownEffect(Ref)(response.body).pipe(
              Effect.mapError((error) => new PromotionsError({ message: `GET ${route}: ${error.message}` }))
            )
            return response.etag === undefined ? { sha: object.sha } : { sha: object.sha, etag: response.etag }
          }),
        commit: (repo, sha) =>
          repoPath(repo).pipe(Effect.flatMap((base) => ok(`${base}/commits/${encodeURIComponent(sha)}`, RawCommit)), Effect.map(toCommit)),
        between: (repo, base, head) =>
          Effect.gen(function*() {
            const path = `${yield* repoPath(repo)}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`
            const commits: Array<GhCommit> = []
            // 100 per page; a promotion of more than 1000 commits is cut there.
            for (let page = 1; page <= 10; page++) {
              const { commits: batch } = yield* ok(`${path}?per_page=100&page=${page}`, Compare)
              commits.push(...batch.map(toCommit))
              if (batch.length < 100) break
            }
            return commits
          }),
        history: (repo, sha) =>
          repoPath(repo).pipe(
            Effect.flatMap((base) => ok(`${base}/commits?sha=${encodeURIComponent(sha)}&per_page=100`, Schema.Array(RawCommit))),
            Effect.map((commits) => commits.map(toCommit))
          ),
        pull: (repo, number) =>
          repoPath(repo).pipe(
            Effect.flatMap((base) => ok(`${base}/pulls/${number}`, RawPull)),
            Effect.map((pr) => ({ title: pr.title, author: pr.user.login, branch: pr.head.ref }))
          ),
        staging: (repo, sha) =>
          Effect.gen(function*() {
            const base = yield* repoPath(repo)
            const [deployment] = yield* ok(`${base}/deployments?environment=staging&sha=${encodeURIComponent(sha)}&per_page=1`, Deployments)
            if (deployment === undefined) {
              const any = yield* ok(`${base}/deployments?environment=staging&per_page=1`, Deployments)
              return any.length === 0 ? "none" as const : "missing" as const
            }
            const [status] = yield* ok(`${base}/deployments/${deployment.id}/statuses?per_page=1`, Statuses)
            if (status?.state === "success" || status?.state === "inactive") return "deployed" as const
            return status?.state === "failure" || status?.state === "error" ? "failed" as const : "deploying" as const
          }),
        hasBranch: (repo, branch) =>
          Effect.gen(function*() {
            const route = `${yield* repoPath(repo)}/branches/${encodeURIComponent(branch)}`
            const response = yield* get(route)
            if (response.status === 200) return true
            if (response.status === 404) return false
            return yield* new PromotionsError({ message: `GET ${route}: ${response.status}` })
          }),
        activeRepos: (login, since) =>
          Effect.gen(function*() {
            const prs = yield* ok(`search/issues?q=${encodeURIComponent(`type:pr author:${login} org:${ORG} created:>=${since}`)}&per_page=100`, PrSearch)
            const commits = yield* ok(`search/commits?q=${encodeURIComponent(`author:${login} org:${ORG} committer-date:>=${since}`)}&per_page=100`, CommitSearch)
            const names = [...prs.items.map((item) => item.repository_url.split("/").pop() ?? ""), ...commits.items.map((item) => item.repository.name)]
            return [...new Set(names)].filter((name) => name !== "")
          })
      })
    })
  )
}

/** Eva's ENG ledgers (`work/items/ENG-<n>.md` under Eva's checkout), read each run: Isaac's tickets, and the repos they name. */
export class Ledgers extends Context.Service<Ledgers, {
  readonly read: Effect.Effect<{ readonly keys: ReadonlySet<string>; readonly repos: ReadonlyArray<string> }, PromotionsError>
}>()("atomic-agents/ecard/Ledgers") {
  static readonly layer = Layer.effect(
    Ledgers,
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dir = path.join(yield* EvaRoot, "work", "items")
      const ledgerError = (error: { readonly message: string }) => new PromotionsError({ message: `${dir}: ${error.message}` })
      return Ledgers.of({
        read: Effect.gen(function*() {
          if (!(yield* fs.exists(dir).pipe(Effect.mapError(ledgerError)))) return { keys: new Set<string>(), repos: [] }
          const names = (yield* fs.readDirectory(dir).pipe(Effect.mapError(ledgerError))).filter((name) => /^ENG-\d+\.md$/.test(name))
          const repos = new Set<string>()
          for (const name of names) {
            const text = yield* fs.readFileString(path.join(dir, name)).pipe(Effect.mapError(ledgerError))
            const repo = /^repo:\s*(?:eCardSystems\/)?([\w.-]+)\s*$/m.exec(text)?.[1]
            if (repo !== undefined) repos.add(repo)
          }
          return { keys: new Set(names.map((name) => name.slice(0, -3))), repos: [...repos] }
        })
      })
    })
  )
}
