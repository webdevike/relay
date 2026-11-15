import { parseOpenUI } from "@evaos/chat-core/openui"
import { relayLibrary } from "@evaos/chat-core/openui/library"
import { Clock, Effect, Layer, Option, Schema } from "effect"
import { type Component, define, job, OnEvent, Trigger } from "../../Component.ts"
import { type GenerateRequest, ModelRunner } from "../../Model.ts"

const Surface = Schema.Literals(["phone", "desktop"])
export const Kind = Schema.Literals(["openui", "none"])

/** Output contract: request/response, correlated by `requestId` (`Ask.ts`). */
const events = {
  /** Request: the assistant's draft reply, the data behind it, and where Isaac reads it. */
  "widget.requested": Schema.Struct({
    requestId: Schema.NonEmptyString,
    draft: Schema.String,
    data: Schema.optionalKey(Schema.Json),
    surface: Surface
  }),
  /** The answer: a ```openui block that Relay's parser renders, or none. Never a block that would not render. */
  "widget.ready": Schema.Struct({
    requestId: Schema.String,
    kind: Kind,
    /** The whole fenced block, ready to paste into the reply. */
    block: Schema.optionalKey(Schema.String),
    /** One line: why this widget, or why none. */
    why: Schema.String
  })
}

const contract = { id: "widget" as const, events }

export type Request = Omit<(typeof events)["widget.requested"]["Type"], "requestId">
export type Answer = Omit<(typeof events)["widget.ready"]["Type"], "requestId">

/** Components the prompt teaches: the ones its WHEN rules name and their parts. */
const TAUGHT = [
  "Card", "Stack", "Grid", "Tabs", "Tab", "Collapse", "Text", "Rows", "Row", "Badge", "Callout", "List", "ListItem",
  "Progress", "Timeline", "TimelineEntry", "Code", "Diff", "Button", "Link", "Input", "Stat", "Delta", "Chart", "Series",
  "Table", "Column", "Cell", "Tickets", "Ticket", "Emails", "Email", "Recipe", "Ingredient", "Image", "Gallery",
  "GalleryImage", "Compare", "Side", "Audio", "Video", "Model"
]

/** Signatures straight from the library the parser compiles, so the prompt cannot drift from what renders. */
const signatures = (() => {
  const { components } = relayLibrary.toSpec()
  return TAUGHT.flatMap((name) => Option.toArray(Option.fromUndefinedOr(components[name]))).map((spec) => `- ${spec.signature}`)
})()

/**
 * The WHEN rules are Nova's (`.omp/response-formats/v2.md` § Widgets, as her session prompt gets them);
 * the HOW is the Relay library itself.
 */
const SYSTEM = [
  "You pick the Relay chat widget for an assistant's draft reply to Isaac, or none. Relay (phone and desktop) draws a widget from an OpenUI Lang program; the draft's prose stays as chat.",
  "",
  "When (default none):",
  "- none unless the real data for the widget is in the draft or its data. Never invent numbers, URLs, ids or media paths; copy them verbatim.",
  "- none for plain chat, plans, opinions, questions, one fact or a short list.",
  "- none when 3+ items are compared on the same 2+ fields: a Markdown table in the draft does that, not a widget.",
  "- Stat: 1 to 3 headline numbers (a count, total, rate, before/now pair). Chart: 4+ numbers across time or categories.",
  "- Tickets: 3+ Linear issues or GitHub PRs/issues with status. Diff: a real git diff Isaac asked to see. Compare: a before and an after screenshot both exist.",
  "- Recipe: a sourced recipe with ingredients and directions.",
  "- Gallery, Audio, Model, Emails: only for images, audio, GLB models (Model) or messages that exist in the data (\"/drops/...\" paths or https URLs).",
  "- Tabs of Code: the same thing as code in 2+ languages, files or variants.",
  "- Button, Input: Isaac has a real next step to pick or fill in.",
  "- Card, Stack, Rows, Table, List, Callout, Progress, Timeline, Text: building blocks inside a composition, only with real data.",
  "- One widget per reply. On phone keep it narrow: short labels, tables of at most 4 columns.",
  "",
  "OpenUI Lang:",
  "- One statement per line, `name = Expression`; the first is `root = ...`: one standalone widget, or a Card or Stack holding several.",
  "- Arguments are positional in signature order, never more than the signature has: strings in double quotes with JSON escapes (\\n, \\\"), numbers bare, arrays in [ ]. Write null to skip an optional argument before one you set; leave trailing optional ones out.",
  "- Write sub-components inline where they go (`[Ingredient(\"2 cups flour\"), Ingredient(\"1 tsp salt\")]`); a name you reference must be its own statement.",
  "- Sub-components (Series, Delta, Row, Ticket, Ingredient, Tab, Cell, Column, ListItem, TimelineEntry, Side, GalleryImage, Email) only go inside the widget that takes them. Tabs needs 2 to 6 Tab.",
  "- Button actions: @ToAssistant(\"text\") sends text as Isaac's next turn; @OpenUrl(\"https://...\") opens a link.",
  "- Only these components and arguments:",
  ...signatures,
  "",
  "Reply with exactly this and nothing else:",
  "why: <one line, under 15 words>",
  "then either the single word none, or the program (no code fence)."
].join("\n")

const FENCE = /^```\w*$/
const STATEMENT = /^\s*\$?[A-Za-z_]\w*\s*=(?!=)/

/**
 * `why: ...` then `none` or a program. The program runs from its first statement (`name = ...`, root
 * anywhere) to the end or a closing fence, so chatter before it (small models think aloud) never reaches the
 * block. Without a `root =` line, `none` anywhere means none; anything else goes to the parser as is and fails there.
 */
export const readReply = (text: string): { readonly why: string; readonly program: string | undefined } => {
  const lines = text.trim().split("\n")
  const at = lines.findIndex((line) => /^\s*why\s*:/i.test(line))
  const why = at < 0 ? "" : lines[at]!.replace(/^\s*why\s*:\s*/i, "").trim()
  const body = lines.slice(at + 1)
  if (!body.some((line) => /^\s*root\s*=/.test(line))) {
    const rest = body.filter((line) => !FENCE.test(line.trim())).join("\n").trim()
    return { why, program: rest === "" || body.some((line) => /^\s*none\.?\s*$/i.test(line)) ? undefined : rest }
  }
  const program = body.slice(body.findIndex((line) => STATEMENT.test(line)))
  const end = program.findIndex((line) => FENCE.test(line.trim()))
  return { why, program: (end < 0 ? program : program.slice(0, end)).join("\n").trim() }
}

/**
 * The fixed final check: Relay's own parser (chat-core `parseOpenUI`, what the phone and desktop render with).
 * Answers what stops the program from rendering whole; empty means it renders. Warnings (an orphaned
 * statement) do not block; a dropped node does, since the widget would render without it.
 */
export const renderErrors = (program: string): ReadonlyArray<string> => {
  const result = parseOpenUI(program)
  const blocking = result.errors.filter((error) => error.severity !== "warning")
  if (result.node !== null && result.complete && blocking.length === 0) return []
  return blocking.length === 0
    ? ["no renderable root"]
    : blocking.map((error) => `${error.code}${error.component === undefined ? "" : ` ${error.component}`}${error.path ?? ""}: ${error.message}`)
}

export const fence = (program: string) => `\`\`\`openui\n${program}\n\`\`\``

export interface Decision {
  readonly answer: Answer
  /** Model calls: 1, or 2 when the first program failed the parser and was sent back once. */
  readonly calls: number
  readonly repaired: boolean
  /** USD over all calls. */
  readonly cost: number
  readonly seconds: number
}

/** Per model call: a widget is worth nothing once the reply has gone out. */
const CALL_TIMEOUT = "30 seconds"

/**
 * One model call picks none or a program; the parser gates it. A program that would not render goes back
 * once with the parser's errors; if the second one fails too, the answer is none.
 */
export const decide = Effect.fn("widget.decide")(function*(
  agent: Pick<GenerateRequest, "model" | "system" | "thinking">,
  request: Request
) {
  const models = yield* ModelRunner
  const started = yield* Clock.currentTimeMillis
  const call = (text: string) => models.generate({ ...agent, prompt: text, timeout: CALL_TIMEOUT })
  const { draft, data, surface } = request
  const prompt = [`Surface: ${surface}`, "Draft reply:", draft, "Data:", data === undefined ? "(none)" : JSON.stringify(data, null, 1)].join("\n")
  const first = yield* call(prompt)
  const done = (answer: Answer, calls: number, repaired: boolean, cost: number) =>
    Effect.map(Clock.currentTimeMillis, (now): Decision => ({ answer, calls, repaired, cost, seconds: (now - started) / 1000 }))

  const reply = readReply(first.text)
  if (reply.program === undefined) return yield* done({ kind: "none", why: reply.why }, 1, false, first.cost)
  const errors = renderErrors(reply.program)
  if (errors.length === 0) return yield* done({ kind: "openui", block: fence(reply.program), why: reply.why }, 1, false, first.cost)

  const second = yield* call([
    prompt,
    "## Your last reply",
    first.text.trim(),
    "## Relay's parser rejected it",
    ...errors.map((error) => `- ${error}`),
    "Reply again in the same format: the fixed program, or none. The why line still says why this widget, not what you fixed."
  ].join("\n\n"))
  const cost = first.cost + second.cost
  const retry = readReply(second.text)
  if (retry.program === undefined) return yield* done({ kind: "none", why: retry.why }, 2, true, cost)
  const still = renderErrors(retry.program)
  return yield* still.length === 0
    ? done({ kind: "openui", block: fence(retry.program), why: retry.why }, 2, true, cost)
    : done({ kind: "none", why: `the block would not render after one repair: ${still[0]}` }, 2, true, cost)
})

// Only ModelRunner, which every job gets; no tools of its own.
const pick = job<typeof events, (typeof events)["widget.requested"], never>(events, {
  id: "pick",
  description: "Pick the Relay widget block for a draft reply and its data, or none; the block always passes Relay's parser.",
  input: events["widget.requested"],
  triggers: [OnEvent(contract, "widget.requested"), Trigger.Manual()],
  run: Effect.fnUntraced(function*({ requestId, ...request }, ctx) {
    const decision = yield* decide({ model: ctx.model, system: ctx.agent.system, ...(ctx.agent.thinking ? { thinking: ctx.agent.thinking } : {}) }, request).pipe(
      // The caller is waiting: a failed call still answers none at once, then the run fails as usual.
      Effect.tapError((error) => ctx.emit("widget.ready", { requestId, kind: "none", why: `failed: ${error.message}` }))
    )
    yield* ctx.emit("widget.ready", { requestId, ...decision.answer })
  })
})

const decodeReady = Schema.decodeUnknownOption(events["widget.ready"])

export const spec = {
  ...contract,
  purpose: "Given Nova's draft reply and its data, return the right Relay widget block for it, or none.",
  agent: {
    // Bench 2026-11-14 (13 real cases x 2): Sonnet 5.5 is the fastest (p50 2.28 s), renders first try every time,
    // 23/26 right; Gemini 3.8 Flash 26/26 but p50 3.16 s and paid per call; Haiku 5.5 needs a repair half the time.
    model: "anthropic/claude-sonnet-5-5",
    candidates: ["anthropic/claude-sonnet-5-5", "openrouter/google/gemini-3.8-flash", "anthropic/claude-haiku-5-5", "openai-codex/gpt-6-luna"],
    thinking: "off",
    system: SYSTEM
  },
  jobs: [pick],
  tools: Layer.empty,
  asks: {
    request: "widget.requested",
    reply: "widget.ready",
    show: (reply) => Option.match(decodeReady(reply), { onNone: () => "none", onSome: (ready) => ready.block ?? "none" })
  }
} satisfies Component

export const widget = define(spec)
