import { Clock, Effect, FileSystem, Layer, Path, Schema } from "effect"
import { type GhCommit, Ledgers, ORG, Promotions, type Staging } from "./adapters/promotions.ts"
import { type Component, define, job, Trigger } from "../../src/core/Component.ts"

/**
 * `kind: "code"` agent (`ecard-main-watch.json`, next to this file): tells Eva when develop is promoted to `main` (what
 * staging deploys) in the eCard repos Isaac works in, and which of his tickets rode along, so Astra can tell Steve what
 * is on stage. No model. Promotions are found by ancestry, whoever pushed and however: every commit newly reachable from
 * the new main head (merge commits' second parents included) is mapped to ENG keys (commit messages, merged PRs' titles
 * and branches), and a key is Isaac's when he authored a commit or PR carrying it or Eva has a ledger
 * `work/items/<KEY>.md` for it (Noah's re-commits on main carry the key, not Isaac's authorship).
 * - `watch` (cron every 5 min): one conditional read of each repo's main head (a 304 costs no rate limit); a moved head
 *   waits up to an hour for its staging deploy, then emits one `main.promoted` when it carries Isaac's tickets or some of
 *   his are still only on develop. First sight of a repo records its head silently.
 * - `replay` (manual, what `request` runs): the same computation for one given `toSha`, emitted as `promotion.replayed`.
 */

/** Wait this long after a head moves for its staging deploy before reporting it anyway. */
export const STAGE_WAIT_MS = 60 * 60_000
/** How far back Isaac's PRs and commits count when deriving his repos; the list is re-derived daily. */
const ACTIVE_DAYS = 60
const DAY_MS = 86_400_000

const Ticket = Schema.Struct({
  key: Schema.String,
  /** The commit subject (or merged PR title) without its `type: ref ENG-n` prefix. */
  title: Schema.String,
  /** The Linear issue. */
  url: Schema.String,
  /** The newest commit in the range that carries it. */
  sha: Schema.String
})
export type Ticket = typeof Ticket.Type

const Promotion = Schema.Struct({
  repo: Schema.String,
  fromSha: Schema.String,
  toSha: Schema.String,
  compare: Schema.String,
  /** `deployed` to staging, `not-deployed` an hour after the push (or not yet, for a replay), `failed`, or `none` (no staging environment). */
  staging: Schema.Literals(["deployed", "not-deployed", "failed", "none"]),
  /** Isaac's tickets newly on main. */
  tickets: Schema.Array(Ticket),
  /** Isaac's tickets on develop and not yet on main. */
  pendingOnDevelop: Schema.Array(Ticket),
  /** Everyone else's tickets in the promotion, keys only. */
  otherTickets: Schema.Array(Schema.String)
})
export type Promotion = typeof Promotion.Type

const events = {
  /** One per promotion that carries Isaac's tickets or leaves some of his on develop: Astra's heartbeat `[main]` line. */
  "main.promoted": Promotion,
  /** `replay`'s answer; never read by the heartbeat. */
  "promotion.replayed": Promotion,
  /** The repos watched, re-derived daily: Isaac's PRs and commits in the last 60 days plus Eva's ledgers, kept when they have a `develop` branch. */
  "repos.derived": Schema.Struct({ repos: Schema.Array(Schema.String), candidates: Schema.Array(Schema.String) })
}

export class MainWatchError extends Schema.TaggedError<MainWatchError>()("MainWatchError", { message: Schema.String }) {}

const RepoState = Schema.Struct({
  /** The main head last reported (or recorded on first sight). */
  sha: Schema.String,
  /** ETag of the last main read: the next read is conditional. */
  etag: Schema.optionalKey(Schema.String),
  /** A newer head waiting for its staging deploy, and since when. */
  waiting: Schema.optionalKey(Schema.Struct({ sha: Schema.String, since: Schema.String }))
})
type RepoState = typeof RepoState.Type
const State = Schema.Struct({
  login: Schema.optionalKey(Schema.String),
  repos: Schema.optionalKey(Schema.Array(Schema.String)),
  reposAt: Schema.optionalKey(Schema.String),
  heads: Schema.Record(Schema.String, RepoState)
})
type State = typeof State.Type
const decodeState = Schema.decodeUnknownEffect(Schema.fromJsonString(State))

/** Distinct `ENG-<n>` keys in `text`, upper-cased (branch names spell them `eng-7489`). */
export const keysOf = (text: string): ReadonlyArray<string> => [...new Set([...text.matchAll(/\bENG-(\d+)/gi)].map((match) => `ENG-${match[1]}`))]

/** `fix: ref ENG-6832 Platform Assets fixes (#254)` (or a squash body's `* fix: ref ENG-5974 ...` line) -> `Platform Assets fixes`, at most 120 chars. */
export const titleOf = (line: string): string => {
  const bare = line.replace(/^\s*[*-]\s+/, "")
  const title = bare.replace(/^(?:\w+(?:\([^)]*\))?!?:\s*)?(?:ref\s+)?ENG-\d+[\s:-]*/i, "").replace(/\s*\(#\d+\)$/, "").trim() || bare.trim()
  return title.length > 120 ? `${title.slice(0, 119)}…` : title
}

interface Mine {
  readonly login: string
  /** Keys with an Eva ledger. */
  readonly ledgers: ReadonlySet<string>
}

interface Found extends Ticket {
  readonly isaac: boolean
  /** Newest landing time of a commit carrying it. */
  readonly date: string
  /** 1 when the title is a subject or PR title naming the key, 0 when it came from a squash body line or a fallback. */
  readonly rank: number
}

/** The ENG tickets `commits` carry (bot release commits skipped), each marked Isaac's or not. */
const ticketsIn = (repo: string, commits: ReadonlyArray<GhCommit>, mine: Mine) =>
  Effect.gen(function*() {
    const github = yield* Promotions
    const found = new Map<string, Found>()
    for (const commit of commits) {
      if (commit.bot) continue
      const [subject = "", ...body] = commit.message.split("\n")
      const merged = /^Merge pull request #(\d+)/.exec(subject)
      const pr = merged === null ? undefined : yield* github.pull(repo, Number(merged[1]))
      const isaacs = commit.author === mine.login || pr?.author === mine.login
      // Where a key's title comes from: the PR title or subject first, then a squash body line naming it.
      const lines = pr === undefined ? [subject, ...body] : [pr.title, ...body]
      for (const key of keysOf(pr === undefined ? commit.message : `${commit.message}\n${pr.title}\n${pr.branch}`)) {
        const index = lines.findIndex((line) => keysOf(line).includes(key))
        const rank = index === 0 ? 1 : 0
        const title = titleOf(lines[index] ?? lines[0] ?? subject)
        const known = found.get(key)
        const newer = known === undefined || commit.date >= known.date
        const retitle = known === undefined || rank > known.rank || (rank === known.rank && newer)
        found.set(key, {
          key,
          title: retitle ? title : known.title,
          rank: retitle ? rank : known.rank,
          url: `https://linear.app/ecard-systems/issue/${key}`,
          sha: newer ? commit.sha : known.sha,
          isaac: isaacs || mine.ledgers.has(key) || (known?.isaac ?? false),
          date: newer ? commit.date : known.date
        })
      }
    }
    return [...found.values()]
  })

const ticket = ({ key, title, url, sha }: Found): Ticket => ({ key, title, url, sha })

/**
 * One promotion of `repo`'s main from `from` to `to`: Isaac's tickets newly reachable from `to`, and his tickets on
 * develop (landed by `at`) that main does not carry yet. A develop ticket counts as on main when a main commit with its
 * key landed at or after the develop commit (Noah re-commits develop work onto main, so ancestry alone misses those).
 */
export const promote = (repo: string, from: string, to: string, at: string, staging: Promotion["staging"], mine: Mine) =>
  Effect.gen(function*() {
    const github = yield* Promotions
    const reached = yield* ticketsIn(repo, yield* github.between(repo, from, to), mine)
    // A repo that merges PRs straight into main has nothing waiting on develop.
    const ahead = (yield* github.hasBranch(repo, "develop"))
      ? (yield* github.between(repo, to, "develop")).filter((commit) => commit.date <= at)
      : []
    const onDevelop = yield* ticketsIn(repo, ahead, mine)
    const mainLog = (yield* github.history(repo, to)).filter((commit) => !commit.bot)
    const pending = onDevelop.filter((found) =>
      found.isaac && !mainLog.some((commit) => commit.date >= found.date && keysOf(commit.message).includes(found.key)))
    return {
      repo,
      fromSha: from,
      toSha: to,
      compare: `https://github.com/${ORG}/${repo}/compare/${from.slice(0, 12)}...${to.slice(0, 12)}`,
      staging,
      tickets: reached.filter((found) => found.isaac).map(ticket),
      pendingOnDevelop: pending.map(ticket),
      otherTickets: reached.filter((found) => !found.isaac).map((found) => found.key)
    } satisfies Promotion
  })

/** A staging read as a promotion reports it: still deploying or not deployed counts as `not-deployed`. */
const reported = (staging: Staging): Promotion["staging"] =>
  staging === "deployed" || staging === "failed" || staging === "none" ? staging : "not-deployed"

const replay = job(events, {
  id: "replay",
  description:
    "What one promotion of an eCard repo's main carried for Isaac: the commits reachable from `toSha` and not from `fromSha` (default: its first parent), merges included, mapped to his ENG tickets, plus his tickets still only on develop as of `toSha`'s commit time. Emits `promotion.replayed`. Read-only.",
  input: Schema.Struct({ repo: Schema.String, toSha: Schema.String, fromSha: Schema.optionalKey(Schema.String) }),
  triggers: [Trigger.Manual()],
  run: Effect.fnUntraced(function*(input, ctx) {
    const github = yield* Promotions
    const to = yield* github.commit(input.repo, input.toSha)
    const from = input.fromSha === undefined ? to.parents[0] : (yield* github.commit(input.repo, input.fromSha)).sha
    if (from === undefined) return yield* new MainWatchError({ message: `${input.toSha} has no parent; give fromSha` })
    const mine = { login: yield* github.login, ledgers: (yield* (yield* Ledgers).read).keys }
    const staging = reported(yield* github.staging(input.repo, to.sha))
    yield* ctx.emit("promotion.replayed", yield* promote(input.repo, from, to.sha, to.date, staging, mine))
  })
})

const watch = job(events, {
  id: "watch",
  description:
    "Poll main of each eCard repo Isaac works in (conditional reads); for each promotion that reached staging (or an hour after the push), emit `main.promoted` with his tickets newly on main and his tickets still only on develop. Read-only.",
  input: Schema.Struct({}),
  triggers: [Trigger.Manual(), Trigger.Cron({ cron: "*/5 * * * *", input: Effect.succeed({}) })],
  run: Effect.fnUntraced(function*(_, ctx) {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const github = yield* Promotions
    const file = path.join(ctx.stateDir, "main.json")
    const stateError = (error: { readonly message: string }) => new MainWatchError({ message: `${file}: ${error.message}` })
    const save = (state: State) =>
      fs.writeFileString(`${file}.tmp`, `${JSON.stringify(state, null, 2)}\n`).pipe(Effect.andThen(fs.rename(`${file}.tmp`, file)), Effect.mapError(stateError))
    const prior: State = (yield* fs.exists(file).pipe(Effect.mapError(stateError)))
      ? yield* fs.readFileString(file).pipe(Effect.flatMap(decodeState), Effect.mapError(stateError))
      : { heads: {} }
    const now = yield* Clock.currentTimeMillis
    const nowIso = new Date(now).toISOString()
    const login = prior.login ?? (yield* github.login)
    const ledger = yield* (yield* Ledgers).read

    let repos = prior.repos
    let reposAt = prior.reposAt
    if (repos === undefined || reposAt === undefined || now - Date.parse(reposAt) > DAY_MS) {
      const since = new Date(now - ACTIVE_DAYS * DAY_MS).toISOString().slice(0, 10)
      const candidates = [...new Set([...(yield* github.activeRepos(login, since)), ...ledger.repos])].sort()
      const derived: Array<string> = []
      // Only repos that promote develop to main; the rest merge PRs straight into main.
      for (const repo of candidates) if (yield* github.hasBranch(repo, "develop")) derived.push(repo)
      repos = derived
      reposAt = nowIso
      yield* ctx.emit("repos.derived", { repos, candidates })
    }
    const heads: Record<string, RepoState> = {}
    const state = (): State => ({ login, repos: repos ?? [], reposAt: reposAt ?? nowIso, heads })
    const mine = { login, ledgers: ledger.keys }

    const failures: Array<string> = []
    for (const repo of repos) {
      const prev = prior.heads[repo]
      const step = Effect.gen(function*() {
        const read = yield* github.head(repo, "main", prev?.etag)
        if (read === "not-modified" && prev === undefined) return
        const etag = read === "not-modified" ? prev?.etag : read.etag
        const withEtag = (next: RepoState): RepoState => (etag === undefined ? next : { ...next, etag })
        const head = read === "not-modified" ? (prev?.waiting?.sha ?? prev?.sha) : read.sha
        // First sight of a repo: record its head, report nothing.
        if (prev === undefined || head === undefined) {
          if (head !== undefined) heads[repo] = withEtag({ sha: head })
          return
        }
        if (head === prev.sha) {
          heads[repo] = withEtag({ sha: prev.sha })
          return
        }
        const deploy = yield* github.staging(repo, head)
        const since = prev.waiting?.since ?? nowIso
        if ((deploy === "deploying" || deploy === "missing") && now - Date.parse(since) < STAGE_WAIT_MS) {
          heads[repo] = withEtag({ sha: prev.sha, waiting: { sha: head, since } })
          return
        }
        const promoted = yield* promote(repo, prev.sha, head, nowIso, reported(deploy), mine)
        if (promoted.tickets.length > 0 || promoted.pendingOnDevelop.length > 0) yield* ctx.emit("main.promoted", promoted)
        heads[repo] = withEtag({ sha: head })
      })
      yield* step.pipe(Effect.catchTag("PromotionsError", (error) =>
        Effect.sync(() => {
          failures.push(`${repo}: ${error.message}`)
          if (prev !== undefined) heads[repo] = prev
        })))
      // Saved per repo, so a later failure never re-reports one already emitted.
      yield* save(state())
    }
    if (repos.length === 0) yield* save(state())
    if (failures.length > 0) return yield* new MainWatchError({ message: failures.join("; ") })
  })
})

export const spec = {
  id: "ecard-main-watch",
  events,
  purpose:
    "Tell Eva when develop is promoted to main (staging) in the eCard repos Isaac works in: which of his ENG tickets reached main and which are still only on develop, found by ancestry (merges included). Read-only.",
  agent: {
    // No model calls: the watch is a fixed read. Kept for the Component shape.
    model: "anthropic/claude-haiku-5-5",
    candidates: ["anthropic/claude-haiku-5-5"],
    system: ""
  },
  // `replay` first: `request` runs an agent's first manual job.
  jobs: [replay, watch],
  tools: Layer.mergeAll(Promotions.layer, Ledgers.layer)
} satisfies Component<Promotions | Ledgers>

export default define(spec)
