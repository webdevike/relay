import type { FontVariant } from "react-native";

/**
 * Design tokens. Dark only — Relay has no light theme.
 */

export const colors = {
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
} as const;

export type ColorToken = keyof typeof colors;

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
} satisfies Record<string, TypeStyle>;

export type TypeToken = keyof typeof type;

/** Tabular numerals for anything time- or count-like. */
export const tabularNumbers: { fontVariant: FontVariant[] } = { fontVariant: ["tabular-nums"] };

export const motion = {
  duration: { fast: 120, base: 180 },
  easing: "easeOut",
} as const;

export const theme = { colors, spacing, radii, type, motion } as const;
