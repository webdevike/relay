import { z } from "zod";

/**
 * Eva's specialist router in assistant threads. Before each of Isaac's messages reaches the assistant, the
 * `specialist-router` omp hook (in the Eva checkout) has JEV pick the atomic specialist that fits it (an
 * `agents_list` id such as `web-researcher`), or none, and writes that decision into the assistant's transcript
 * as an omp `custom` entry (`customType` `eva.specialist-router`), just before the user `message` entry it judged
 * (omp's own date reminder may sit between them). At the turn's end it writes the outcome (same `id`): whether the
 * assistant asked that specialist. In shadow mode the assistant never sees the decision; live mode hints it.
 * Relay shows the decision as one quiet line under Isaac's bubble (`routerLine`) and the whole of it on a tap.
 */

/** The omp custom entry type the router writes. */
export const ROUTER_ENTRY_TYPE = "eva.specialist-router";

const NONE_REASONS = ["chat", "open-ended", "no-fit", "missing-inputs"] as const;

/** What the router decided for one of Isaac's messages (written in `before_agent_start`). */
export const RouterDecision = z.object({
  v: z.literal(1),
  kind: z.literal("decision"),
  id: z.string().min(1),
  at: z.string(),
  assistant: z.string(),
  /** `live`: a hint was given to the assistant; `shadow`: only recorded. */
  mode: z.enum(["shadow", "live"]),
  /** A specialist id, or `none`. */
  agent: z.string().min(1),
  confidence: z.number().min(0).max(1),
  why: z.string(),
  noneReason: z.enum(NONE_REASONS).optional().catch(undefined),
  /** The top 3 by probability (may include `none`). */
  alternatives: z
    .array(z.object({ agent: z.string(), p: z.number() }))
    .catch([]),
  /** The request JSON the assistant could pass to `agents_ask`. */
  suggestedRequest: z.record(z.unknown()).optional().catch(undefined),
  threshold: z.number(),
  /** True only in live mode when `agent` is not `none` and `confidence` reached `threshold`. */
  hinted: z.boolean(),
  latencyMs: z.number(),
  /** The router could not decide (`timeout`, `jev 503`): `agent` is `none`, `confidence` 0. */
  error: z.string().optional().catch(undefined),
  /** The judged message's opening (debug only; never shown in the row). */
  prompt: z.string().catch(""),
});
export type RouterDecision = z.infer<typeof RouterDecision>;

/** What the assistant did in the judged turn (written at `agent_end`, same `id`); missing while the turn runs or after a crash. */
export const RouterOutcome = z.object({
  v: z.literal(1),
  kind: z.literal("outcome"),
  id: z.string().min(1),
  at: z.string(),
  /** The assistant asked the decided specialist during the turn. */
  used: z.boolean(),
  /** Every specialist the assistant asked during the turn. */
  usedAgents: z.array(z.string()).catch([]),
  /** Why the assistant passed on the decided specialist, when it said (live mode). */
  skipReason: z.string().optional().catch(undefined),
});
export type RouterOutcome = z.infer<typeof RouterOutcome>;

export const RouterRecord = z.discriminatedUnion("kind", [RouterDecision, RouterOutcome]);
export type RouterRecord = z.infer<typeof RouterRecord>;

/** One of Isaac's messages as the router saw it: the decision, and the outcome once the turn ended. */
export const RouterTurn = z.object({
  decision: RouterDecision,
  outcome: RouterOutcome.optional().catch(undefined),
});
export type RouterTurn = z.infer<typeof RouterTurn>;

/** A judged user message: its transcript entry id, its message timestamp (ms, when it has one) and the router's turn. */
export interface RoutedMessage extends RouterTurn {
  readonly at: number | undefined;
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

/** The router record an omp transcript entry holds, or undefined (another entry, another custom type, an unknown `v`, a bad shape). */
export function routerRecordOf(entry: unknown): RouterRecord | undefined {
  if (!isObj(entry) || entry["type"] !== "custom" || entry["customType"] !== ROUTER_ENTRY_TYPE) return undefined;
  const parsed = RouterRecord.safeParse(entry["data"]);
  return parsed.success ? parsed.data : undefined;
}

/**
 * The router's decisions by the user message they judged, keyed by that message entry's id. `entries` are omp
 * transcript entries in file (branch) order. A decision belongs to the first `message` entry with role `user` after
 * it (other entries between them are passed over); a newer decision before that message replaces an older one. An
 * outcome joins its decision by `id`, wherever it sits. Anything else is ignored.
 */
export function routerByUserMessage(entries: Iterable<unknown>): Map<string, RoutedMessage> {
  const out = new Map<string, RoutedMessage>();
  const outcomes = new Map<string, RouterOutcome>();
  let pending: RouterDecision | undefined;
  for (const entry of entries) {
    const record = routerRecordOf(entry);
    if (record?.kind === "decision") {
      pending = record;
      continue;
    }
    if (record?.kind === "outcome") {
      outcomes.set(record.id, record);
      continue;
    }
    if (pending === undefined || !isObj(entry) || entry["type"] !== "message") continue;
    const message = entry["message"];
    if (!isObj(message) || message["role"] !== "user") continue;
    const id = entry["id"];
    if (typeof id === "string" && id.length > 0) {
      const at = message["timestamp"];
      out.set(id, { decision: pending, at: typeof at === "number" ? at : undefined });
    }
    pending = undefined;
  }
  for (const routed of out.values()) {
    const outcome = outcomes.get(routed.decision.id);
    if (outcome !== undefined) routed.outcome = outcome;
  }
  return out;
}

/** The row's pieces: `head` (`Router: web-researcher · 0.86`), the decision's `why` on one line (absent for none and errors), and the after-turn `mark`. */
export interface RouterParts {
  readonly head: string;
  readonly why?: string;
  readonly mark?: string;
}

const NONE = "none";

/** What a decision's row says, in pieces a view can truncate apart (the `why` shrinks, the mark stays). */
export function routerParts(decision: RouterDecision, outcome?: RouterOutcome): RouterParts {
  const matched = decision.error === undefined && decision.agent !== NONE;
  const head =
    decision.error !== undefined
      ? `Router: skipped · ${oneLine(decision.error)}`
      : matched
        ? `Router: ${decision.agent} · ${decision.confidence.toFixed(2)}`
        : "Router: none";
  const why = matched ? oneLine(decision.why) : "";
  const mark = outcome === undefined ? undefined : routerMark(matched, outcome);
  return {
    head,
    ...(why === "" ? {} : { why }),
    ...(mark === undefined ? {} : { mark }),
  };
}

function routerMark(matched: boolean, outcome: RouterOutcome): string | undefined {
  if (matched) {
    if (outcome.used) return "used";
    const reason = oneLine(outcome.skipReason ?? "");
    return reason === "" ? "skipped" : `skipped: ${reason}`;
  }
  const used = outcome.usedAgents.filter((agent) => agent !== NONE && agent.length > 0);
  return used.length === 0 ? undefined : `used ${used.join(", ")}`;
}

/**
 * The quiet line under Isaac's bubble: `Router: web-researcher · 0.86 · <why>`, `Router: none`, `Router: skipped · timeout`;
 * once the turn ended `· used`, `· skipped: <reason>` / `· skipped`, or `· used <agent>` when the router said none.
 */
export function routerLine(decision: RouterDecision, outcome?: RouterOutcome): string {
  const { head, why, mark } = routerParts(decision, outcome);
  return [head, why, mark].filter((part) => part !== undefined).join(" · ");
}

/** The decision and its outcome as labelled rows (the desktop popover and the phone sheet). Values are text; `suggestedRequest` is pretty JSON. */
export function routerDetail(turn: RouterTurn): [label: string, value: string][] {
  const { decision: d, outcome: o } = turn;
  const rows: [string, string][] = [
    ["Agent", d.agent],
    ["Confidence", d.confidence.toFixed(2)],
  ];
  if (d.why.trim() !== "") rows.push(["Why", d.why]);
  if (d.noneReason !== undefined) rows.push(["None reason", d.noneReason]);
  if (d.alternatives.length > 0)
    rows.push(["Alternatives", d.alternatives.map((a) => `${a.agent} ${a.p.toFixed(2)}`).join(", ")]);
  if (d.suggestedRequest !== undefined)
    rows.push(["Suggested request", JSON.stringify(d.suggestedRequest, null, 2)]);
  rows.push(
    ["Mode", d.mode],
    ["Hinted", d.hinted ? "yes" : "no"],
    ["Threshold", d.threshold.toFixed(2)],
    ["Latency", `${Math.round(d.latencyMs)} ms`],
  );
  if (d.error !== undefined) rows.push(["Error", d.error]);
  if (o === undefined) rows.push(["Outcome", "turn still running"]);
  else {
    rows.push(["Used", o.used ? "yes" : "no"]);
    rows.push(["Used agents", o.usedAgents.length === 0 ? "none" : o.usedAgents.join(", ")]);
    if (o.skipReason !== undefined) rows.push(["Skip reason", o.skipReason]);
  }
  return rows;
}

const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();
