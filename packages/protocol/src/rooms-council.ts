// Rooms effort dial: the notch ladder, seat casting, routing by model strength and the cost and
// time estimate. Pure data and functions (no zod, no I/O) shared by Relay Desktop (main and
// renderer), Relay Host and the phone, so every surface shows the same numbers.
// Spec: Eva work/relay-rooms-council/SPEC.md (v2 + Decisions 2026-11-10).

export type CouncilProvider = "anthropic" | "openai";
export type CouncilHarness = "omp" | "claude-code" | "codex";
export type CouncilThinking = "medium" | "high" | "xhigh" | "max";
export type CouncilRole = "integrator" | "builder" | "look" | "director" | "critic" | "researcher" | "judge";
export type CouncilModelKey = "fable-5.2" | "opus-5.5" | "sonnet-5.5" | "astra-6" | "sol-6.1";
/** What a logged turn did; one routing.jsonl line per turn carries one. */
export type CouncilTurnKind = "code" | "params" | "merge" | "image" | "critique" | "score" | "research" | "plan" | "talk";

export interface CouncilModel {
  key: CouncilModelKey;
  name: string;
  /** Short name for tight rows: "Opus", "Sol". */
  short: string;
  provider: CouncilProvider;
  /** omp `--model` selector. */
  omp: string;
  /** Claude Code `--model` (Anthropic only) or Codex `-m` (OpenAI only). */
  native: string;
  /** List $ per million tokens (omp models --json, 2026-11-10): input, output, cached input. */
  price: { input: number; output: number; cached: number };
}

export const COUNCIL_MODELS: Record<CouncilModelKey, CouncilModel> = {
  "fable-5.2": { key: "fable-5.2", name: "Fable 5.2", short: "Fable", provider: "anthropic", omp: "anthropic/claude-fable-5-2", native: "claude-fable-5-2", price: { input: 10, output: 50, cached: 1 } },
  "opus-5.5": { key: "opus-5.5", name: "Opus 5.5", short: "Opus", provider: "anthropic", omp: "anthropic/claude-opus-5-5", native: "claude-opus-5-5", price: { input: 4, output: 20, cached: 0.2 } },
  "sonnet-5.5": { key: "sonnet-5.5", name: "Sonnet 5.5", short: "Sonnet", provider: "anthropic", omp: "anthropic/claude-sonnet-5-5", native: "claude-sonnet-5-5", price: { input: 2, output: 10, cached: 0.2 } },
  "astra-6": { key: "astra-6", name: "GPT-6 Astra", short: "Astra", provider: "openai", omp: "openai-codex/gpt-6-astra", native: "gpt-6-astra", price: { input: 10, output: 50, cached: 1 } },
  "sol-6.1": { key: "sol-6.1", name: "GPT-6.1 Sol", short: "Sol", provider: "openai", omp: "openai-codex/gpt-6.1-sol", native: "gpt-6.1-sol", price: { input: 2, output: 10, cached: 0.1 } },
};

export const COUNCIL_HARNESS_LABEL: Record<CouncilHarness, string> = { omp: "omp", "claude-code": "Claude Code", codex: "Codex CLI" };
export const COUNCIL_THINKING_LABEL: Record<CouncilThinking, string> = { medium: "Medium", high: "High", xhigh: "Extra high", max: "Max" };
export const COUNCIL_ROLE_LABEL: Record<CouncilRole, string> = {
  integrator: "integrator", builder: "builder", look: "look", director: "art director", critic: "critic", researcher: "researcher", judge: "judge",
};
/** What each role does, for the routing pickers. */
export const COUNCIL_ROUTE_LABEL: Record<CouncilRole, string> = {
  integrator: "Contract, merges, full renders",
  builder: "Procedural modeling code + params",
  researcher: "Research and tooling",
  look: "Look: param values, part renders",
  director: "Image gen, art direction",
  critic: "Visual critique",
  judge: "Scoring renders",
};
export const COUNCIL_ROLES: CouncilRole[] = ["integrator", "builder", "researcher", "look", "director", "critic", "judge"];

/** Default routing by model strength: code and integration to Anthropic, the visual side to OpenAI. */
export type CouncilRouting = Record<CouncilRole, CouncilProvider>;
export const COUNCIL_DEFAULT_ROUTING: CouncilRouting = {
  integrator: "anthropic", builder: "anthropic", researcher: "anthropic",
  look: "openai", director: "openai", critic: "openai", judge: "openai",
};
/** An override moves a seat to the other family at the same tier, and to the matching harness. */
const MODEL_FLIP: Record<CouncilModelKey, CouncilModelKey> = {
  "fable-5.2": "astra-6", "astra-6": "fable-5.2", "opus-5.5": "sol-6.1", "sol-6.1": "opus-5.5", "sonnet-5.5": "sol-6.1",
};
const HARNESS_FLIP: Record<CouncilHarness, CouncilHarness> = { "claude-code": "codex", codex: "claude-code", omp: "omp" };

/** Seat people per role, in casting order (first builder is Ada, second Kenji, ...). */
export const COUNCIL_PEOPLE: Record<CouncilRole, { name: string; title: string; color: string }[]> = {
  integrator: [{ name: "Theo Lindqvist", title: "Integrator", color: "cyan" }],
  builder: [
    { name: "Ada Brandt", title: "Builder", color: "blue" },
    { name: "Kenji Mori", title: "Builder", color: "indigo" },
    { name: "Lena Fischer", title: "Builder", color: "blue" },
    { name: "Omar Haddad", title: "Builder", color: "indigo" },
    { name: "Bea Santos", title: "Builder", color: "blue" },
    { name: "Nils Berg", title: "Builder", color: "indigo" },
  ],
  look: [
    { name: "Iris Chen", title: "Look artist", color: "yellow" },
    { name: "Dev Patel", title: "Look artist", color: "orange" },
    { name: "Rina Holt", title: "Look artist", color: "yellow" },
    { name: "Cleo Marsh", title: "Look artist", color: "orange" },
  ],
  director: [{ name: "Mara Voss", title: "Art director", color: "pink" }],
  critic: [{ name: "Sam Okafor", title: "Critic", color: "red" }, { name: "Yara Cole", title: "Critic", color: "red" }],
  researcher: [{ name: "Priya Natarajan", title: "Researcher", color: "teal" }],
  judge: [{ name: "Jonah Reyes", title: "Judge", color: "grape" }],
};

/** Parts by split size. Team: 2 parts; Council and up: 4. */
export const COUNCIL_PARTS_2 = ["Head + hands", "Body + legs"] as const;
export const COUNCIL_PARTS_4 = ["Head", "Body", "Hands", "Legs + pants"] as const;
export const COUNCIL_WHOLE = "Whole";
/** Which fine parts a coarse part covers, so rubric owners map onto the parts in play. */
export const COUNCIL_SUBPARTS: Record<string, string[]> = {
  "Head + hands": ["Head", "Hands"],
  "Body + legs": ["Body", "Legs + pants"],
  Whole: ["Head", "Body", "Hands", "Legs + pants"],
};

/** [role, model, thinking, harness, part?, branch?] */
type SeatRow = [CouncilRole, CouncilModelKey, CouncilThinking, CouncilHarness, string?, ("A" | "B")?];

export interface CouncilNotchDef {
  /** 1..6 */
  effort: number;
  name: string;
  level: string;
  /** Round cap (the judge can stop earlier on convergence). */
  rounds: number;
  parts: readonly string[];
  /** Parts with two competing builders (Max). */
  branched?: readonly string[];
  seats: SeatRow[];
  /** One plain sentence under the dial. */
  blurb: string;
}

const P4 = COUNCIL_PARTS_4;
export const COUNCIL_NOTCHES: CouncilNotchDef[] = [
  {
    effort: 1, name: "Solo", level: "Low", rounds: 1, parts: [COUNCIL_WHOLE],
    seats: [["builder", "opus-5.5", "medium", "omp", COUNCIL_WHOLE]],
    blurb: "One model builds the whole thing and checks itself against the rubric. Cheapest; no second opinion.",
  },
  {
    effort: 2, name: "Pair", level: "Medium", rounds: 2, parts: [COUNCIL_WHOLE],
    seats: [["builder", "opus-5.5", "high", "claude-code", COUNCIL_WHOLE], ["director", "astra-6", "high", "codex"]],
    blurb: "Claude Code builds the whole thing and exposes params; Astra in Codex directs the look, critiques and scores.",
  },
  {
    effort: 3, name: "Team", level: "High", rounds: 3, parts: COUNCIL_PARTS_2,
    seats: [
      ["integrator", "opus-5.5", "high", "omp"],
      ["builder", "sonnet-5.5", "high", "claude-code", "Head + hands"],
      ["builder", "sonnet-5.5", "high", "omp", "Body + legs"],
      ["director", "astra-6", "high", "codex"],
      ["judge", "sol-6.1", "high", "omp"],
    ],
    blurb: "Default. Two parts built in parallel by Claude Code and omp, an integrator owns the contract and merges, Astra directs the look, Sol scores.",
  },
  {
    effort: 4, name: "Council", level: "Extra high", rounds: 4, parts: P4,
    seats: [
      ["integrator", "fable-5.2", "xhigh", "omp"],
      ["builder", "opus-5.5", "xhigh", "claude-code", "Head"],
      ["builder", "opus-5.5", "high", "omp", "Body"],
      ["builder", "sonnet-5.5", "high", "claude-code", "Hands"],
      ["builder", "sonnet-5.5", "high", "omp", "Legs + pants"],
      ["director", "astra-6", "xhigh", "codex"],
      ["critic", "sol-6.1", "xhigh", "codex"],
      ["judge", "sol-6.1", "xhigh", "omp"],
    ],
    blurb: "Four parts in parallel, each by its own builder; Fable integrates; Astra directs, Sol critiques in Codex and scores in omp.",
  },
  {
    effort: 5, name: "Summit", level: "Extra high", rounds: 5, parts: P4,
    seats: [
      ["integrator", "fable-5.2", "xhigh", "omp"],
      ["builder", "opus-5.5", "xhigh", "claude-code", "Head"],
      ["builder", "opus-5.5", "xhigh", "omp", "Body"],
      ["builder", "sonnet-5.5", "high", "claude-code", "Hands"],
      ["builder", "sonnet-5.5", "xhigh", "omp", "Legs + pants"],
      ["look", "astra-6", "high", "codex", "Head"],
      ["look", "sol-6.1", "high", "codex", "Body"],
      ["look", "sol-6.1", "high", "omp", "Hands"],
      ["look", "sol-6.1", "high", "codex", "Legs + pants"],
      ["director", "astra-6", "xhigh", "codex"],
      ["researcher", "sonnet-5.5", "high", "claude-code"],
      ["judge", "sol-6.1", "xhigh", "omp"],
    ],
    blurb: "Each part gets a GPT look seat that tunes the builder's params and renders the part; a researcher joins.",
  },
  {
    // Decision 2026-11-10: Max is capped at 5 rounds.
    effort: 6, name: "Max", level: "Max", rounds: 5, parts: P4, branched: ["Head", "Legs + pants"],
    seats: [
      ["integrator", "fable-5.2", "max", "omp"],
      ["builder", "opus-5.5", "max", "claude-code", "Head", "A"],
      ["builder", "fable-5.2", "max", "omp", "Head", "B"],
      ["builder", "opus-5.5", "max", "omp", "Body"],
      ["builder", "sonnet-5.5", "max", "claude-code", "Hands"],
      ["builder", "sonnet-5.5", "max", "omp", "Legs + pants", "A"],
      ["builder", "opus-5.5", "max", "claude-code", "Legs + pants", "B"],
      ["look", "astra-6", "max", "codex", "Head"],
      ["look", "sol-6.1", "max", "codex", "Body"],
      ["look", "sol-6.1", "max", "omp", "Hands"],
      ["look", "sol-6.1", "max", "codex", "Legs + pants"],
      ["director", "astra-6", "max", "codex"],
      ["researcher", "sonnet-5.5", "xhigh", "claude-code"],
      ["judge", "sol-6.1", "max", "omp"],
    ],
    blurb: "Max thinking everywhere. Head and legs + pants each get two competing builders in different harnesses; the judge keeps one per part after round 2.",
  },
];
/** Decision 2026-11-10: Team is the default notch. */
export const COUNCIL_DEFAULT_EFFORT = 3;
export const COUNCIL_MIN_EFFORT = 1;
export const COUNCIL_MAX_EFFORT = COUNCIL_NOTCHES.length;
/** Decision 2026-11-10: one generated image per round (art director), and one in the contract phase. */
export const COUNCIL_IMAGES_PER_ROUND = 1;
/** List price of one high-quality 1024 px generated image. */
export const COUNCIL_IMAGE_USD = 0.17;
/** Hard cap = estimate x this; the room pauses at 80 % of the cap. */
export const COUNCIL_CAP_FACTOR = 1.5;
export const COUNCIL_PAUSE_AT = 0.8;
/** Converge when every criterion reaches this. */
export const COUNCIL_TARGET_SCORE = 8;
/** A total gain below this for two rounds is a plateau. */
export const COUNCIL_PLATEAU = 0.5;

/**
 * The cap a resumed room runs under. Below the pause line the cap stays; at or past it, Resume
 * is Isaac's tap to go on (as Continue at the pause): one more estimate on top of the higher of
 * the cap and the spend.
 */
export function councilResumeCap(spend: { usd: number; estimate: number; cap: number }): number {
  if (spend.usd < COUNCIL_PAUSE_AT * spend.cap) return spend.cap;
  return Math.round((Math.max(spend.usd, spend.cap) + spend.estimate) * 100) / 100;
}

export interface CouncilSeat {
  /** Stable seat id inside a room: `<role>-<n>` (`builder-2`). */
  id: string;
  role: CouncilRole;
  model: CouncilModelKey;
  thinking: CouncilThinking;
  harness: CouncilHarness;
  part?: string | undefined;
  branch?: "A" | "B" | undefined;
  /** Moved off its default family by a routing override. */
  override: boolean;
  name: string;
  title: string;
  color: string;
}

export interface CouncilCast {
  effort: number;
  notch: CouncilNotchDef;
  seats: CouncilSeat[];
  parts: string[];
  split: boolean;
  /** List-price estimate in USD, its range (0.6x to 1.6x) and the hard cap. */
  cost: number;
  costLow: number;
  costHigh: number;
  cap: number;
  /** Estimated minutes and range (0.6x to 1.5x). */
  minutes: number;
  minutesLow: number;
  minutesHigh: number;
  providers: number;
  harnesses: number;
  /** Roles present in this cast, in COUNCIL_ROLES order. */
  roles: CouncilRole[];
  /** Roles whose provider differs from the default routing. */
  overrides: CouncilRole[];
}

// Cost model, same as SPEC.md "Cost model": per turn kind, input tokens (85 % cached) and output
// tokens by thinking level; minutes per turn kind by thinking level.
export type CouncilCostKind = "build" | "part" | "integrate" | "look" | "talk";
type TurnKind = CouncilCostKind;
const OUT: Record<TurnKind, Record<CouncilThinking, number>> = {
  build: { medium: 4e3, high: 8e3, xhigh: 14e3, max: 22e3 },
  part: { medium: 3e3, high: 6e3, xhigh: 10e3, max: 16e3 },
  integrate: { medium: 3e3, high: 5e3, xhigh: 8e3, max: 12e3 },
  look: { medium: 2e3, high: 4e3, xhigh: 6e3, max: 9e3 },
  talk: { medium: 1.5e3, high: 3e3, xhigh: 5e3, max: 8e3 },
};
const IN: Record<TurnKind, number> = { build: 80e3, part: 50e3, integrate: 90e3, look: 45e3, talk: 35e3 };
const CACHED = 0.85;
const MIN: Record<TurnKind, Record<CouncilThinking, number>> = {
  build: { medium: 4, high: 6, xhigh: 8, max: 11 },
  part: { medium: 3, high: 4, xhigh: 6, max: 8 },
  integrate: { medium: 2, high: 3, xhigh: 4, max: 5 },
  look: { medium: 2, high: 3, xhigh: 4, max: 5 },
  talk: { medium: 1, high: 1.5, xhigh: 2.5, max: 3.5 },
};

/** List price of one turn of a kind, for estimates. */
export function councilTurnCost(model: CouncilModelKey, kind: TurnKind, thinking: CouncilThinking): number {
  const p = COUNCIL_MODELS[model].price;
  const inp = IN[kind];
  return (inp * CACHED * p.cached + inp * (1 - CACHED) * p.input + OUT[kind][thinking] * p.output) / 1e6;
}

/** List price of real usage (what a harness reported for one turn). */
export function councilUsageCost(model: CouncilModelKey, usage: { input: number; output: number; cached: number }): number {
  const p = COUNCIL_MODELS[model].price;
  return (usage.input * p.input + usage.cached * p.cached + usage.output * p.output) / 1e6;
}

function seatRound(s: CouncilSeat, split: boolean): number {
  const t = (k: TurnKind, x = 1) => x * councilTurnCost(s.model, k, s.thinking);
  switch (s.role) {
    case "builder": return t(split ? "part" : "build") + t("talk", 0.5);
    case "integrator": return t("integrate") + t("talk");
    case "look": return t("look");
    case "director": return t("talk") + COUNCIL_IMAGES_PER_ROUND * COUNCIL_IMAGE_USD;
    case "researcher": return t("talk", 0.5);
    default: return t("talk");
  }
}

export function councilNotch(effort: number): CouncilNotchDef {
  const i = Math.max(COUNCIL_MIN_EFFORT, Math.min(COUNCIL_MAX_EFFORT, Math.round(effort))) - 1;
  return COUNCIL_NOTCHES[i]!;
}

/** "Team · High" (or just "Max" when the names match). */
export function councilLabel(effort: number): string {
  const n = councilNotch(effort);
  return n.name === n.level ? n.name : `${n.name} · ${n.level}`;
}

/** Casts a notch under a routing (default routing when omitted) and prices it. */
export function councilCast(effort: number, routing: Partial<CouncilRouting> = {}): CouncilCast {
  const notch = councilNotch(effort);
  const route: CouncilRouting = { ...COUNCIL_DEFAULT_ROUTING, ...routing };
  const used: Partial<Record<CouncilRole, number>> = {};
  const split = notch.parts.length > 1;
  const seats: CouncilSeat[] = notch.seats.map(([role, model0, thinking, harness0, part, branch]) => {
    const flip = COUNCIL_MODELS[model0].provider !== route[role];
    const model = flip ? MODEL_FLIP[model0] : model0;
    const harness = flip ? HARNESS_FLIP[harness0] : harness0;
    const n = (used[role] = (used[role] ?? 0) + 1);
    const person = COUNCIL_PEOPLE[role][n - 1] ?? COUNCIL_PEOPLE[role][0]!;
    return {
      id: `${role}-${n}`, role, model, thinking, harness, part, branch, override: flip,
      name: person.name, title: person.title, color: person.color,
    };
  });
  // Without a judge seat the director (Pair) or the builder (Solo) also scores: one more talk turn a round.
  const scorer = seats.some((s) => s.role === "judge") ? undefined : seats.find((s) => s.role === "director") ?? seats[0];
  const perRound = seats.reduce((a, s) => a + seatRound(s, split), 0)
    + (scorer ? councilTurnCost(scorer.model, "talk", scorer.thinking) : 0);
  const integ = seats.find((s) => s.role === "integrator");
  const dir = seats.find((s) => s.role === "director");
  const setup = split && integ
    ? councilTurnCost(integ.model, "integrate", integ.thinking)
      + (dir ? councilTurnCost(dir.model, "talk", dir.thinking) + COUNCIL_IMAGE_USD : 0)
      + seats.filter((s) => s !== integ && s !== dir).reduce((a, s) => a + 0.3 * councilTurnCost(s.model, "talk", s.thinking), 0)
    : seats.reduce((a, s) => a + councilTurnCost(s.model, "talk", s.thinking), 0) + (dir ? COUNCIL_IMAGE_USD : 0);
  const wrap = seats.reduce((a, s) => a + 0.4 * councilTurnCost(s.model, "talk", s.thinking), 0);
  const cost = perRound * notch.rounds + setup + wrap;
  const mx = (role: CouncilRole, kind: TurnKind) =>
    Math.max(0, ...seats.filter((s) => s.role === role).map((s) => MIN[kind][s.thinking]));
  const roundMin = mx("builder", split ? "part" : "build") + (split ? mx("integrator", "integrate") : 0) + mx("look", "look")
    + Math.max(0, ...seats.filter((s) => s.role === "director" || s.role === "critic" || s.role === "judge").map((s) => MIN.talk[s.thinking]))
    + 1;
  const minutes = Math.round(roundMin * notch.rounds + (split ? 4 : 2) + 2);
  const roles = COUNCIL_ROLES.filter((r) => seats.some((s) => s.role === r));
  return {
    effort: notch.effort, notch, seats, parts: [...notch.parts], split,
    cost, costLow: cost * 0.6, costHigh: cost * 1.6, cap: cost * COUNCIL_CAP_FACTOR,
    minutes, minutesLow: Math.round(minutes * 0.6), minutesHigh: Math.round(minutes * 1.5),
    providers: new Set(seats.map((s) => COUNCIL_MODELS[s.model].provider)).size,
    harnesses: new Set(seats.map((s) => s.harness)).size,
    roles,
    overrides: roles.filter((r) => route[r] !== COUNCIL_DEFAULT_ROUTING[r]),
  };
}

/** The owner part a rubric criterion lands on for this split: "Head" -> "Head + hands" at Team. */
export function councilOwnerPart(owner: string, parts: readonly string[]): string {
  if (owner === "Integrator" || owner === "Look") return owner;
  if (parts.length <= 1) return COUNCIL_WHOLE;
  return parts.find((p) => p === owner || (COUNCIL_SUBPARTS[p] ?? []).includes(owner)) ?? owner;
}

/** "$0.34" under $10, "$12" above. */
export const councilMoney = (v: number): string => (v < 10 ? `$${v.toFixed(2)}` : `$${Math.round(v)}`);
/** "~$4.2", "~$0.30", "~$12". */
export const councilApprox = (v: number): string =>
  v < 10 ? `~$${(Math.round(v * 10) / 10).toFixed(v < 1 ? 2 : 1)}` : `~$${Math.round(v)}`;
/** "~35 min", "~2.4 h". */
export const councilTime = (m: number): string => (m >= 90 ? `~${Math.round(m / 6) / 10} h` : `~${m} min`);
/** The dial chip: "Team · High · 2 parts · ~$4.2". */
export function councilChip(c: CouncilCast): string {
  return `${councilLabel(c.effort)} · ${c.split ? `${c.parts.length} parts · ` : ""}${councilApprox(c.cost)}`;
}
/** "Opus 5.5 · Claude Code". */
export const councilSeatLine = (s: Pick<CouncilSeat, "model" | "harness">): string =>
  `${COUNCIL_MODELS[s.model].name} · ${COUNCIL_HARNESS_LABEL[s.harness]}`;
