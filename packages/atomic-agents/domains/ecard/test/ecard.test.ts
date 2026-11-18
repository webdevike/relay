import { describe, expect, test } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import { Effect, FileSystem, Layer, Ref, Schema } from "effect"
import { ecardPack } from "../adapters/pack.ts"
import { type Email, Outlook } from "../adapters/outlook.ts"
import { type GhCommit, Ledgers, Promotions, type Staging } from "../adapters/promotions.ts"
import { GitHub, Linear } from "../adapters/services.ts"
import { type Activity, flaggedItems, Flags, type Read, type Reader, Slack, SlackError } from "../adapters/slack.ts"
import { omp } from "../../../src/core/adapters/omp.ts"
import { scorers, voiceBreaks } from "../bench/ecard-score.ts"
import { spec as mainWatchSpec, keysOf, titleOf } from "../ecard-main-watch.ts"
import { spec as outlookFetchSpec } from "../ecard-outlook-fetch.ts"
import { spec as slackFetchSpec } from "../ecard-slack-fetch.ts"
import { define } from "../../../src/core/Component.ts"
import { EventBus } from "../../../src/core/Event.ts"
import { type GenerateRequest, ModelRunner } from "../../../src/core/Model.ts"
import { Runner } from "../../../src/core/Runtime.ts"
import { builtinAgents, agent, runtime, tempHome } from "../../../test/harness.ts"

const slackMd = (urls: ReadonlyArray<string>) =>
  [
    "_updated 2026-11-14T00:00:00Z · cursor 2026-11-13T00:00:00Z_",
    "",
    "## Needs your attention",
    "",
    ...urls.map((url, index) => `- **DM** (Todd) · Todd · 2026-11-13T1${index}:00Z · Reply to Todd about item ${index} [permalink](${url})`),
    "- **#general** · a bullet without a link",
    "",
    "## Worth remembering",
    "",
    "- **#eng** · Ted · shipped [permalink](https://ecardplatform.slack.com/archives/C1/p1700000000000009)"
  ].join("\n")

const URL_A = "https://ecardplatform.slack.com/archives/D1/p1700000000000001"
const URL_B = "https://ecardplatform.slack.com/archives/C2/p1700000000000002?thread_ts=1700000000.000000&cid=C2"

/** A model that answers every call with `answer`, and records the requests. */
const answering = (requests: Ref.Ref<ReadonlyArray<GenerateRequest>>, answer: (request: GenerateRequest) => unknown) =>
  ModelRunner.of({
    generate: (request) =>
      Ref.update(requests, (all) => [...all, request]).pipe(
        Effect.as({ text: JSON.stringify(answer(request)), model: request.model, provider: "test", seconds: 0, cost: 0 })
      )
  })

/** Eva's checkout as the eCard agents read it: the knowledge files their agent files name. */
const evaRoot = (root: string) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const eva = `${root}/eva`
    yield* fs.makeDirectory(`${eva}/references`, { recursive: true })
    yield* fs.writeFileString(`${eva}/references/slack-voice.md`, "- **Short.** VOICE-RULES\n")
    return eva
  }).pipe(Effect.provide(BunServices.layer))

const ECARD = [
  "ecard-slack-triage",
  "ecard-slack-reply-drafter",
  "ecard-ticket-mover",
  "ecard-meeting-actions",
  "ecard-outlook-triage",
  "ecard-ticket-intake",
  "ecard-ci-triage"
]

describe("ecard agent files", () => {
  test("every ecard agent spec loads against the ecard pack", () =>
    Effect.gen(function*() {
      const root = yield* tempHome
      const dir = yield* builtinAgents(root, ECARD)
      const eva = yield* evaRoot(root)
      yield* Effect.gen(function*() {
        const loaded = yield* Effect.forEach(ECARD, agent)
        expect(loaded.map((found) => [found.id, found.kind])).toEqual(ECARD.map((id) => [id, "spec"]))
      }).pipe(Effect.provide(runtime(root, { dirs: [dir], env: { EVA_ROOT: eva } })))
    }).pipe(Effect.scoped, Effect.runPromise), 20_000)
})

describe("ecard-slack-fetch", () => {
  test("flaggedItems reads only Needs your attention bullets with a permalink", () => {
    expect(flaggedItems(slackMd([URL_A, URL_B]))).toEqual([
      { url: URL_A, summary: "**DM** (Todd) · Todd · 2026-11-13T10:00Z · Reply to Todd about item 0" },
      { url: URL_B, summary: "**DM** (Todd) · Todd · 2026-11-13T11:00Z · Reply to Todd about item 1" }
    ])
  })

  test("fetch hands each new flag to slack-triage once; triage emits its verdict with the text", () =>
    Effect.gen(function*() {
      const root = yield* tempHome
      const dir = yield* builtinAgents(root, ["ecard-slack-triage"])
      const surface = yield* Ref.make(slackMd([URL_A]))
      const asked = yield* Ref.make<ReadonlyArray<ReadonlyArray<string>>>([])
      const slack = Layer.succeed(Slack, Slack.make({
        "claude-proxy": (request) =>
          Ref.update(asked, (all) => [...all, request.urls]).pipe(Effect.as({
            authedUser: "Isaac Weber",
            items: [],
            threads: request.urls.map((url) => ({
              url,
              channel: "DM with Todd",
              ts: "1700000000.000001",
              messages: [{ author: "Todd Barczak", ts: "1700000000.000001", text: "@Isaac can you review this today?" }]
            }))
          })),
        "slack-desktop": () => Effect.fail(new SlackError({ message: "desktop unused" }))
      }))
      const flags = Layer.succeed(Flags, Flags.of({ read: Ref.get(surface) }))
      const requests = yield* Ref.make<ReadonlyArray<GenerateRequest>>([])
      const models = answering(requests, () => ({ answer: { verdict: "needs-isaac", isaacReplied: false, reason: "Todd asked for a review" } }))
      yield* Effect.gen(function*() {
        const runner = yield* Runner
        const bus = yield* EventBus
        expect((yield* runner.run("ecard-slack-fetch", "fetch", {})).ok).toBe(true)
        const fetched = (yield* bus.history).filter((event) => event.type === "ecard-slack-fetch/item.fetched")
        expect(fetched.map((event) => event.data)).toEqual([expect.objectContaining({ url: URL_A })])

        const verdict = yield* runner.run("ecard-slack-triage", "triage", fetched[0]!.data)
        expect(verdict.ok).toBe(true)
        const triaged = (yield* bus.history).find((event) => event.run === verdict.run && event.type === "ecard-slack-triage/item.triaged")
        expect(triaged?.data).toMatchObject({ url: URL_A, verdict: "needs-isaac", isaacReplied: false, summary: expect.stringContaining("Reply to Todd") })
        expect((yield* Ref.get(requests))[0]?.prompt).toContain("Todd Barczak (FLAGGED): @Isaac can you review this today?")

        // A second run asks the proxy only for the new flag.
        yield* Ref.set(surface, slackMd([URL_A, URL_B]))
        yield* runner.run("ecard-slack-fetch", "fetch", {})
        expect(yield* Ref.get(asked)).toEqual([[URL_A], [URL_B]])
      }).pipe(Effect.provide(runtime(root, { dirs: [dir], code: [define({ ...slackFetchSpec, tools: Layer.mergeAll(slack, flags) })] }, models)))
    }).pipe(Effect.scoped, Effect.runPromise), 20_000)

  const todd: Activity = {
    url: "https://ecardplatform.slack.com/archives/D1/p1700000100000001",
    channel: "DM with Todd Barczak",
    kind: "dm",
    author: "Todd Barczak",
    ts: "2023-11-14T22:15:00.000Z",
    text: "@Isaac Weber can you look at ENG-1?",
    mentionsIsaac: true,
    reactions: [{ emoji: "eyes", count: 1, byIsaac: true }]
  }
  const read: Read = { authedUser: "Isaac Weber", items: [todd], threads: [] }
  const failing = (message: string): Reader => () => Effect.fail(new SlackError({ message }))

  test("auto reads through the proxy; a failed proxy falls back to Slack desktop with the same shape", () =>
    Effect.gen(function*() {
      const calls = yield* Ref.make<ReadonlyArray<string>>([])
      const reader = (source: string): Reader => () => Ref.update(calls, (all) => [...all, source]).pipe(Effect.as(read))

      const proxied = yield* Slack.make({ "claude-proxy": reader("proxy"), "slack-desktop": reader("desktop") }).read({ since: "2023-11-14T22:00:00Z", urls: [] })
      expect(proxied).toEqual({ ...read, source: "claude-proxy" })
      expect(yield* Ref.get(calls)).toEqual(["proxy"])

      const fellBack = yield* Slack.make({ "claude-proxy": failing("claude proxy timed out after 8 minutes"), "slack-desktop": reader("desktop") }).read({ since: "2023-11-14T22:00:00Z", urls: [] })
      expect(fellBack).toEqual({ ...read, source: "slack-desktop", fallbackReason: "claude proxy timed out after 8 minutes" })

      const forced = yield* Slack.make({ "claude-proxy": reader("proxy"), "slack-desktop": reader("desktop") }, "slack-desktop").read({ urls: [] })
      expect(forced.source).toBe("slack-desktop")
      expect(yield* Ref.get(calls)).toEqual(["proxy", "desktop", "desktop"])

      const neither = yield* Effect.flip(Slack.make({ "claude-proxy": failing("claude-proxy: no authed Slack user"), "slack-desktop": failing("slack desktop: no app.slack.com/client page") }).read({ urls: [] }))
      expect(neither.message).toBe("claude-proxy: no authed Slack user; then slack desktop: no app.slack.com/client page")

      // A source named on the call wins and never falls back.
      const only = yield* Effect.flip(Slack.make({ "claude-proxy": failing("proxy down"), "slack-desktop": reader("desktop") }).read({ urls: [] }, "claude-proxy"))
      expect(only.message).toBe("proxy down")
    }).pipe(Effect.runPromise))

  test("activity emits one read with its source and the cursor to save", () =>
    Effect.gen(function*() {
      const root = yield* tempHome
      const asked = yield* Ref.make<ReadonlyArray<string | undefined>>([])
      const slack = Layer.succeed(Slack, Slack.make({
        "claude-proxy": failing("claude proxy: Slack connector needs auth"),
        "slack-desktop": (request) => Ref.update(asked, (all) => [...all, request.since]).pipe(Effect.as(read))
      }))
      const flags = Layer.succeed(Flags, Flags.of({ read: Effect.succeed("") }))
      yield* Effect.gen(function*() {
        const runner = yield* Runner
        const bus = yield* EventBus
        expect((yield* runner.run("ecard-slack-fetch", "activity", { since: "2023-11-14T22:00:00.000Z" })).ok).toBe(true)
        const fetched = (yield* bus.history).find((event) => event.type === "ecard-slack-fetch/activity.fetched")
        expect(fetched?.data).toEqual({
          ...read,
          source: "slack-desktop",
          fallbackReason: "claude proxy: Slack connector needs auth",
          since: "2023-11-14T22:00:00.000Z",
          cursor: todd.ts
        })
        expect(yield* Ref.get(asked)).toEqual(["2023-11-14T22:00:00.000Z"])
      }).pipe(Effect.provide(runtime(root, { dirs: [], code: [define({ ...slackFetchSpec, tools: Layer.mergeAll(slack, flags) })] })))
    }).pipe(Effect.scoped, Effect.runPromise), 20_000)
})

describe("ecard-outlook-fetch", () => {
  const email = (id: string, received: string): Email => ({
    id,
    from: "Todd Barczak <tbarczak@ecardsystems.com>",
    to: ["Isaac Weber <iweber@ecardsystems.com>"],
    subject: `Question ${id}`,
    received,
    body: "Can you look at this today?",
    thread: []
  })
  // Within the first run's 24 h window.
  const [T0, T1] = [2, 1].map((hours) => new Date(Date.now() - hours * 3_600_000).toISOString())

  test("fetch hands each new email to outlook-triage once; the cursor skips the ones already seen", () =>
    Effect.gen(function*() {
      const root = yield* tempHome
      const dir = yield* builtinAgents(root, ["ecard-outlook-triage"])
      const inbox = yield* Ref.make([email("a", T0!)])
      const asked = yield* Ref.make<ReadonlyArray<string>>([])
      const outlook = Layer.succeed(Outlook, Outlook.of({
        inbox: (since) => Ref.update(asked, (all) => [...all, since]).pipe(Effect.andThen(Ref.get(inbox)))
      }))
      const requests = yield* Ref.make<ReadonlyArray<GenerateRequest>>([])
      const models = answering(requests, () => ({ answer: { verdict: "needs-isaac", reason: "Todd asks for a look today" } }))
      yield* Effect.gen(function*() {
        const runner = yield* Runner
        const bus = yield* EventBus
        expect((yield* runner.run("ecard-outlook-fetch", "fetch", {})).ok).toBe(true)
        const fetched = (yield* bus.history).filter((event) => event.type === "ecard-outlook-fetch/email.fetched")
        expect(fetched.map((event) => (event.data as Email).id)).toEqual(["a"])

        const verdict = yield* runner.run("ecard-outlook-triage", "triage", fetched[0]!.data)
        expect(verdict.ok).toBe(true)
        const triaged = (yield* bus.history).find((event) => event.run === verdict.run && event.type === "ecard-outlook-triage/email.triaged")
        expect(triaged?.data).toMatchObject({ id: "a", subject: "Question a", verdict: "needs-isaac" })
        expect((yield* Ref.get(requests))[0]?.prompt).toContain("Can you look at this today?")

        // The proxy returns the window again plus a new email: only the new one goes out, and it asks from the cursor.
        yield* Ref.set(inbox, [email("a", T0!), email("b", T1!)])
        yield* runner.run("ecard-outlook-fetch", "fetch", {})
        const all = (yield* bus.history).filter((event) => event.type === "ecard-outlook-fetch/email.fetched")
        expect(all.map((event) => (event.data as Email).id)).toEqual(["a", "b"])
        expect((yield* Ref.get(asked))[1]).toBe(T0)
      }).pipe(Effect.provide(runtime(root, { dirs: [dir], code: [define({ ...outlookFetchSpec, tools: outlook })] }, models)))
    }).pipe(Effect.scoped, Effect.runPromise), 20_000)
})

describe("ecard-main-watch", () => {
  test("keysOf and titleOf read commit subjects, PR titles and branch names", () => {
    expect(keysOf("Merge pull request #9 from eCardSystems/feature/eng-7489-egift\n\nref ENG-7489 and ENG-12")).toEqual(["ENG-7489", "ENG-12"])
    expect(titleOf("fix: ref ENG-6832 Platform Assets filter and panel fixes from dev QA (#254)")).toBe("Platform Assets filter and panel fixes from dev QA")
    expect(titleOf("ref ENG-7119 Entitlements: ECS Support can load partners")).toBe("Entitlements: ECS Support can load partners")
    expect(titleOf("* fix: ref ENG-5974 Filter selects say Nothing found and clear by keyboard")).toBe("Filter selects say Nothing found and clear by keyboard")
  })

  test("watch reports Isaac's tickets by ancestry: a re-commit pushed to main, a merged PR, and what is still only on develop", () =>
    Effect.gen(function*() {
      const root = yield* tempHome
      const eva = yield* evaRoot(root)
      const fs = yield* FileSystem.FileSystem
      yield* fs.makeDirectory(`${eva}/work/items`, { recursive: true })
      // ENG-1 is Isaac's only through his ledger: Noah re-commits it onto main under his own name.
      yield* fs.writeFileString(`${eva}/work/items/ENG-1.md`, "---\nkey: ENG-1\nrepo: eCardSystems/ledger-repo\n---\n")

      const graph = new Map<string, GhCommit>()
      const add = (sha: string, message: string, author: string, date: string, parents: ReadonlyArray<string> = [], bot = false) =>
        graph.set(sha, { sha, message, author, bot, date, parents })
      add("m0", "ref ENG-90 old main", "noah", "2026-11-01T10:00:00Z")
      add("d1", "fix: ref ENG-1 Fix the cart (#1)", "isaac", "2026-11-02T10:00:00Z", ["m0"])
      add("d2", "ref ENG-2 Noah's develop work", "noah", "2026-11-02T11:00:00Z", ["d1"])
      add("d3", "fix: ref ENG-3 Center the empty state (#3)", "isaac", "2026-11-02T12:00:00Z", ["d2"])
      // Promotion 1: Noah pushes re-commits straight onto main, then a release bot commit.
      add("m1a", "ref ENG-1 Fix the cart", "noah", "2026-11-03T10:00:00Z", ["m0"])
      add("m1b", "ref ENG-5 Someone else's ticket", "noah", "2026-11-03T10:01:00Z", ["m1a"])
      add("m1", "chore: release v1.2.0\n\n* ENG-99 changelog", "github-actions[bot]", "2026-11-03T10:02:00Z", ["m1b"], true)
      // Promotion 2: a PR from Isaac's feature branch merged into main.
      add("f1", "ref ENG-4 Rendition constants", "isaac", "2026-11-04T09:00:00Z", ["m1"])
      add("m2", "Merge pull request #9 from eCardSystems/feature/eng-4-renditions", "noah", "2026-11-04T10:00:00Z", ["m1", "f1"])

      const refs = yield* Ref.make<Record<string, string>>({ main: "m0", develop: "d3" })
      const staging = yield* Ref.make<Staging>("deployed")
      const etags = yield* Ref.make<ReadonlyArray<string | undefined>>([])
      const resolve = (name: string) => Ref.get(refs).pipe(Effect.map((all) => all[name] ?? name))
      const ancestors = (sha: string) => {
        const seen = new Set<string>()
        const stack = [sha]
        while (stack.length > 0) {
          const next = stack.pop()!
          if (seen.has(next)) continue
          seen.add(next)
          stack.push(...graph.get(next)!.parents)
        }
        return seen
      }
      const promotions = Layer.succeed(Promotions, Promotions.of({
        login: Effect.succeed("isaac"),
        head: (_, branch, etag) =>
          Ref.update(etags, (all) => [...all, etag]).pipe(Effect.andThen(resolve(branch)), Effect.map((sha) => (etag === `"${sha}"` ? "not-modified" as const : { sha, etag: `"${sha}"` }))),
        commit: (_, ref) => resolve(ref).pipe(Effect.map((sha) => graph.get(sha)!)),
        between: (_, base, head) =>
          Effect.all([resolve(base), resolve(head)]).pipe(Effect.map(([from, to]) => {
            const old = ancestors(from)
            return [...ancestors(to)].filter((sha) => !old.has(sha)).map((sha) => graph.get(sha)!).sort((a, b) => a.date.localeCompare(b.date))
          })),
        history: (_, ref) => resolve(ref).pipe(Effect.map((sha) => [...ancestors(sha)].map((each) => graph.get(each)!).sort((a, b) => b.date.localeCompare(a.date)))),
        pull: (_, number) => Effect.succeed({ title: `ENG-4 Rendition constants (#${number})`, author: "isaac", branch: "feature/eng-4-renditions" }),
        staging: () => Ref.get(staging),
        hasBranch: (repo) => Effect.succeed(repo !== "no-develop"),
        activeRepos: () => Effect.succeed(["repo", "no-develop"])
      }))

      yield* Effect.gen(function*() {
        const runner = yield* Runner
        const bus = yield* EventBus
        const decode = Schema.decodeUnknownSync(mainWatchSpec.events["main.promoted"])
        // Both derived repos see the same fake graph; the assertions read `repo`.
        const promoted = () =>
          bus.history.pipe(Effect.map((all) => all.filter((event) => event.type === "ecard-main-watch/main.promoted").map((event) => decode(event.data))))

        // First run: derives the repos and records main silently.
        expect((yield* runner.run("ecard-main-watch", "watch", {})).ok).toBe(true)
        const derived = (yield* bus.history).find((event) => event.type === "ecard-main-watch/repos.derived")
        expect(derived?.data).toEqual({ repos: ["ledger-repo", "repo"], candidates: ["ledger-repo", "no-develop", "repo"] })
        expect(yield* promoted()).toEqual([])

        // Promotion 1 still deploying: held, nothing yet.
        yield* Ref.update(refs, (all) => ({ ...all, main: "m1" }))
        yield* Ref.set(staging, "deploying")
        yield* runner.run("ecard-main-watch", "watch", {})
        expect(yield* promoted()).toEqual([])

        // Deployed: one event with ENG-1 (ledger), ENG-3 still on develop (d1 counts as on main via m1a), others ENG-5.
        yield* Ref.set(staging, "deployed")
        yield* runner.run("ecard-main-watch", "watch", {})
        const first = (yield* promoted()).filter((data) => data.repo === "repo")
        expect(first).toEqual([{
          repo: "repo",
          fromSha: "m0",
          toSha: "m1",
          compare: "https://github.com/eCardSystems/repo/compare/m0...m1",
          staging: "deployed",
          tickets: [{ key: "ENG-1", title: "Fix the cart", url: "https://linear.app/ecard-systems/issue/ENG-1", sha: "m1a" }],
          pendingOnDevelop: [{ key: "ENG-3", title: "Center the empty state", url: "https://linear.app/ecard-systems/issue/ENG-3", sha: "d3" }],
          otherTickets: ["ENG-5"]
        }])

        // Unchanged head: the read is conditional and nothing is re-reported.
        yield* runner.run("ecard-main-watch", "watch", {})
        expect((yield* Ref.get(etags)).at(-1)).toBe(`"m1"`)
        expect((yield* promoted()).length).toBe(2)

        // Promotion 2 is a merge commit: Isaac's feature commit is reached through its second parent.
        yield* Ref.update(refs, (all) => ({ ...all, main: "m2" }))
        yield* runner.run("ecard-main-watch", "watch", {})
        const second = (yield* promoted()).filter((data) => data.repo === "repo" && data.toSha === "m2")
        expect(second).toEqual([expect.objectContaining({
          fromSha: "m1",
          tickets: [{ key: "ENG-4", title: "Rendition constants", url: "https://linear.app/ecard-systems/issue/ENG-4", sha: "m2" }],
          pendingOnDevelop: [expect.objectContaining({ key: "ENG-3" })],
          otherTickets: []
        })])
      }).pipe(Effect.provide(runtime(root, { code: [define({ ...mainWatchSpec, tools: Layer.mergeAll(promotions, Ledgers.layer) })], env: { EVA_ROOT: eva } })))
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.runPromise), 20_000)
})

describe("ecard-slack-reply-drafter", () => {
  const triaged = (verdict: "needs-isaac" | "skip") => ({
    url: URL_A,
    channel: "DM with Todd",
    ts: "1700000000.000001",
    summary: "Todd asks for a review",
    messages: [{ author: "Todd Barczak", ts: "1700000000.000001", text: "@Isaac can you review this today?" }],
    verdict,
    isaacReplied: false,
    reason: "Todd asked for a review"
  })

  test("drafts only for needs-isaac items, with the voice file in the system prompt", () =>
    Effect.gen(function*() {
      const root = yield* tempHome
      const dir = yield* builtinAgents(root, ["ecard-slack-reply-drafter"])
      const eva = yield* evaRoot(root)
      const requests = yield* Ref.make<ReadonlyArray<GenerateRequest>>([])
      const models = answering(requests, () => ({ answer: { intent: "ack", draft: "Looking :eyes:", reason: "needs a look first" } }))
      yield* Effect.gen(function*() {
        const runner = yield* Runner
        const bus = yield* EventBus
        const skipped = yield* runner.run("ecard-slack-reply-drafter", "draft", triaged("skip"))
        expect(skipped.ok).toBe(true)
        expect(yield* Ref.get(requests)).toEqual([])
        expect((yield* bus.history).some((event) => event.run === skipped.run && event.type === "ecard-slack-reply-drafter/reply.drafted")).toBe(false)
        const drafted = yield* runner.run("ecard-slack-reply-drafter", "draft", triaged("needs-isaac"))
        expect(drafted.ok).toBe(true)
        const event = (yield* bus.history).find((candidate) => candidate.run === drafted.run && candidate.type === "ecard-slack-reply-drafter/reply.drafted")
        expect(event?.data).toMatchObject({ url: URL_A, intent: "ack", draft: "Looking :eyes:" })
        expect((yield* Ref.get(requests))[0]?.system).toContain("VOICE-RULES")
      }).pipe(Effect.provide(runtime(root, { dirs: [dir], env: { EVA_ROOT: eva } }, models)))
    }).pipe(Effect.scoped, Effect.runPromise), 20_000)
})

describe("ecard tools read the item", () => {
  test("ticket-mover's tools get the landing time and repo from the item, not the model", () =>
    Effect.gen(function*() {
      const root = yield* tempHome
      const dir = yield* builtinAgents(root, ["ecard-ticket-mover"])
      const seen = yield* Ref.make<ReadonlyArray<string>>([])
      const record = (line: string) => Ref.update(seen, (all) => [...all, line])
      const linear = Layer.succeed(Linear, Linear.of({
        issue: (key, asOf) =>
          Effect.as(record(`issue ${key} ${asOf}`), { key, title: "Fix cart", url: "", state: "In Progress", assignee: "Isaac Weber", parent: null, description: "", comments: [] }),
        search: () => Effect.succeed([]),
        isaacOpen: () => Effect.succeed([])
      }))
      const github = Layer.succeed(GitHub, GitHub.of({
        commit: (repo, sha) => Effect.as(record(`commit ${repo} ${sha}`), { sha, message: "fix cart", author: "Isaac", date: "", files: [] }),
        searchPrs: () => Effect.succeed([]),
        workflowRuns: () => Effect.succeed({ workflow: "", branch: "", runs: [] }),
        failedLog: () => Effect.succeed("")
      }))
      const requests = yield* Ref.make<ReadonlyArray<GenerateRequest>>([])
      const models = answering(requests, (request) =>
        !request.prompt.includes("Fix cart")
          ? { tool: "linear_issue", args: { key: "ENG-1" } }
          : !request.prompt.includes("fix cart")
          ? { tool: "git_log", args: { sha: "b94249d0abc" } }
          : { answer: { state: "In QA", assignee: "Steve Arms", comment: "b94249d0 on develop", reason: "done" } })
      yield* Effect.gen(function*() {
        const runner = yield* Runner
        const bus = yield* EventBus
        const result = yield* runner.run("ecard-ticket-mover", "propose", {
          repo: "eCardSystems/node-storefront-service",
          shas: ["b94249d0abc"],
          ticket: "ENG-1",
          branch: "develop",
          at: "2026-11-10T12:00:00Z"
        })
        expect(result.ok).toBe(true)
        expect(yield* Ref.get(seen)).toEqual(["issue ENG-1 2026-11-10T12:00:00Z", "commit eCardSystems/node-storefront-service b94249d0abc"])
        const proposed = (yield* bus.history).find((event) => event.run === result.run && event.type === "ecard-ticket-mover/move.proposed")
        expect(proposed?.data).toMatchObject({ ticket: "ENG-1", state: "In QA", assignee: "Steve Arms", shas: ["b94249d0abc"] })
      }).pipe(Effect.provide(runtime(root, { dirs: [dir], packs: [omp, ecardPack(Layer.mergeAll(linear, github))] }, models)))
    }).pipe(Effect.scoped, Effect.runPromise), 20_000)
})

describe("bench scores", () => {
  const score = (id: string, expected: unknown, answer: unknown, input: Readonly<Record<string, unknown>> = {}) => scorers[id]!.score(expected, answer, input)
  const request = { repo: "eCardSystems/x", shas: ["b94249d0abc"], ticket: "ENG-1", branch: "develop" }

  test("ticket-mover: In QA needs Steve and a SHA in the comment; none needs none", () => {
    expect(score("ecard-ticket-mover", { state: "In QA", assignee: "Steve Arms" }, { state: "In QA", assignee: "Steve Arms", comment: "Merged b94249d0 to develop" }, request).right).toBe(true)
    expect(score("ecard-ticket-mover", { state: "In QA", assignee: "Steve Arms" }, { state: "In QA", assignee: "Steve Arms", comment: "Merged" }, request).right).toBe(false)
    expect(score("ecard-ticket-mover", { state: "none" }, { state: "In QA", assignee: "Steve Arms", comment: "b94249d0" }, request).right).toBe(false)
  })

  test("meeting-actions: expected tickets and new items hit, an invented key is not right", () => {
    const expected = [{ ticket: "ENG-7308" }, { ticket: null }, { ticket: null, chore: true }]
    const item = (ticket: string | null, newSubIssue: boolean) => ({ ticket, newSubIssue })
    expect(score("ecard-meeting-actions", expected, { items: [item("ENG-7308", false), item(null, true), item(null, false)] })).toMatchObject({ right: true, hits: 2, total: 2 })
    expect(score("ecard-meeting-actions", expected, { items: [item("ENG-7308", false), item("ENG-9999", false)] })).toMatchObject({ right: false, hits: 1, total: 2 })
  })

  test("slack-reply-drafter: an accepted intent with no voice break is right", () => {
    expect(voiceBreaks("Will do — thanks", "Will do!")).toContain("em dash")
    expect(voiceBreaks("Hi Todd, see https://x.dev", "Sure")).toEqual(expect.arrayContaining(["greeting", "raw url"]))
    expect(voiceBreaks("Looking :eyes: <https://x.dev|here>", "Looking")).toEqual([])
    const expected = { intents: ["ack", "answer"], reply: "Good to go from me." }
    expect(score("ecard-slack-reply-drafter", expected, { intent: "ack", draft: "Good to go from me" }).right).toBe(true)
    expect(score("ecard-slack-reply-drafter", expected, { intent: "question", draft: "Which release?" }).right).toBe(false)
  })

  test("ticket-intake: the route decides, the size is a partial hit", () => {
    expect(score("ecard-ticket-intake", { route: "auto-work", size: "M" }, { route: "auto-work", size: "L" })).toMatchObject({ right: true, hits: 0, total: 1 })
    expect(score("ecard-ticket-intake", { route: "needs-isaac", size: "M" }, { route: "auto-work", size: "M" })).toMatchObject({ right: false, hits: 1 })
  })
})
