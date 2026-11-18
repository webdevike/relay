import { Schema } from "effect";
import { isObject } from "./Fields.ts";

/**
 * Trial mode for taste agents: Isaac picks the model by blind picks on real requests.
 *
 * A trial agent (agent file `trial: true`, or config.json `components.<id>.trial`) runs each caller's request on its
 * trial models at once (`Settings.effective(...).trial.arms`, its own model first). The run on its own model is the
 * normal run: the caller gets that answer as soon as it is ready. The others are trial arms: they never answer the
 * caller, and their result goes only on Isaac's card. Each arm gets a shuffled letter (A, B, C), so the card never
 * shows which result came from which model until he picks.
 *
 * Journal contract (`<agent>/<name>`; Relay Host and Desktop read these without importing this package):
 * `trial.started` -> one `trial.result` per arm as it finishes -> `trial.picked` (Relay Host, on Isaac's tap) ->
 * maybe `trial.switched` (the service: a clear winner) -> maybe `trial.undone` + `atomic-agents/config.set` (Relay
 * Host, on Undo). `trial.retrial` notes a fresh trial for a new model. The tally and the switch run in
 * `TrialService.ts` (lifecycle machine `trial.machine.ts`); everything here is pure.
 */

export const LETTERS = ["A", "B", "C"] as const;
export type Letter = (typeof LETTERS)[number];
export const Letter = Schema.Literals(LETTERS);
export const PickValue = Schema.Literals([...LETTERS, "unsure"]);
export type PickValue = typeof PickValue.Type;

const Arm = Schema.Struct({
  letter: Letter,
  model: Schema.String,
  /** The model's short name (`Sonnet 5.5`), revealed after the pick. */
  label: Schema.String,
  /** The run on the agent's own model: the one that answered the caller. */
  default: Schema.Boolean,
});
export type Arm = typeof Arm.Type;

/** `data` of each trial event. */
export const trialEvents = {
  "trial.started": Schema.Struct({
    trialId: Schema.String,
    requestId: Schema.optionalKey(Schema.String),
    caller: Schema.optionalKey(Schema.String),
    job: Schema.String,
    /** The request on one line. */
    request: Schema.String,
    arms: Schema.Array(Arm),
  }),
  "trial.result": Schema.Struct({
    trialId: Schema.String,
    letter: Letter,
    model: Schema.String,
    ok: Schema.Boolean,
    /** The result as Markdown for the card; never names the model. */
    preview: Schema.optionalKey(Schema.String),
    error: Schema.optionalKey(Schema.String),
    seconds: Schema.Number,
    cost: Schema.optionalKey(Schema.Number),
  }),
  "trial.picked": Schema.Struct({
    trialId: Schema.String,
    pick: PickValue,
    surface: Schema.optionalKey(Schema.String),
    by: Schema.optionalKey(Schema.String),
  }),
  "trial.switched": Schema.Struct({
    switchId: Schema.String,
    trialId: Schema.optionalKey(Schema.String),
    from: Schema.String,
    to: Schema.String,
    fromLabel: Schema.String,
    toLabel: Schema.String,
    /** The winner was already the agent's model: nothing switched, the trial ended. */
    kept: Schema.Boolean,
    wins: Schema.Number,
    of: Schema.Number,
    over: Schema.Array(Schema.String),
    overLabels: Schema.Array(Schema.String),
    text: Schema.String,
    /** config.json merge patch that undoes it (the `config.changed` undo); Relay Host sends it back as `config.set`. */
    undo: Schema.Record(Schema.String, Schema.Json),
  }),
  "trial.undone": Schema.Struct({ switchId: Schema.String }),
  "trial.retrial": Schema.Struct({
    models: Schema.Array(Schema.String),
    arms: Schema.Array(Schema.String),
    reason: Schema.String,
  }),
} as const;
export type TrialEvent = keyof typeof trialEvents;
export type TrialStarted = (typeof trialEvents)["trial.started"]["Type"];
export type TrialResult = (typeof trialEvents)["trial.result"]["Type"];
export type TrialSwitched = (typeof trialEvents)["trial.switched"]["Type"];

/** Fisher-Yates over `values` with `random` in [0, 1). */
export const shuffle = <T>(values: ReadonlyArray<T>, random: () => number): T[] => {
  const out = [...values];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
};

/** The arms of one trial: each model gets a random letter; `models[0]` is the agent's own model (the default). */
export const armsOf = (
  models: ReadonlyArray<string>,
  defaultModel: string,
  random: () => number,
  label: (model: string) => string,
): Arm[] => {
  const letters = shuffle(LETTERS.slice(0, models.length), random);
  return models
    .map((model, index) => ({
      letter: letters[index]!,
      model,
      label: label(model),
      default: model === defaultModel,
    }))
    .sort((a, b) => a.letter.localeCompare(b.letter));
};

/** A trial arm's input: the caller's `requestId` swapped for the arm's own, so the arm never answers the caller. */
export const armInput = (input: unknown, trialId: string, letter: string): unknown =>
  isObject(input) && typeof input["requestId"] === "string"
    ? { ...input, requestId: `trial-${trialId.slice(0, 8)}-${letter}` }
    : input;

const REQUEST_FIELDS = [
  "description",
  "brief",
  "query",
  "subject",
  "intent",
  "question",
  "prompt",
  "url",
];

/** The request on one line for the card and the bench. */
export const requestLine = (input: unknown): string => {
  const one = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, 300);
  if (typeof input === "string") return one(input);
  if (!isObject(input)) return "";
  for (const field of REQUEST_FIELDS) {
    const value = input[field];
    if (typeof value === "string" && value.trim() !== "") return one(value);
  }
  const { requestId: _, ...rest } = input;
  return one(JSON.stringify(rest));
};

/**
 * A result as Markdown for the card: its image, score, text or summary, findings and sounds, whichever it has. It
 * never prints the reply's `model` or other bookkeeping, so the card stays blind.
 */
export const previewOf = (reply: unknown, show?: (reply: unknown) => string): string => {
  if (typeof reply === "string") return reply.slice(0, 8000);
  if (!isObject(reply)) return "";
  const parts: string[] = [];
  if (typeof reply["image"] === "string" && reply["image"] !== "")
    parts.push(`![](<${reply["image"]}>)`);
  if (typeof reply["score"] === "number") parts.push(`**${reply["score"]}/10**`);
  const text = [reply["text"], reply["summary"]].find(
    (value): value is string => typeof value === "string" && value.trim() !== "",
  );
  if (text !== undefined) parts.push(text);
  if (Array.isArray(reply["findings"])) {
    const lines = reply["findings"]
      .filter(isObject)
      .slice(0, 5)
      .map((finding) => {
        const what = [finding["rule"], finding["fix"]]
          .filter((v) => typeof v === "string")
          .join(": ");
        return `- ${what}`;
      });
    if (lines.length > 0) parts.push(lines.join("\n"));
  }
  if (Array.isArray(reply["sounds"])) {
    const lines = reply["sounds"].filter(isObject).map((sound, index) => {
      const about = [
        sound["library"],
        typeof sound["duration"] === "number" ? `${sound["duration"]} s` : undefined,
      ]
        .filter((v) => typeof v === "string" && v !== "")
        .join(", ");
      return `${index + 1}. ${String(sound["title"] ?? sound["id"] ?? "")}${about === "" ? "" : ` (${about})`}`;
    });
    if (lines.length > 0) parts.push(lines.join("\n"));
  }
  if (parts.length === 0 && show !== undefined) {
    const shown = show(reply);
    if (shown !== "none") parts.push(shown);
  }
  return parts.join("\n\n").slice(0, 8000);
};

const words = (text: string) =>
  text
    .split(/[-_\s]+/)
    .filter((word) => word !== "")
    .map((word) => (/^[a-z]/.test(word) ? word.charAt(0).toUpperCase() + word.slice(1) : word));

/**
 * A model's short name as Isaac reads it: the provider catalog's name without the vendor (`Claude Sonnet 5.5` ->
 * `Sonnet 5.5`, `GPT-6.1-Sol` -> `GPT-6.1 Sol`), else one made from the id (`openrouter/moonshotai/kimi-k3.1-pro` ->
 * `Kimi K3.1 Pro`).
 */
export const modelLabel = (model: string, catalogName?: string): string => {
  if (catalogName !== undefined && catalogName.trim() !== "")
    return catalogName
      .replace(/^Claude\s+/, "")
      .replace(/^(GPT-[\d.]+)-/, "$1 ")
      .trim();
  const id = model.split("/").pop() ?? model;
  if (/^gpt-/i.test(id)) {
    const [, version, ...rest] = id.split("-");
    return [`GPT-${version ?? ""}`, ...words(rest.join("-"))].join(" ").trim();
  }
  const parts = id.replace(/^claude-/, "").split("-");
  const out: string[] = [];
  for (const part of parts) {
    const last = out[out.length - 1];
    // `5-5` is version 5.5: join a number onto the number before it.
    if (
      /^\d+$/.test(part) &&
      last !== undefined &&
      /^\d+(\.\d+)?$/.test(last) &&
      !last.includes(".")
    )
      out[out.length - 1] = `${last}.${part}`;
    else out.push(part);
  }
  return words(out.join(" ")).join(" ");
};

/** `diagram` -> `Diagram`, `design-critic` -> `Design critic` (Relay's `agentLabel`). */
export const agentTitle = (id: string): string => {
  const text = id.replace(/[-_]+/g, " ").trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
};

/** A model line without its version: `openai-codex/gpt-6.2-sol` and `openai-codex/gpt-6-sol` are both `openai-codex/gpt sol`. */
export const family = (model: string): string => {
  const [head, ...rest] = model.split("/");
  const id = rest.join("/");
  const kept = id
    .split(/[-_]/)
    .filter((part) => !/^v?\d+(\.\d+)*[a-z]?$/i.test(part) && !/^\d{8}$/.test(part));
  return `${head}/${kept.join(" ")}`;
};

/**
 * The new models a trial agent should try, best first: only providers its models already use (a new OpenAI model for
 * an agent that runs OpenAI or Anthropic models), and new versions of its own model lines (`gpt-6.2-sol` for an agent
 * with `gpt-6-sol`) ahead of the rest.
 */
export const relevantModels = (
  agentModels: ReadonlyArray<string>,
  fresh: ReadonlyArray<string>,
): string[] => {
  const providerOf = (model: string) => model.split("/")[0] ?? model;
  const providers = new Set(agentModels.map(providerOf));
  const families = new Set(agentModels.map(family));
  const usable = fresh.filter(
    (model) => providers.has(providerOf(model)) && !agentModels.includes(model),
  );
  return [
    ...usable.filter((model) => families.has(family(model))),
    ...usable.filter((model) => !families.has(family(model))),
  ];
};

/** One pick that counts toward a trial: the model that won, or null for "can't tell". */
export interface CountedPick {
  readonly at: number;
  readonly winner: string | null;
}

export interface Decision {
  readonly winner: string;
  readonly wins: number;
  /** The picks it is judged on: the last 10 (`window`), or all of this trial's (`lead`). */
  readonly of: number;
  readonly rule: "window" | "lead";
}

/** Picks to look back on for "about 8 of the last 10". */
export const WINDOW = 10;
export const WINDOW_WINS = 8;
/** "A clear lead after 15-20 picks": from 15 picks on, at least twice the runner-up's wins and 5 more. */
export const LEAD_AFTER = 15;
export const LEAD_MARGIN = 5;

const tally = (picks: ReadonlyArray<CountedPick>) => {
  const wins = new Map<string, number>();
  for (const pick of picks)
    if (pick.winner !== null) wins.set(pick.winner, (wins.get(pick.winner) ?? 0) + 1);
  return [...wins.entries()].sort((a, b) => b[1] - a[1]);
};

/**
 * Is one model clearly winning? About 8 of the last 10 picks, else (from 15 picks) a clear lead: twice the
 * runner-up's wins and at least 5 more. "Can't tell" counts as a pick nobody won. Undefined while it is open.
 */
export const clearWinner = (picks: ReadonlyArray<CountedPick>): Decision | undefined => {
  if (picks.length >= WINDOW) {
    const [top] = tally(picks.slice(-WINDOW));
    if (top !== undefined && top[1] >= WINDOW_WINS)
      return { winner: top[0], wins: top[1], of: WINDOW, rule: "window" };
  }
  if (picks.length >= LEAD_AFTER) {
    const [top, second] = tally(picks);
    const runnerUp = second?.[1] ?? 0;
    if (top !== undefined && top[1] >= 2 * runnerUp && top[1] - runnerUp >= LEAD_MARGIN)
      return { winner: top[0], wins: top[1], of: picks.length, rule: "lead" };
  }
  return undefined;
};

/** The agent's own message: `Diagram: switched to Sonnet 5.5, won 8 of your last 10 picks over Opus 5.5 and GPT-6.1 Sol`. */
export const switchText = (
  agent: string,
  decision: Decision,
  toLabel: string,
  overLabels: ReadonlyArray<string>,
  kept: boolean,
): string => {
  const picks =
    decision.rule === "window" ? `your last ${decision.of} picks` : `your ${decision.of} picks`;
  const over =
    overLabels.length === 0
      ? ""
      : ` over ${overLabels.length === 1 ? overLabels[0] : `${overLabels.slice(0, -1).join(", ")} and ${overLabels[overLabels.length - 1]}`}`;
  return kept
    ? `${agentTitle(agent)}: staying on ${toLabel}, it won ${decision.wins} of ${picks}${over}. Trial over.`
    : `${agentTitle(agent)}: switched to ${toLabel}, won ${decision.wins} of ${picks}${over}`;
};

/** One chat model the provider catalog lists (`omp models --json`): the id omp runs it by, and its display name. */
export const CatalogModel = Schema.Struct({
  selector: Schema.String,
  name: Schema.String,
  provider: Schema.String,
});
export type CatalogModel = typeof CatalogModel.Type;
/** `<home>/state/trials/catalog.json`: the catalog as last seen, so a model that appears later is new. */
export const CatalogFile = Schema.Struct({
  checkedAt: Schema.String,
  models: Schema.Array(CatalogModel),
});
export const decodeCatalog = Schema.decodeUnknownOption(Schema.fromJsonString(CatalogFile));

/** Order-free key of a trial's models: picks count toward the trial only while its models are the same. */
export const armsKey = (models: ReadonlyArray<string>) => [...models].sort().join(",");

/** A journal line as the trial rules read it. */
interface Dated {
  readonly type: string;
  readonly at: string;
}

/** When this agent's count last started over: its last switch, undo or re-trial (0 when none). */
export const epochOf = (history: ReadonlyArray<Dated>, agent: string) =>
  Math.max(
    0,
    ...history
      .filter((event) =>
        [`${agent}/trial.switched`, `${agent}/trial.undone`, `${agent}/trial.retrial`].includes(
          event.type,
        ),
      )
      .map((event) => Date.parse(event.at)),
  );

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whether a caller's request may start a trial at `now`, and why not. */
export interface TrialAllowance {
  /** `trial.started` in the 24 hours before `now`. */
  readonly today: number;
  readonly perDay: number;
  /** Trials offered `idleDays` or more since the epoch with no pick in the last `idleDays`. */
  readonly idle: boolean;
  /** `idle` or `budget` (today reached perDay) when the request runs once, without arms. */
  readonly stop?: "idle" | "budget";
}

/**
 * The trial bounds (`Settings.effective(...).trial` `perDay`, `idleDays`) over the journal: at most `perDay` trials
 * started in any 24 hours, and none once trials have been offered `idleDays` since the agent's epoch (`epochOf`: its
 * first `trial.started` after its last switch, undo or re-trial) without a `trial.picked` in the last `idleDays`. A pick,
 * switch or re-trial lifts the idle stop.
 */
export const trialAllowance = (
  history: ReadonlyArray<Dated>,
  agent: string,
  limits: { readonly perDay: number; readonly idleDays: number },
  now: number,
): TrialAllowance => {
  const epoch = epochOf(history, agent);
  const started = history
    .filter((event) => event.type === `${agent}/trial.started`)
    .map((event) => Date.parse(event.at));
  const today = started.filter((at) => at <= now && now - at < DAY_MS).length;
  const offeredSince = Math.min(...started.filter((at) => at >= epoch));
  const lastPick = Math.max(
    -Infinity,
    ...history
      .filter((event) => event.type === `${agent}/trial.picked`)
      .map((event) => Date.parse(event.at)),
  );
  const idleMs = limits.idleDays * DAY_MS;
  const idle = now - offeredSince >= idleMs && now - lastPick >= idleMs;
  const stop = idle ? "idle" : today >= limits.perDay ? "budget" : undefined;
  return { today, perDay: limits.perDay, idle, ...(stop === undefined ? {} : { stop }) };
};
