/**
 * The avatar editor's model, shared by the desktop and phone editors (ported from the avatar
 * playground's builder): which parts each style lets you pick, the variants of each, colors, a
 * random shuffle, the thumbnail of a pick, and the one message Save sends. Pure functions over a
 * `Portrait`; no DOM, so it runs in React Native too. An edit never mutates its input.
 */
import { createAvatar, type Style } from "@dicebear/core";
import * as micah from "@dicebear/micah";
import * as notionists from "@dicebear/notionists";
import type { Portrait, PortraitStyle } from "./rig";

const STYLES: Record<PortraitStyle, Style<object>> = { notionists, micah };

export const PORTRAIT_STYLES: readonly PortraitStyle[] = ["micah", "notionists"];

/** One part a style lets you pick: its DiceBear option key and the viewBox its thumbnail crops to. */
export interface PartDef {
  key: string;
  label: string;
  view: string;
}

export const PART_DEFS: Record<PortraitStyle, readonly PartDef[]> = {
  notionists: [
    { key: "hair", label: "Hair", view: "170 140 1400 1200" },
    { key: "eyes", label: "Eyes", view: "600 560 520 335" },
    { key: "brows", label: "Brows", view: "600 560 520 335" },
    { key: "lips", label: "Mouth", view: "720 740 360 280" },
    { key: "nose", label: "Nose", view: "720 600 400 400" },
    { key: "glasses", label: "Glasses", view: "560 520 640 420" },
    { key: "beard", label: "Beard", view: "520 700 700 600" },
    { key: "body", label: "Body", view: "100 900 1544 844" },
    { key: "bodyIcon", label: "Body icon", view: "100 900 1544 844" },
    { key: "gesture", label: "Gesture", view: "0 0 1744 1744" },
  ],
  micah: [
    { key: "hair", label: "Hair", view: "20 0 320 280" },
    { key: "eyes", label: "Eyes", view: "100 90 180 110" },
    { key: "eyebrows", label: "Brows", view: "100 80 180 90" },
    { key: "mouth", label: "Mouth", view: "140 165 120 95" },
    { key: "nose", label: "Nose", view: "120 100 140 140" },
    { key: "ears", label: "Ears", view: "40 90 280 180" },
    { key: "earrings", label: "Earrings", view: "40 130 280 160" },
    { key: "glasses", label: "Glasses", view: "90 90 200 120" },
    { key: "facialHair", label: "Facial hair", view: "50 110 260 230" },
    { key: "shirt", label: "Shirt", view: "0 220 360 140" },
  ],
};

/** A color option: DiceBear's key and the hex swatches (no `#`) it offers. */
export interface ColorRow {
  key: string;
  label: string;
  swatches: readonly string[];
}

const props = (style: PortraitStyle): Record<string, any> =>
  (STYLES[style].schema?.properties ?? {}) as Record<string, any>;

const defaultsOf = (style: PortraitStyle, key: string): string[] => {
  const d = props(style)[key]?.default;
  return Array.isArray(d) ? d.filter((x): x is string => typeof x === "string") : [];
};

export const COLOR_ROWS: Record<PortraitStyle, readonly ColorRow[]> = {
  notionists: [],
  micah: [
    { key: "baseColor", label: "Skin", swatches: ["f9c9b6", "ac6651", "77311d", "eeb4a4", "e5a07e", "b16a5b", "623d36"] },
    { key: "hairColor", label: "Hair color", swatches: defaultsOf("micah", "hairColor") },
    { key: "shirtColor", label: "Shirt color", swatches: defaultsOf("micah", "shirtColor") },
  ],
};

/** Mantine's pale 0-1 shades: the disc behind the face. */
export const PAPER_SWATCHES: readonly string[] = [
  "#f1f3f5", "#fff1e6", "#e7f5ff", "#f3f0ff", "#ebfbee", "#fff9db", "#ffe3e3", "#e3fafc", "#f8f0fc", "#ffffff",
];
/** Mantine's 6 shades: the tint of the animation overlays. */
export const ACCENT_SWATCHES: readonly string[] = [
  "#1c7ed6", "#7048e8", "#ae3ec9", "#d6336c", "#e03131", "#f76707", "#f59f00", "#37b24d", "#0ca678", "#1098ad", "#495057",
];

/** A part's variants, sorted; `null` leads when the style lets the part be left off. */
export function partChoices(style: PortraitStyle, key: string): (string | null)[] {
  const all = props(style);
  const variants: string[] = [...((all[key]?.items?.enum as string[] | undefined) ?? [])].sort();
  return all[`${key}Probability`] === undefined ? variants : [null, ...variants];
}

/** `variant01` shows as `01`. */
export const shortName = (v: string | null): string => (v === null ? "none" : v.replace(/^variant/, ""));

/**
 * `p` with every part the seed chose written into `options` (parts it skipped are switched off), and
 * the style's colors too, so editing one part leaves the rest as drawn. Idempotent.
 */
export function pinPortrait(p: Portrait): Portrait {
  const style = STYLES[p.style];
  const own = createAvatar(style, { seed: p.seed }).toJson().extra as Record<string, string | undefined>;
  const all = props(p.style);
  const pin: Record<string, string[] | number | boolean> = {};
  for (const [key, spec] of Object.entries(all)) {
    if (spec?.items?.enum !== undefined) {
      if (own[key] !== undefined) pin[key] = [own[key]];
      if (all[`${key}Probability`] !== undefined) pin[`${key}Probability`] = own[key] === undefined ? 0 : 100;
    }
  }
  for (const row of COLOR_ROWS[p.style]) {
    const c = own[row.key];
    if (c !== undefined) pin[row.key] = [c.replace(/^#/, "")];
  }
  return { ...p, options: { ...pin, ...p.options } };
}

/** The part's pick in `p`: a variant name, or null when an optional part is off. */
export function partValue(p: Portrait, key: string): string | null {
  if (p.options?.[`${key}Probability`] === 0) return null;
  const v = p.options?.[key];
  return Array.isArray(v) ? (v[0] ?? null) : null;
}

/** `p` with `key` set to `value` (null turns an optional part off). */
export function withPart(p: Portrait, key: string, value: string | null): Portrait {
  const options = { ...p.options };
  const prob = `${key}Probability`;
  if (value === null) options[prob] = 0;
  else {
    options[key] = [value];
    if (props(p.style)[prob] !== undefined) options[prob] = 100;
  }
  return { ...p, options };
}

/** `p` with color option `key` set to a swatch (hex, `#` optional). */
export function withColor(p: Portrait, key: string, hex: string): Portrait {
  return { ...p, options: { ...p.options, [key]: [hex.replace(/^#/, "")] } };
}

/** The color option's pick in `p` as `#rrggbb`, or null. */
export function colorValue(p: Portrait, key: string): string | null {
  const v = p.options?.[key];
  return Array.isArray(v) && typeof v[0] === "string" ? `#${v[0].replace(/^#/, "")}` : null;
}

/** `p` with its disc or accent color set (null clears it). */
export function withPalette(p: Portrait, key: "paper" | "accent", hex: string | null): Portrait {
  const colors = { ...p.colors };
  if (hex === null) delete colors[key];
  else colors[key] = hex;
  const next: Portrait = { ...p, colors };
  if (Object.keys(colors).length === 0) delete next.colors;
  return next;
}

/** `p` in another style: its seed and colors stay, its parts are the new style's own for that seed. */
export function withStyle(p: Portrait, style: PortraitStyle): Portrait {
  if (p.style === style) return p;
  const next: Portrait = { style, seed: p.seed };
  if (p.colors !== undefined) next.colors = p.colors;
  return pinPortrait(next);
}

type Random = () => number;
const pick = <T>(xs: readonly T[], rnd: Random): T => xs[Math.floor(rnd() * xs.length)] as T;

/** One part changed to another pick (an optional part may go off); unchanged when it has no other. */
export function shufflePart(p: Portrait, key: string, rnd: Random = Math.random): Portrait {
  const now = partValue(p, key);
  const others = partChoices(p.style, key).filter((v) => v !== now);
  return others.length === 0 ? p : withPart(p, key, pick(others, rnd));
}

/**
 * A new face: every part re-picked (optional ones appear about as often as DiceBear's own default)
 * and the style's colors; the disc and accent stay.
 */
export function shuffle(p: Portrait, rnd: Random = Math.random): Portrait {
  let next = p;
  for (const def of PART_DEFS[p.style]) {
    const prob = props(p.style)[`${def.key}Probability`];
    const variants = partChoices(p.style, def.key).filter((v): v is string => v !== null);
    if (variants.length === 0) continue;
    const on = prob === undefined || rnd() * 100 < ((prob.default as number | undefined) ?? 50);
    next = withPart(next, def.key, on ? pick(variants, rnd) : null);
  }
  for (const row of COLOR_ROWS[p.style]) if (row.swatches.length > 0) next = withColor(next, row.key, pick(row.swatches, rnd));
  return next;
}

/** A fresh random start: a random seed's own face. */
export function randomSeed(rnd: Random = Math.random): string {
  return `av-${Math.floor(rnd() * 1e6)}`;
}

/** The SVG of `p` as drawn on its disc (paper) or transparent. */
export function portraitSvg(p: Portrait): string {
  const paper = p.colors?.paper;
  return createAvatar(STYLES[p.style], {
    ...p.options,
    seed: p.seed,
    backgroundColor: [paper === undefined ? "transparent" : paper.slice(1)],
  }).toString();
}

/** A thumbnail of `p` with `def` set to `value`, cropped to the part: SVG markup on a transparent ground. */
export function partThumbSvg(p: Portrait, def: PartDef, value: string | null): string {
  const svg = createAvatar(STYLES[p.style], {
    ...withPart(p, def.key, value).options,
    seed: p.seed,
    backgroundColor: ["transparent"],
  }).toString();
  return svg.replace(/viewBox="[^"]*"/, `viewBox="${def.view}"`);
}

/** Saves nothing; Save sends this as Isaac's next message and the assistant applies it. */
export const SAVE_PREFIX = "Save my avatar: ";

/** What Save sends: `Save my avatar: {"agent":"nova","avatar":{...}}`, one line. */
export function saveMessage(agent: string, p: Portrait): string {
  const avatar: Portrait = { style: p.style, seed: p.seed };
  if (p.options !== undefined) avatar.options = p.options;
  if (p.colors !== undefined) avatar.colors = p.colors;
  return `${SAVE_PREFIX}${JSON.stringify({ agent, avatar })}`;
}

/** The agent and portrait of a `saveMessage`, or null for any other text. */
export function parseSaveMessage(text: string): { agent: string; avatar: Portrait } | null {
  if (!text.startsWith(SAVE_PREFIX)) return null;
  try {
    const v = JSON.parse(text.slice(SAVE_PREFIX.length)) as { agent?: unknown; avatar?: Partial<Portrait> };
    const a = v.avatar;
    if (typeof v.agent !== "string" || a === undefined || a === null) return null;
    if ((a.style !== "micah" && a.style !== "notionists") || typeof a.seed !== "string" || a.seed === "") return null;
    const avatar: Portrait = { style: a.style, seed: a.seed };
    if (a.options !== undefined) avatar.options = a.options;
    if (a.colors !== undefined) avatar.colors = a.colors;
    return { agent: v.agent, avatar };
  } catch {
    return null;
  }
}
