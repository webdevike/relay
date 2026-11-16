import { describe, expect, test } from "bun:test"
import { createActor, fromCallback, fromPromise, SimulatedClock, waitFor } from "xstate"
import facebook from "./fixtures/muse/facebook-ask.json"
import marketplace from "./fixtures/muse/marketplace-ask.json"
import fixture from "./fixtures/muse/instagram-ask.json"
import { askMachine, type AskOutput, type Progress } from "../adapters/muse/ask.machine.ts"
import type { Cua, Reply } from "../adapters/muse/cua.ts"
import { type Host, museAsk } from "../adapters/muse/driver.ts"
import { type Element, readScreen } from "../adapters/muse/screen.ts"

/** Recorded through cua-driver on 2026-11-15 (an Instagram ask about Melbourne specialty coffee reels). */
const SNAPSHOTS = fixture.snapshots as Readonly<Record<"loading" | "empty" | "working" | "answered", ReadonlyArray<Element>>>
const LINKS = [
  "https://www.instagram.com/reel/Dfahs6CzhsB/",
  "https://www.instagram.com/reel/DfOBe5SSVij/",
  "https://www.instagram.com/reel/DfQiXEnz2-k/",
  "https://www.instagram.com/reel/DfeE0C1hgYD/",
  "https://www.instagram.com/reel/DfrRe9XSK57/",
  "https://www.instagram.com/reel/Dfbv4QHsEoj/"
]

const ok = (structuredContent: Record<string, unknown>): Reply => ({ result: { content: [{ type: "text", text: "ok" }], structuredContent } })

interface Script {
  readonly windows?: ReadonlyArray<Record<string, unknown>>
  readonly active?: boolean
  /** The chat UI before Return (the new side chat). */
  readonly chat?: ReadonlyArray<Element>
  /** Each window read after Return, in turn (the last one repeats). */
  readonly after?: ReadonlyArray<ReadonlyArray<Element>>
}

/** cua-driver as Muse looked while recorded: replays the fixture's snapshots and logs every action the driver takes. */
const fakeMuse = (script: Script = {}) => {
  const actions: Array<string> = []
  const typed: Array<unknown> = []
  let returned = false
  let reads = 0
  const after = script.after ?? [SNAPSHOTS.working, SNAPSHOTS.working, SNAPSHOTS.answered]
  const withTokens = (elements: ReadonlyArray<Element>) => elements.map((element) => ({ ...element, element_token: `s00000001:${element.element_index}` }))
  const cua: Cua = {
    call: async (name, args) => {
      if (name === "list_apps") return ok({ apps: [{ bundle_id: "com.meta.endo", running: true, active: script.active ?? false }] })
      if (name === "list_windows") return ok({ windows: script.windows ?? fixture.windows })
      if (name === "get_screen_size") return ok({ width: 3840, height: 1080 })
      if (name === "get_window_state") {
        const elements = returned ? after[Math.min(reads++, after.length - 1)]! : script.chat ?? SNAPSHOTS.empty
        return ok({ elements: withTokens(elements), background_input: { routes: [] } })
      }
      actions.push(name === "click" ? `click ${args["element_token"]}` : name === "press_key" ? `key ${args["key"]}` : name)
      if (name === "type_text") typed.push(args["text"])
      if (name === "press_key" && args["key"] === "return") returned = true
      return ok({})
    },
    close: () => {}
  }
  return { cua, actions, typed }
}

/** The driver at its real poll interval and the machine at its real delays, on simulated time: each wait the driver makes moves the clock. */
const ask = (cua: Cua) => {
  const clock = new SimulatedClock()
  const host: Host = {
    unhide: async () => {},
    activate: async () => {},
    now: () => clock.now(),
    sleep: async (ms) => {
      clock.increment(ms)
      await new Promise((resolve) => setImmediate(resolve))
    }
  }
  const { promise, resolve } = Promise.withResolvers<AskOutput>()
  const actor = createActor(museAsk(cua, host), { input: { prompt: fixture.question }, clock })
  actor.subscribe((snapshot) => {
    if (snapshot.status === "done") resolve(snapshot.output)
  })
  actor.start()
  return promise
}

describe("muse screen", () => {
  test("reads the recorded answer: its text, each raw URL once with what Muse said before it, preview cards counted", () => {
    const answered = readScreen(SNAPSHOTS.answered)
    expect(answered.working).toBe(false)
    expect(answered.reply!.links.map((link) => link.url)).toEqual(LINKS)
    expect(answered.reply!.links[1]!.context).toBe(
      "8. Homebody Union, Fitzroy — @kimmyyliew\n1.1K likes, 30 comments, 2 Nov 2026. Waiting an hour at the World Barista Champion Anthony Douglas cafe, with the Champion’s Signature Coffee Set."
    )
    expect(answered.reply!.cards).toBe(6)
    expect(answered.reply!.text).toContain("1. MILKLAB “Barista in a Box” at Coffee Weekend — @goldenbrown.coffee")
    // Neither the sent question nor the cards' host lines are part of the answer.
    expect(answered.reply!.text).not.toContain("Read-only research request")
    expect(answered.reply!.text.split("\n")).not.toContain("instagram.com")
  })

  test("tells a loading window, an empty new chat and a question still being answered apart", () => {
    expect(readScreen(SNAPSHOTS.loading).newChat).toBeUndefined()
    const empty = readScreen(SNAPSHOTS.empty)
    expect([empty.newChat?.label, empty.composer, empty.working, empty.sent.length, empty.reply]).toEqual(["New side chat", true, false, 0, undefined])
    const working = readScreen(SNAPSHOTS.working)
    expect([working.working, working.sent.length, working.reply?.text]).toEqual([true, 1, ""])
  })

  test("a link's context is only what Muse wrote since the previous link (a Facebook answer puts the words first, the link under them)", () => {
    const { links } = readScreen(facebook.answered as ReadonlyArray<Element>).reply!
    const starter = links.find((link) => link.url.endsWith("/permalink/970874650331754/"))!
    expect(starter.context).toBe("Starter-machine thread, 19 Jun 2021 — commenter said “you can’t beat the Breville Bambino Plus, ready to use in 3 seconds with automatic milk frothing”:")
    expect(links[0]!.url).toBe("https://facebook.com/groups/2757119431260688/")
    expect(links[0]!.context).toContain("Home Espresso Beginners, 108,000 members, private")
  })

  test("a Marketplace answer: listing cards come back as titles, and titles Muse set inline as buttons stay in the sentence", () => {
    const reply = readScreen(marketplace.answered as ReadonlyArray<Element>).reply!
    expect(reply.listings).toEqual(["DeLonghi Espresso Machine", "De'Longhi EC-702 Espresso Machine", "Tru espresso machine", "De'Longhi Stilosa Espresso Machine", "Brevielle espresso machine"])
    expect(reply.links).toEqual([])
    expect(reply.text).toContain("the tradeoff is\nGaggia Classic Espresso Machine (2014) w/Mods\nversus\nGaggia Classic Pro W/ Gaggiuino mod")
    expect(reply.text).not.toContain("View all")
  })
})

describe("muse driver over the recorded app", () => {
  test("opens a new side chat, types the question, presses Return once, waits out Stop, and returns the links", async () => {
    const { cua, actions, typed } = fakeMuse()
    const output = await ask(cua)
    expect(output.ok && output.reply.links.map((link) => link.url)).toEqual(LINKS)
    // Read-only toward everyone else: the one press is New side chat, the one key is Return.
    expect(actions).toEqual(["click s00000001:16", "type_text", "key return"])
    expect(typed).toEqual([fixture.question])
  })

  test("signed out: no chat window, only Muse's Log in window, and nothing is touched", async () => {
    const { cua, actions } = fakeMuse({ windows: [{ app_name: "Muse", title: "Log in", pid: 1, window_id: 2, is_on_screen: true }] })
    expect(await ask(cua)).toMatchObject({ ok: false, kind: "signed_out" })
    expect(actions).toEqual([])
  })

  test("busy: Muse is the app in front, so nothing is pressed or typed", async () => {
    const { cua, actions } = fakeMuse({ active: true })
    expect(await ask(cua)).toMatchObject({ ok: false, kind: "busy" })
    expect(actions).toEqual([])
  })

  test("UI changed: the window never shows a New side chat button", async () => {
    const { cua, actions } = fakeMuse({ chat: SNAPSHOTS.loading })
    expect(await ask(cua)).toMatchObject({ ok: false, kind: "ui_changed" })
    expect(actions).toEqual([])
  })

  test("UI changed: the question never shows up in the chat after Return", async () => {
    const { cua } = fakeMuse({ after: [SNAPSHOTS.empty] })
    expect(await ask(cua)).toMatchObject({ ok: false, kind: "ui_changed", message: expect.stringContaining("never showed up") })
  })

  test("rate limited: Muse answers with a limit notice instead of an answer", async () => {
    const composer = SNAPSHOTS.working.findIndex((element) => element.role === "AXButton" && element.label?.startsWith("Message"))
    const limited = [
      ...SNAPSHOTS.working.slice(0, composer),
      { element_index: 900, role: "AXStaticText", value: "You've reached your daily message limit. Try again later." },
      { ...SNAPSHOTS.working[composer]!, label: "Message Attach file\nSend" },
      ...SNAPSHOTS.working.slice(composer + 1)
    ]
    const { cua } = fakeMuse({ after: [limited] })
    expect(await ask(cua)).toMatchObject({ ok: false, kind: "rate_limited" })
  })
})

describe("muse ask machine", () => {
  const started = async () => {
    const clock = new SimulatedClock()
    let push: (event: { type: "muse.progress"; progress: Progress }) => void = () => {}
    const done = fromPromise<void>(async () => {})
    const machine = askMachine.provide({
      actors: { attach: done, openChat: done, typePrompt: fromPromise<void, { prompt: string }>(async () => {}), send: done, watch: fromCallback(({ sendBack }) => void (push = sendBack)) }
    })
    const actor = createActor(machine, { input: { prompt: "q" }, clock }).start()
    await waitFor(actor, (snapshot) => snapshot.matches({ live: "posting" }))
    const progress = (working: boolean, text: string) => push({ type: "muse.progress", progress: { posted: true, working, rateLimited: false, reply: { text, links: [], cards: 0, listings: [] } } })
    return { actor, clock, progress }
  }

  test("an answer that stops working with its text unchanged still settles 6 s later", async () => {
    const { actor, clock, progress } = await started()
    progress(true, "Here are the reels.")
    clock.increment(5_000)
    progress(true, "Here are the reels.")
    clock.increment(5_000)
    progress(false, "Here are the reels.")
    clock.increment(5_999)
    expect(actor.getSnapshot().status).toBe("active")
    clock.increment(1)
    expect(actor.getSnapshot().output).toEqual({ ok: true, reply: { text: "Here are the reels.", links: [], cards: 0, listings: [] } })
  })

  test("Muse still working after 6 minutes fails as a timeout, keeping what it had", async () => {
    const { actor, clock, progress } = await started()
    for (let elapsed = 0; elapsed < 360_000; elapsed += 5_000) {
      progress(true, "Searching")
      clock.increment(5_000)
    }
    expect(actor.getSnapshot().output).toMatchObject({ ok: false, kind: "timeout", partial: { text: "Searching" } })
  })
})
