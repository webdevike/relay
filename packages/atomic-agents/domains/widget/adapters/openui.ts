import { parseOpenUI } from "@evaos/chat-core/openui"
import { relayLibrary } from "@evaos/chat-core/openui/library"
import { Effect, Layer, Option } from "effect"
import { pack } from "../../../src/core/Adapter.ts"

/** Components the contract teaches: the ones the widget agent's WHEN rules name and their parts. */
const TAUGHT = [
  "Card", "Stack", "Grid", "Tabs", "Tab", "Collapse", "Text", "Rows", "Row", "Badge", "Callout", "List", "ListItem",
  "Progress", "Timeline", "TimelineEntry", "Code", "Diff", "Button", "Link", "Input", "Stat", "Delta", "Chart", "Series",
  "Table", "Column", "Cell", "Tickets", "Ticket", "Emails", "Email", "Recipe", "Ingredient", "Image", "Gallery",
  "GalleryImage", "Compare", "Side", "Audio", "Video", "Model"
]

/** Signatures straight from the library the parser compiles, so a prompt that includes them cannot drift from what renders. */
const signatures = (() => {
  const { components } = relayLibrary.toSpec()
  return TAUGHT.flatMap((name) => Option.toArray(Option.fromUndefinedOr(components[name]))).map((spec) => `- ${spec.signature}`).join("\n")
})()

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
 * Relay's own parser (chat-core `parseOpenUI`, what the phone and desktop render with). Answers what stops
 * the program from rendering whole; empty means it renders. Warnings (an orphaned statement) do not block;
 * a dropped node does, since the widget would render without it.
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

export const openui = pack({
  name: "openui",
  layer: Layer.empty,
  checks: [{
    name: "openui.parse",
    description:
      "The reply is `why: <line>` then `none` or an OpenUI Lang program; the program must pass Relay's parser. Provides kind (openui | none), block (the fenced program) and why. A rejected program goes back once with the parser's errors; still broken, the answer is none.",
    provides: ["kind", "block", "why"],
    contract: signatures,
    check: (reply, context) =>
      Effect.sync(() => {
        const { why, program } = readReply(reply.text)
        if (program === undefined) return { pass: true as const, fields: { kind: "none", why } }
        const errors = renderErrors(program)
        if (errors.length === 0) return { pass: true as const, fields: { kind: "openui", block: fence(program), why } }
        return {
          pass: false as const,
          repair: [
            context.prompt,
            "## Your last reply",
            reply.text.trim(),
            "## Relay's parser rejected it",
            ...errors.map((error) => `- ${error}`),
            "Reply again in the same format: the fixed program, or none. The why line still says why this widget, not what you fixed."
          ].join("\n\n"),
          giveUp: Effect.succeed({ kind: "none", why: `the block would not render after one repair: ${errors[0]}` })
        }
      })
  }]
})
