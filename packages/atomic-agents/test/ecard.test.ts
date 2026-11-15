import { describe, expect, test } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import { Effect, FileSystem, Layer, Ref } from "effect"
import { ecardPack } from "../src/adapters/ecard/pack.ts"
import { type Email, Outlook } from "../src/adapters/ecard/outlook.ts"
import { GitHub, Linear, Meetings } from "../src/adapters/ecard/services.ts"
import { flaggedItems, Flags, Slack } from "../src/adapters/ecard/slack.ts"
import { omp } from "../src/adapters/omp.ts"
import { scorers, voiceBreaks } from "../src/bench/ecard-score.ts"
import { spec as outlookFetchSpec } from "../src/chefs/ecard-outlook-fetch.ts"
import { spec as slackFetchSpec } from "../src/chefs/ecard-slack-fetch.ts"
import { define } from "../src/Component.ts"
import { EventBus } from "../src/Event.ts"
import { type GenerateRequest, ModelRunner } from "../src/Model.ts"
import { Runner } from "../src/Runtime.ts"
import { builtinChefs, chef, runtime, tempHome } from "./harness.ts"

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

/** Eva's checkout as the eCard chefs read it: the knowledge files their chef files name. */
const evaRoot = (root: string) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const eva = `${root}/eva`
    yield* fs.makeDirectory(`${eva}/references/ecard-platform-repos`, { recursive: true })
    yield* fs.writeFileString(`${eva}/references/slack-voice.md`, "- **Short.** VOICE-RULES\n")
    for (const name of ["review-rules-contracts.md", "review-rules-data.md", "review-rules-ui-state.md", "review-rules-ui.md", "review-rules.md"]) {
      yield* fs.writeFileString(`${eva}/references/ecard-platform-repos/${name}`, `RULES ${name}\n`)
    }
    return eva
  }).pipe(Effect.provide(BunServices.layer))

const ECARD = [
  "ecard-slack-triage",
  "ecard-slack-reply-drafter",
  "ecard-review-drafter",
  "ecard-ticket-mover",
  "ecard-meeting-actions",
  "ecard-outlook-triage",
  "ecard-meeting-prep",
  "ecard-ticket-intake",
  "ecard-ci-triage"
]

describe("ecard chef files", () => {
  test("every ecard recipe loads against the ecard pack", () =>
    Effect.gen(function*() {
      const root = yield* tempHome
      const dir = yield* builtinChefs(root, ECARD)
      const eva = yield* evaRoot(root)
      yield* Effect.gen(function*() {
        const loaded = yield* Effect.forEach(ECARD, chef)
        expect(loaded.map((found) => [found.id, found.kind])).toEqual(ECARD.map((id) => [id, "recipe"]))
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
      const dir = yield* builtinChefs(root, ["ecard-slack-triage"])
      const surface = yield* Ref.make(slackMd([URL_A]))
      const asked = yield* Ref.make<ReadonlyArray<ReadonlyArray<string>>>([])
      const slack = Layer.succeed(Slack, Slack.of({
        threads: (urls) =>
          Ref.update(asked, (all) => [...all, urls]).pipe(Effect.as(urls.map((url) => ({
            url,
            channel: "DM with Todd",
            ts: "1700000000.000001",
            messages: [{ author: "Todd Barczak", ts: "1700000000.000001", text: "@Isaac can you review this today?" }]
          }))))
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
      const dir = yield* builtinChefs(root, ["ecard-outlook-triage"])
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
      const dir = yield* builtinChefs(root, ["ecard-slack-reply-drafter"])
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
      const dir = yield* builtinChefs(root, ["ecard-ticket-mover"])
      const seen = yield* Ref.make<ReadonlyArray<string>>([])
      const record = (line: string) => Ref.update(seen, (all) => [...all, line])
      const linear = Layer.succeed(Linear, Linear.of({
        issue: (key, asOf) =>
          Effect.as(record(`issue ${key} ${asOf}`), { key, title: "Fix cart", url: "", state: "In Progress", assignee: "Isaac Weber", parent: null, description: "", comments: [] }),
        search: () => Effect.succeed([]),
        isaacOpen: () => Effect.succeed([]),
        isaacRecent: () => Effect.succeed([])
      }))
      const github = Layer.succeed(GitHub, GitHub.of({
        commit: (repo, sha) => Effect.as(record(`commit ${repo} ${sha}`), { sha, message: "fix cart", author: "Isaac", date: "", files: [] }),
        file: () => Effect.succeed(""),
        thread: () => Effect.succeed([]),
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
      }).pipe(Effect.provide(runtime(root, { dirs: [dir], packs: [omp, ecardPack(Layer.mergeAll(linear, github, Meetings.layer))] }, models)))
    }).pipe(Effect.scoped, Effect.runPromise), 20_000)

  test("meeting-prep's meeting_notes reads the eCard meetings since the series last met, that one first, never the meeting itself", () =>
    Effect.gen(function*() {
      const root = yield* tempHome
      const dir = yield* builtinChefs(root, ["ecard-meeting-prep"])
      const eva = yield* evaRoot(root)
      const fs = yield* FileSystem.FileSystem
      const meetings = `${eva}/work/meetings`
      yield* fs.makeDirectory(meetings, { recursive: true })
      const ledger = (stem: string, start: string, extra: Readonly<Record<string, unknown>>) =>
        fs.writeFileString(`${meetings}/${stem}.json`, JSON.stringify({ stem, title: `Generated ${stem}`, start, workspace: "ecardsystems", ...extra }))
      yield* fs.writeFileString(
        `${eva}/series.md`,
        "# Meeting Protocol\n**Attendees:** Isaac (Outlook: \"UI/UX Standup\")\n\n## Summary\nCard lookup flag talk.\n\n## Tasks\n| Task | Responsible | Deadline | Priority |\n|---|---|---|---|\n| Put card lookup behind ENG-7229 | Isaac | open | high |\n\n## Open Questions\n- Who owns Unleash access?\n\n## Full Transcript\nENG-1111 said in passing\n"
      )
      yield* ledger("20261110_1400_calendar_a", "2026-11-10T19:00:00.000Z", { notes: `${eva}/series.md` })
      yield* ledger("20261111_1129_scrum_b", "2026-11-11T16:29:00.000Z", { proposals: [{ text: "Storefront review", item: "ENG-6827" }] })
      yield* ledger("20261112_1400_uiux_standup_c", "2026-11-12T19:05:00.000Z", { proposals: [{ text: "This meeting", item: "ENG-9999" }] })
      yield* ledger("20261112_1300_personal_d", "2026-11-12T17:00:00.000Z", { workspace: "personal", proposals: [{ text: "Not eCard", item: "ENG-8888" }] })
      yield* ledger("20261108_1000_sync_e", "2026-11-08T15:00:00.000Z", { proposals: [{ text: "Before the group last met", item: "ENG-7777" }] })
      const linear = Layer.succeed(Linear, Linear.of({
        issue: () => Effect.die("unused"),
        search: () => Effect.succeed([]),
        isaacOpen: () => Effect.succeed([]),
        isaacRecent: () => Effect.succeed([])
      }))
      const github = Layer.succeed(GitHub, GitHub.of({
        commit: () => Effect.die("unused"),
        file: () => Effect.succeed(""),
        thread: () => Effect.succeed([]),
        searchPrs: () => Effect.succeed([]),
        workflowRuns: () => Effect.succeed({ workflow: "", branch: "", runs: [] }),
        failedLog: () => Effect.succeed("")
      }))
      const requests = yield* Ref.make<ReadonlyArray<GenerateRequest>>([])
      const models = answering(requests, (request) =>
        request.prompt.includes("sameSeries") ? { answer: { tickets: [], prs: [], questions: [] } } : { tool: "meeting_notes", args: {} })
      yield* Effect.gen(function*() {
        const result = yield* (yield* Runner).run("ecard-meeting-prep", "prep", {
          title: "UI/UX Standup",
          start: "2026-11-12T13:00:00-06:00",
          attendees: ["Isaac Weber"],
          body: ""
        })
        expect(result.ok).toBe(true)
        const notes = (yield* Ref.get(requests)).at(-1)!.prompt
        expect(notes).toContain("Put card lookup behind ENG-7229 — Isaac")
        expect(notes).toContain("Who owns Unleash access?")
        expect(notes).toContain("ENG-6827")
        expect(notes.indexOf("ENG-7229")).toBeLessThan(notes.indexOf("ENG-6827"))
        for (const hidden of ["ENG-9999", "ENG-8888", "ENG-1111", "ENG-7777"]) expect(notes).not.toContain(hidden)
      }).pipe(Effect.provide(runtime(root, { dirs: [dir], env: { EVA_ROOT: eva }, packs: [omp, ecardPack(Layer.mergeAll(linear, github, Meetings.layer))] }, models)))
    }).pipe(Effect.provide(BunServices.layer), Effect.scoped, Effect.runPromise), 20_000)
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

  test("meeting-prep: half the discussed tickets named, at most 6 in all", () => {
    const tickets = (refs: ReadonlyArray<string>) => ({ tickets: refs.map((ref) => ({ ref })) })
    expect(score("ecard-meeting-prep", { tickets: ["ENG-1", "ENG-2"] }, tickets(["ENG-2", "ENG-9"]))).toMatchObject({ right: true, hits: 1, total: 2 })
    expect(score("ecard-meeting-prep", { tickets: ["ENG-1", "ENG-2", "ENG-3"] }, tickets(["ENG-1"])).right).toBe(false)
    expect(score("ecard-meeting-prep", { tickets: ["ENG-1"] }, tickets(["ENG-1", "ENG-2", "ENG-3", "ENG-4", "ENG-5", "ENG-6", "ENG-7"])).right).toBe(false)
  })

  test("ticket-intake: the route decides, the size is a partial hit", () => {
    expect(score("ecard-ticket-intake", { route: "auto-work", size: "M" }, { route: "auto-work", size: "L" })).toMatchObject({ right: true, hits: 0, total: 1 })
    expect(score("ecard-ticket-intake", { route: "needs-isaac", size: "M" }, { route: "auto-work", size: "M" })).toMatchObject({ right: false, hits: 1 })
  })
})
