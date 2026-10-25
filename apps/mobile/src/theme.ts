import { useColorScheme, type FontVariant } from "react-native";

/**
 * Design tokens. Colors come in a dark and a light palette; components read the active one with
 * `useColors()`, which follows the iOS appearance. The Settings appearance choice (system, light,
 * dark) overrides that appearance app-wide through `Appearance.setColorScheme` in the root layout.
 */

const dark = {
  bg: "#0B0B0C",
  surface: "#141416",
  surfaceRaised: "#1C1C1F",
  hairline: "rgba(255,255,255,0.08)",
  text: "#EDEDED",
  textMuted: "#9A9AA3",
  textFaint: "#6B6B75",
  accent: "#7C9CFF",
  ok: "#4ADE80",
  warn: "#FBBF24",
  danger: "#F87171",
  working: "#7C9CFF",
  /** Fill of the user's own chat bubbles (Eva), a muted blue; text on it is white in both palettes. */
  bubbleUser: "#6D8DB4",
  /** Handing something to an assistant (Catch Up's swipe up and send button); white text on it. */
  handoff: "#8B5CF6",
};

export type Colors = typeof dark;
export type ColorToken = keyof Colors;
export type ColorScheme = "light" | "dark";
/** The palette colors a tone (pill, callout, bar, timeline dot) can take. */
export type ToneToken = Extract<ColorToken, "accent" | "ok" | "warn" | "danger" | "textMuted">;

/** A `#RRGGBB` palette color at the given opacity, for tinted surfaces and tinted hairlines. */
export function withAlpha(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

/** The low-alpha fill behind toned content; the muted tone sits on the raised surface instead. */
export function toneFill(colors: Colors, tone: ToneToken, alpha = 0.16): string {
  return tone === "textMuted" ? colors.surfaceRaised : withAlpha(colors[tone], alpha);
}

const light: Colors = {
  bg: "#F6F6F8",
  surface: "#FFFFFF",
  surfaceRaised: "#EDEDF1",
  hairline: "rgba(0,0,0,0.09)",
  text: "#141416",
  textMuted: "#5C5C66",
  textFaint: "#8A8A94",
  accent: "#3D5FE0",
  ok: "#15803D",
  warn: "#B45309",
  danger: "#DC2626",
  working: "#3D5FE0",
  bubbleUser: "#3F7AE8",
  handoff: "#7C3AED",
};

export const palettes: Record<ColorScheme, Colors> = { dark, light };

/** The active scheme: the Settings override when set, otherwise the iOS appearance. */
export function useScheme(): ColorScheme {
  return useColorScheme() === "light" ? "light" : "dark";
}

/** The active palette. Read it in render; never capture it in a module-level StyleSheet. */
export function useColors(): Colors {
  return palettes[useScheme()];
}

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  xxxl: 32,
} as const;

export type SpacingToken = keyof typeof spacing;

export const radii = {
  sm: 6,
  md: 10,
  lg: 14,
} as const;

export type RadiusToken = keyof typeof radii;

interface TypeStyle {
  fontSize: number;
  lineHeight: number;
  fontWeight: "400" | "500" | "600" | "700";
}

export const type = {
  caption: { fontSize: 12, lineHeight: 16, fontWeight: "400" },
  body: { fontSize: 15, lineHeight: 20, fontWeight: "400" },
  label: { fontSize: 13, lineHeight: 18, fontWeight: "500" },
  title: { fontSize: 17, lineHeight: 22, fontWeight: "600" },
  largeTitle: { fontSize: 28, lineHeight: 34, fontWeight: "700" },
  display: { fontSize: 36, lineHeight: 44, fontWeight: "500" },
} satisfies Record<string, TypeStyle>;

export type TypeToken = keyof typeof type;

/** Tabular numerals for anything time- or count-like. */
export const tabularNumbers: { fontVariant: FontVariant[] } = { fontVariant: ["tabular-nums"] };

export const motion = {
  duration: { fast: 120, base: 180 },
  easing: "easeOut",
} as const;

export const theme = { palettes, spacing, radii, type, motion } as const;
