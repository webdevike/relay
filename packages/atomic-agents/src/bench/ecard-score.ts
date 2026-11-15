import { Schema } from "effect"

/**
 * How the eCard bench (`ecard.ts`) scores one answer of each ecard-* chef against its case's `expect` (real history).
 * `right` decides; `hits/total` is partial credit where the chef answers a list or a second field.
 */
export interface Score {
  readonly right: boolean
  readonly note: string
  readonly hits?: number
  readonly total?: number
}

/** Voice breaks a draft can be checked for without a judge (references/slack-voice.md). */
export const voiceBreaks = (draft: string, actual: string): ReadonlyArray<string> => [
  ...(/[—–]/.test(draft) ? ["em dash"] : []),
  ...(/^(hi|hello|dear)\b/i.test(draft.trim()) ? ["greeting"] : []),
  ...(/\b(best|regards|cheers),?\s*$/i.test(draft.trim()) ? ["sign-off"] : []),
  ...(/(^|[^<|])https?:\/\//.test(draft) ? ["raw url"] : []),
  ...(draft.length > Math.max(3 * actual.length, actual.length + 160) ? [`long (${draft.length} vs ${actual.length} chars)`] : [])
]

const Verdict = Schema.Struct({ verdict: Schema.String })
const Item = Schema.Struct({ ticket: Schema.NullOr(Schema.String), newSubIssue: Schema.Boolean })

/** One chef's scorer: its expect and answer schemas (the answer is the recipe's answer fields), and the score. */
interface Scorer<X, A> {
  readonly expect: Schema.Decoder<X>
  readonly answer: Schema.Decoder<A>
  readonly score: (expect: X, answer: A, input: Readonly<Record<string, unknown>>) => Score
}

const scorer = <X, A>(spec: Scorer<X, A>) => spec as unknown as Scorer<unknown, unknown>

export const scorers: Readonly<Record<string, Scorer<unknown, unknown>>> = {
  /** The verdict against the answer key (whether Isaac actually answered in Slack). */
  "ecard-slack-triage": scorer({
    expect: Verdict,
    answer: Verdict,
    score: (expect, answer) => ({ right: answer.verdict === expect.verdict, note: answer.verdict })
  }),
  /** The kind Isaac actually chose (his real reply decides it). */
  "ecard-review-drafter": scorer({
    expect: Schema.Struct({ kind: Schema.String }),
    answer: Schema.Struct({ kind: Schema.String }),
    score: (expect, answer) => ({ right: answer.kind === expect.kind, note: answer.kind })
  }),
  /** The state is the decision; for In QA the assignee and a comment naming a SHA count too. */
  "ecard-ticket-mover": scorer({
    expect: Schema.Struct({ state: Schema.String, assignee: Schema.optionalKey(Schema.String) }),
    answer: Schema.Struct({ state: Schema.String, assignee: Schema.optionalKey(Schema.String), comment: Schema.String }),
    score: (expect, answer, input) => {
      const stateRight = answer.state === expect.state
      if (expect.state === "none") return { right: stateRight, note: answer.state }
      const shas = Array.isArray(input["shas"]) ? input["shas"].filter((sha): sha is string => typeof sha === "string") : []
      const namesSha = shas.some((sha) => answer.comment.includes(sha.slice(0, 7)))
      return { right: stateRight && answer.assignee === expect.assignee && namesSha, note: `${answer.state}/${answer.assignee ?? "-"}${namesSha ? "" : " no sha"}` }
    }
  }),
  /**
   * Each expected ticket found among the answer's tickets, each expected new item (ticket null, not a chore) matched
   * by an answer item with newSubIssue. Right = every expected item hit and no invented keys outside the key.
   */
  "ecard-meeting-actions": scorer({
    expect: Schema.Array(Schema.Struct({ ticket: Schema.NullOr(Schema.String), chore: Schema.optionalKey(Schema.Boolean) })),
    answer: Schema.Struct({ items: Schema.Array(Item) }),
    score: (expect, answer) => {
      const tickets = new Set(answer.items.flatMap((item) => item.ticket === null ? [] : [item.ticket]))
      const wantTickets = expect.flatMap((item) => item.ticket === null ? [] : [item.ticket])
      const wantNew = expect.filter((item) => item.ticket === null && item.chore !== true).length
      const hits = wantTickets.filter((key) => tickets.has(key)).length + Math.min(wantNew, answer.items.filter((item) => item.newSubIssue).length)
      const total = wantTickets.length + wantNew
      const extra = [...tickets].filter((key) => !wantTickets.includes(key))
      return { right: hits === total && extra.length === 0, hits, total, note: `${hits}/${total}${extra.length ? ` extra ${extra.join(",")}` : ""}` }
    }
  }),
  /** Right when the draft does what Isaac's real reply did (one of `intents`) and breaks no voice rule. */
  "ecard-slack-reply-drafter": scorer({
    expect: Schema.Struct({ intents: Schema.Array(Schema.String), reply: Schema.String }),
    answer: Schema.Struct({ intent: Schema.String, draft: Schema.String }),
    score: (expect, answer) => {
      const breaks = voiceBreaks(answer.draft, expect.reply)
      const intentRight = expect.intents.includes(answer.intent)
      return {
        right: intentRight && breaks.length === 0,
        note: `${answer.intent}${breaks.length === 0 ? "" : ` [${breaks.join(", ")}]`}: ${answer.draft.slice(0, 90)}`,
        hits: intentRight ? 1 : 0,
        total: 1
      }
    }
  }),
  /** The verdict against the answer key (Isaac's reply in Sent, or the kind of sender). */
  "ecard-outlook-triage": scorer({
    expect: Verdict,
    answer: Schema.Struct({ verdict: Schema.String, reason: Schema.String }),
    score: (expect, answer) => ({ right: answer.verdict === expect.verdict, note: `${answer.verdict}: ${answer.reason.slice(0, 80)}` })
  }),
  /** hits = expected tickets the brief names (those discussed in that meeting); right at half or more and at most 6 named. */
  "ecard-meeting-prep": scorer({
    expect: Schema.Struct({ tickets: Schema.Array(Schema.String) }),
    answer: Schema.Struct({ tickets: Schema.Array(Schema.Struct({ ref: Schema.String })) }),
    score: (expect, answer) => {
      const named = answer.tickets.map((ticket) => ticket.ref.toUpperCase())
      const hits = expect.tickets.filter((key) => named.includes(key.toUpperCase())).length
      return { right: hits * 2 >= expect.tickets.length && named.length <= 6, note: `${hits}/${expect.tickets.length} named: ${named.join(" ") || "-"}`, hits, total: expect.tickets.length }
    }
  }),
  /** The route decides; the size is a partial hit. */
  "ecard-ticket-intake": scorer({
    expect: Schema.Struct({ route: Schema.String, size: Schema.optionalKey(Schema.String) }),
    answer: Schema.Struct({ route: Schema.String, size: Schema.String }),
    score: (expect, answer) => ({
      right: answer.route === expect.route,
      note: `${answer.route}/${answer.size}`,
      hits: expect.size === undefined || answer.size === expect.size ? 1 : 0,
      total: 1
    })
  }),
  /** The cause against what history showed (rerun passed, a fix commit followed, or an environment error). */
  "ecard-ci-triage": scorer({
    expect: Schema.Struct({ cause: Schema.String }),
    answer: Schema.Struct({ cause: Schema.String, evidence: Schema.String }),
    score: (expect, answer) => ({ right: answer.cause === expect.cause, note: `${answer.cause}: ${answer.evidence.slice(0, 80)}` })
  })
}
