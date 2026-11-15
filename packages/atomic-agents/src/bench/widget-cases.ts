/**
 * The widget bench's cases: the answer key in `widget-cases.json`, plus Isaac's 🎯 answers that Relay Host saves to
 * `<home>/bench/widget/training.jsonl` (one line per answer: the reply, what was shown under it, his label).
 */
import { parseOpenUI } from "@evaos/chat-core/openui"
import { Option, Schema } from "effect"

/** What the widget chef answered (its `widget.ready` kind), and Isaac's 🎯 answer: keep what was shown, or what it should have been. */
const Kind = Schema.Literals(["openui", "none"])
const Label = Schema.Literals(["keep", "plain", "chart", "table", "card", "other"])

const Surface = Schema.Literals(["phone", "desktop"])

export const Case = Schema.Struct({
  id: Schema.String,
  /** Where the draft comes from: `<session file>:<line>`, or `training.jsonl:<line>`. */
  source: Schema.String,
  draft: Schema.String,
  data: Schema.optionalKey(Schema.Json),
  surface: Surface,
  /** Widget keys the block must hold (`recipe`, `tabs`+`code`, ...); empty means the answer is none. */
  expect: Schema.Array(Schema.String),
  note: Schema.optionalKey(Schema.String)
})
export type Case = typeof Case.Type

/** Every `widget` key in a parsed tree. */
const widgets = (node: unknown, out = new Set<string>()): Set<string> => {
  if (Array.isArray(node)) for (const child of node) widgets(child, out)
  else if (typeof node === "object" && node !== null) {
    for (const [key, value] of Object.entries(node)) {
      if (key === "widget" && typeof value === "string") out.add(value)
      else widgets(value, out)
    }
  }
  return out
}

/** The widget keys of a fenced ```openui block (or a bare program), as the bench compares them. */
export const widgetKeys = (block: string): ReadonlyArray<string> =>
  [...widgets(parseOpenUI(block.replace(/^```openui\n/, "").replace(/\n```$/, "")).node)]

/** One line of training.jsonl, as Relay Host writes it (other fields are kept for people, not read here). */
const TrainingLine = Schema.Struct({
  message: Schema.String,
  surface: Surface,
  label: Label,
  answer: Schema.optionalKey(Schema.String),
  draft: Schema.String,
  shown: Schema.Struct({
    kind: Kind,
    /** `reply`: the assistant's own fence in the draft; `widget`: the follow-up block Relay showed under it. */
    source: Schema.optionalKey(Schema.Literals(["reply", "widget"])),
    block: Schema.optionalKey(Schema.String)
  })
})
const decodeLine = Schema.decodeUnknownOption(Schema.fromJsonString(TrainingLine))

const OWN_FENCE = /^[ \t]*```openui[ \t]*\n[\s\S]*?^[ \t]*```[ \t]*$/m

/** What a label says the widget agent should answer: keep what was shown, none for plain text, else that widget. */
const EXPECT: Record<Exclude<typeof Label.Type, "keep" | "other">, ReadonlyArray<string>> = {
  plain: [],
  chart: ["chart"],
  table: ["table"],
  card: ["card"]
}

/**
 * Bench cases from training.jsonl, one per reply (Isaac's latest answer on it wins). A reply that carried its
 * own widget is benched on its prose (the fence cut out), so "keep" expects that widget. "other" says only that
 * it was wrong, so it is skipped, like unreadable lines.
 */
export const trainingCases = (text: string): { readonly cases: ReadonlyArray<Case>; readonly skipped: number } => {
  const byReply = new Map<string, Case | null>()
  let unreadable = 0
  text.split("\n").forEach((line, index) => {
    if (line.trim() === "") return
    const entry = decodeLine(line)
    if (Option.isNone(entry)) {
      unreadable += 1
      return
    }
    const { message, surface, label, answer, draft, shown } = entry.value
    byReply.delete(message)
    if (label === "other") {
      byReply.set(message, null)
      return
    }
    const own = shown.source === "reply" ? OWN_FENCE.exec(draft)?.[0] : undefined
    const kept = shown.kind === "openui" && shown.block !== undefined ? widgetKeys(shown.block) : []
    byReply.set(message, {
      id: `trained-${message}`,
      source: `training.jsonl:${index + 1}`,
      draft: own === undefined ? draft : draft.replace(own, "").trim(),
      surface,
      expect: label === "keep" ? kept : EXPECT[label],
      note: `🎯 ${answer ?? label}${shown.kind === "openui" ? ` (shown: ${kept.join("+")})` : " (shown: none)"}`
    })
  })
  const cases = [...byReply.values()].filter((item): item is Case => item !== null)
  return { cases, skipped: unreadable + byReply.size - cases.length }
}
