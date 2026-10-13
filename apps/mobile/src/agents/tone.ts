import type { ToneToken } from "@/theme";
import type { Tone } from "./widget";

/** A widget spec's tone as the palette color it paints with. */
export const toneColor = {
  accent: "accent",
  ok: "ok",
  warn: "warn",
  danger: "danger",
  muted: "textMuted",
} as const satisfies Record<Tone, ToneToken>;
