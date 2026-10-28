/**
 * Animated DiceBear portrait rigs (ported from ~/Eva/work/avatar-animation/rig.mjs). A rig pins
 * every part the seed chose plus the portrait's designed options, splits the SVG into its
 * top-level part groups, tags each with a role (body / head / mouth / eyes / brows / gesture), and
 * precomputes the few variant strings the states swap in. Abstract expressions ("open mouth",
 * "thinking brows") map to per-style variant names, with per-seed rules where a seed's resting
 * parts collide with a pick. Pure strings: no DOM, so it runs in React Native too.
 */
import { createAvatar, type Style } from "@dicebear/core";
import * as micah from "@dicebear/micah";
import * as notionists from "@dicebear/notionists";
import { parseTransform, type Affine } from "./affine";
import { centre } from "./bbox";

export type PortraitStyle = "notionists" | "micah";

/** An assistant's portrait: Relay's `AssistantPortrait` and the desktop contract's, structurally. */
export interface Portrait {
  style: PortraitStyle;
  seed: string;
  options?: Record<string, string[] | number | boolean> | undefined;
  colors?: { paper?: string | undefined; accent?: string | undefined } | undefined;
}

export type Role = "body" | "head" | "mouth" | "eyes" | "brows" | "restGesture" | "gesture";

/** One paint-order layer: what moves it (`role`), its own SVG transform, and its fixed art if any. */
export interface RigLayer {
  role: Role;
  /** The group's own transform, baked into every part drawn in this layer. */
  t: Affine;
  /** Key in `Rig.parts` of the art this layer always draws (body, head, resting gesture). */
  part?: string;
}

type Variants = Record<string, string | readonly string[]>;

export interface Expressions {
  mouth: Variants;
  /** Notionists has no frown: its "frown" is a closed mouth turned upside down. */
  frownFlip: boolean;
  brows: Record<string, string>;
  eyes: Record<string, string | null>;
  gesture: Record<string, string>;
  /** How far smiling eyes squash on a style without a smiling-eyes variant. */
  happySquash: number;
}

export interface Rig {
  style: PortraitStyle;
  seed: string;
  /** The viewBox side every part is drawn in. */
  size: number;
  /** Root `<svg>` attributes of a standalone part (`partSvg`). */
  root: string;
  /** Face offsets scale by `face`, body motion by `fig` (channels are in notionists units). */
  k: { fig: number; face: number };
  pivots: { neck: [number, number]; wave: [number, number]; base: [number, number] };
  layers: RigLayer[];
  /** Every part's markup in rig space (its layer's transform baked in), by key. */
  parts: Record<string, string>;
  /** Variant keys the expressions name, per channel. */
  expr: Expressions;
  /** Eye centre (rig space) the eyes squash and widen about. */
  eyeC: [number, number];
  /** Per mouth variant, the vertical centre a flipped mouth turns about (in its layer's space). */
  mouthY: Record<string, number>;
}

const STYLES: Record<PortraitStyle, Style<object>> = { notionists, micah };

type Options = Record<string, unknown>;

/**
 * Pin every enum part the seed chose (optional parts it skipped get probability 0), then apply
 * `overrides` (the portrait's designed options). `chosen` is what the result draws.
 */
function pinOf(
  style: Style<object>,
  seed: string,
  overrides: Options = {},
): { pin: Options; chosen: Record<string, string | undefined> } {
  const props = style.schema?.properties ?? {};
  const own = createAvatar(style, { seed }).toJson().extra as Record<string, string | undefined>;
  const pin: Options = { seed, backgroundColor: ["transparent"] };
  for (const [key, spec] of Object.entries(props)) {
    if (
      typeof spec !== "object" ||
      typeof spec.items !== "object" ||
      Array.isArray(spec.items) ||
      spec.items.enum === undefined
    )
      continue;
    if (own[key] !== undefined) pin[key] = [own[key]];
    if (props[`${key}Probability`] !== undefined)
      pin[`${key}Probability`] = own[key] === undefined ? 0 : 100;
  }
  const merged = { ...pin, ...overrides };
  return {
    pin: merged,
    chosen: createAvatar(style, merged).toJson().extra as Record<string, string | undefined>,
  };
}

interface Group {
  transform: string;
  inner: string;
}

/** Top-level part groups of a DiceBear SVG, in paint order. */
function groups(svg: string, order: readonly string[]): Record<string, Group> {
  const head = '<g mask="url(#viewboxMask)">';
  const body = svg.slice(svg.indexOf(head) + head.length, svg.lastIndexOf("</g>"));
  const out: Group[] = [];
  let i = 0;
  while (i < body.length) {
    const open = body.indexOf(">", i);
    const transform = /transform="([^"]*)"/.exec(body.slice(i, open))?.[1] ?? "";
    const re = /<g[\s>]|<\/g>/g;
    re.lastIndex = open + 1;
    let depth = 1;
    let closed = false;
    for (let m; (m = re.exec(body));) {
      if (m[0] !== "</g>") depth++;
      else if (--depth === 0) {
        out.push({ transform, inner: body.slice(open + 1, m.index) });
        i = m.index + 4;
        closed = true;
        break;
      }
    }
    if (!closed) break;
  }
  if (out.length !== order.length)
    throw new Error(`expected ${order.length} groups, got ${out.length}`);
  return Object.fromEntries(order.map((name, n) => [name, out[n] ?? { transform: "", inner: "" }]));
}

/** Split a brows part into near/far brows (two paths, or one path of two subpaths); a unibrow stays whole. */
function splitBrows(inner: string): { near: string; far: string } {
  const paths = inner.match(/<path [^>]*\/>/g) ?? [];
  let parts: { x: number; path: string }[];
  if (paths.length === 2)
    parts = paths.map((p) => ({ x: parseFloat(/d="M\s*(-?[\d.]+)/.exec(p)?.[1] ?? "0"), path: p }));
  else if (paths.length === 1) {
    const m = /^<path d="([^"]*)"(.*)$/.exec(paths[0]);
    const subs = (m?.[1] ?? "").split(/(?=M)/);
    if (m === null || subs.length !== 2) return { near: inner, far: "" };
    parts = subs.map((sub) => ({
      x: parseFloat(sub.slice(1)),
      path: `<path d="${sub}"${m[2] ?? ""}`,
    }));
  } else return { near: inner, far: "" };
  const [a, b] = parts.sort((p, q) => p.x - q.x);
  return a === undefined || b === undefined
    ? { near: inner, far: "" }
    : { near: a.path, far: b.path };
}

const uniq = (xs: Variants | Record<string, string | null>): string[] => [
  ...new Set(
    Object.values(xs)
      .flat()
      .filter((x): x is string => typeof x === "string" && x !== ""),
  ),
];

/** The parts one rig needs, in the shapes the two styles share. */
interface Spec {
  style: PortraitStyle;
  seed: string;
  size: number;
  root: string;
  k: Rig["k"];
  pivots: Rig["pivots"];
  layers: { role: Role; transform: string; inner?: string }[];
  mouth: Record<string, string>;
  brows: Record<string, { near: string; far: string }>;
  eyes: Record<string, string>;
  gesture: Record<string, string>;
  expr: Expressions;
}

const ROOT = /^<svg ([^>]*)>/;

// ---------- notionists ----------
const N_ORDER = [
  "base",
  "body",
  "hair",
  "lips",
  "beard",
  "nose",
  "eyes",
  "glasses",
  "brows",
  "gesture",
];
const N_GESTURES = {
  point: "pointLongArm",
  wave: "waveLongArm",
  both: "waveLongArms",
  phone: "handPhone",
};

function notionistsSpec(seed: string, options: Options): Spec {
  const { pin, chosen } = pinOf(notionists, seed, options);
  const draw = (o: Options): string => createAvatar(notionists, { ...pin, ...o }).toString();
  const full = draw({});
  const g = groups(full, N_ORDER);
  const at = (k: string): Group => g[k] ?? { transform: "", inner: "" };
  const restLips = chosen["lips"] ?? "variant01";
  const restBrows = chosen["brows"] ?? "variant01";
  const restEyes = chosen["eyes"] ?? "variant01";
  // Rules found on the assistants' parts sheets: astra-2 already rests on variant06 (the thinking
  // brows), so it thinks with 13; polaris-11 rests on a unibrow (variant03, one stroke) that cannot
  // raise one side, so "confused" switches to variant12's two arcs.
  const think = restBrows === "variant06" ? "variant13" : "variant06";
  const restSplit = splitBrows(at("brows").inner).far !== "";
  const expr: Expressions = {
    mouth: {
      rest: restLips,
      closed: "variant22",
      open: ["variant25", "variant07", "variant29", "variant14"],
      mid: ["variant14", "variant13", restLips],
      hmm: "variant24",
      think2: "variant21",
      listen: "variant22",
      hi: "variant25",
      smile: "variant25",
      grin: "variant03",
      yawn: "variant15",
      frown: "variant22",
      sleep: "variant13",
      focus: "variant21",
    },
    frownFlip: true,
    brows: {
      rest: restBrows,
      up: restBrows,
      think,
      listen: "variant12",
      focus: "variant09",
      sleep: "variant09",
      worried: "variant13",
      confused: restSplit ? restBrows : "variant12",
    },
    eyes: { rest: restEyes, wide: "variant05", happy: null },
    gesture: N_GESTURES,
    happySquash: 0.35,
  };
  const part = (key: string, v: string, extra: Options = {}): string =>
    groups(draw({ ...extra, [key]: [v] }), N_ORDER)[key]?.inner ?? "";
  return {
    style: "notionists",
    seed,
    size: 1744,
    root: ROOT.exec(full)?.[1] ?? "",
    k: { fig: 1, face: 1 },
    pivots: { neck: [880, 1130], wave: [1500, 1560], base: [872, 1744] },
    layers: [
      { role: "head", ...at("base") },
      { role: "body", ...at("body") },
      { role: "head", ...at("hair") },
      { role: "mouth", transform: at("lips").transform },
      { role: "head", ...at("beard") },
      { role: "head", ...at("nose") },
      { role: "eyes", transform: at("eyes").transform },
      { role: "head", ...at("glasses") },
      { role: "brows", transform: at("brows").transform },
      // A resting gesture (a designed pick) sinks while a state's own gesture is up.
      ...(chosen["gesture"] !== undefined
        ? [{ role: "restGesture" as const, ...at("gesture") }]
        : []),
      { role: "gesture", transform: at("gesture").transform },
    ],
    mouth: Object.fromEntries(uniq(expr.mouth).map((v) => [v, part("lips", v)])),
    brows: Object.fromEntries(uniq(expr.brows).map((v) => [v, splitBrows(part("brows", v))])),
    eyes: Object.fromEntries(uniq(expr.eyes).map((v) => [v, part("eyes", v)])),
    gesture: Object.fromEntries(
      Object.values(N_GESTURES).map((v) => [v, part("gesture", v, { gestureProbability: 100 })]),
    ),
    expr,
  };
}

// ---------- micah ----------
const M_ORDER = ["base", "mouth", "eyebrows", "hair", "eyes", "nose", "ears", "shirt"];
const GLASSES = /<g transform="translate\(-40 -8\)">[\s\S]*$/; // micah nests glasses at the end of its eyes

function micahSpec(seed: string, options: Options): Spec {
  // With a beard micah draws the mouth in translucent white (polaris-11: #ffffff33), which vanishes
  // at avatar sizes; the opaque colour keeps the look and makes the mouth readable.
  const tone = pinOf(micah, seed, options).chosen["mouthColor"];
  const opaque =
    tone?.length === 9 && options["mouthColor"] === undefined
      ? { mouthColor: [tone.slice(1, 7)] }
      : {};
  const { pin, chosen } = pinOf(micah, seed, { ...options, ...opaque });
  const draw = (o: Options): string => createAvatar(micah, { ...pin, ...o }).toString();
  const full = draw({});
  const g = groups(full, M_ORDER);
  const at = (k: string): Group => g[k] ?? { transform: "", inner: "" };
  const neck = /<path [^>]*\/>/.exec(at("base").inner)?.[0] ?? "";
  const glasses = GLASSES.exec(at("eyes").inner)?.[0] ?? "";
  const restBrows = chosen["eyebrows"] ?? "up";
  const restMouth = chosen["mouth"] ?? "smile";
  const expr: Expressions = {
    mouth: {
      rest: restMouth,
      closed: "smirk",
      open: ["laughing", "surprised", "nervous", "surprised"],
      mid: ["pucker", "smile", restMouth],
      hmm: "pucker",
      think2: "smirk",
      listen: "smile",
      hi: "laughing",
      smile: "laughing",
      grin: "smile",
      yawn: "surprised",
      frown: "sad",
      sleep: "smile",
      focus: "smirk",
    },
    frownFlip: false,
    brows: {
      rest: restBrows,
      up: "up",
      think: "down",
      listen: "up",
      focus: "down",
      sleep: restBrows,
      worried: "down",
      confused: restBrows,
    },
    eyes: { rest: chosen["eyes"] ?? "eyes", wide: "round", happy: "smiling" },
    gesture: {},
    happySquash: 0,
  };
  const part = (key: string, v: string): string =>
    groups(draw({ [key]: [v] }), M_ORDER)[key]?.inner ?? "";
  return {
    style: "micah",
    seed,
    size: 360,
    root: ROOT.exec(full)?.[1] ?? "",
    // Micah's head fills about half the frame (notionists' about a quarter): face offsets scale by
    // the face, body motion by the frame.
    k: { fig: 360 / 1744, face: 0.42 },
    pivots: { neck: [182, 262], wave: [0, 0], base: [180, 360] },
    layers: [
      { role: "body", transform: at("base").transform, inner: neck },
      { role: "head", transform: at("base").transform, inner: at("base").inner.replace(neck, "") },
      { role: "mouth", transform: at("mouth").transform },
      { role: "brows", transform: at("eyebrows").transform },
      { role: "head", ...at("hair") },
      { role: "eyes", transform: at("eyes").transform },
      { role: "head", transform: at("eyes").transform, inner: glasses },
      { role: "head", ...at("nose") },
      { role: "head", ...at("ears") },
      { role: "body", ...at("shirt") },
    ],
    mouth: Object.fromEntries(uniq(expr.mouth).map((v) => [v, part("mouth", v)])),
    brows: Object.fromEntries(uniq(expr.brows).map((v) => [v, splitBrows(part("eyebrows", v))])),
    eyes: Object.fromEntries(uniq(expr.eyes).map((v) => [v, part("eyes", v).replace(GLASSES, "")])),
    gesture: {},
    expr,
  };
}

const wrap = (transform: string, inner: string): string =>
  `<g transform="${transform}">${inner}</g>`;

/** Fold a spec into a rig: every part keyed and wrapped in its layer's transform; adjacent fixed layers of one role merged. */
function rigOf(spec: Spec): Rig {
  const parts: Record<string, string> = {};
  const layers: RigLayer[] = [];
  const layerOf = (role: Role): { transform: string } =>
    spec.layers.find((l) => l.role === role) ?? { transform: "" };
  for (const l of spec.layers) {
    const fixed = l.role === "body" || l.role === "head" || l.role === "restGesture";
    if (!fixed) {
      layers.push({ role: l.role, t: parseTransform(l.transform) });
      continue;
    }
    if ((l.inner ?? "") === "") continue;
    const markup = wrap(l.transform, l.inner ?? "");
    const last = layers.at(-1);
    if (last?.part !== undefined && last.role === l.role) {
      parts[last.part] = (parts[last.part] ?? "") + markup;
      continue;
    }
    const key = `${l.role}:${layers.length}`;
    parts[key] = markup;
    layers.push({ role: l.role, t: parseTransform(l.transform), part: key });
  }
  const mouthT = layerOf("mouth").transform;
  const mouthY: Record<string, number> = {};
  for (const [v, inner] of Object.entries(spec.mouth)) {
    parts[`mouth:${v}`] = wrap(mouthT, inner);
    mouthY[v] = centre(inner)[1];
  }
  const eyesT = layerOf("eyes").transform;
  for (const [v, inner] of Object.entries(spec.eyes)) parts[`eyes:${v}`] = wrap(eyesT, inner);
  const browsT = layerOf("brows").transform;
  for (const [v, b] of Object.entries(spec.brows)) {
    parts[`near:${v}`] = wrap(browsT, b.near);
    if (b.far !== "") parts[`far:${v}`] = wrap(browsT, b.far);
  }
  const gestT = layerOf("gesture").transform;
  for (const [v, inner] of Object.entries(spec.gesture)) parts[`gesture:${v}`] = wrap(gestT, inner);
  const restEyes = spec.eyes[spec.expr.eyes["rest"] ?? ""] ?? "";
  const [cx, cy] = centre(restEyes);
  const et = parseTransform(eyesT);
  return {
    style: spec.style,
    seed: spec.seed,
    size: spec.size,
    root: spec.root,
    k: spec.k,
    pivots: spec.pivots,
    layers,
    parts,
    expr: spec.expr,
    eyeC: [et[0] * cx + et[2] * cy + et[4], et[1] * cx + et[3] * cy + et[5]],
    mouthY,
  };
}

const rigs = new Map<string, Rig>();

/** The rig of `portrait`, built once per style, seed and options (a few dozen DiceBear renders). */
export function buildRig(portrait: Portrait): Rig {
  const options = (portrait.options ?? {}) as Options;
  const key = JSON.stringify([portrait.style, portrait.seed, options]);
  let rig = rigs.get(key);
  if (rig === undefined) {
    rig = rigOf(
      portrait.style === "micah"
        ? micahSpec(portrait.seed, options)
        : notionistsSpec(portrait.seed, options),
    );
    rigs.set(key, rig);
  }
  return rig;
}

/** A part as a standalone SVG document in the rig's viewBox (for renderers that parse one SVG per part, like Skia). */
export function partSvg(rig: Rig, key: string): string {
  return `<svg ${rig.root}>${rig.parts[key] ?? ""}</svg>`;
}

/** The DiceBear SVG the rig's resting parts draw (transparent background), for checks and stills. */
export function restingSvg(portrait: Portrait): string {
  return createAvatar(STYLES[portrait.style], {
    ...(portrait.options ?? {}),
    seed: portrait.seed,
    backgroundColor: ["transparent"],
  }).toString();
}

/**
 * The credit Micah's CC BY 4.0 license asks for, naming the assistants drawn with it ("Nova and
 * Polaris avatars: …"); null when none is.
 */
export function micahCredit(
  agents: readonly { title: string; style: PortraitStyle }[],
): string | null {
  const names = agents.filter((a) => a.style === "micah").map((a) => a.title);
  if (names.length === 0) return null;
  const list =
    names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names.at(-1) ?? ""}`;
  return `${list ?? ""} ${names.length === 1 ? "avatar" : "avatars"}: Micah by Micah Lanier, CC BY 4.0, modified`;
}
