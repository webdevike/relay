/**
 * What a running chip's background fill looks like, from the estimate alone (protocol `etaView`):
 * how far it reaches, how strong it is, whether it is solid or striped, and whether it pulses.
 *
 * Neutral on purpose: a faint wash of the label's own color (near-white in dark, near-black in
 * light), never an agent accent, amber or green, which turn muddy over the chip surface. Solid when
 * the estimate is confident, soft stripes when it is a rough guess, a gentle pulse once the run is
 * taking longer than usual. Pure so the choice is tested; drawing is `ui/ProgressFill`.
 */
import type { EtaView } from "@relay/protocol";
import type { ColorScheme } from "@/theme";

export type FillTexture = "solid" | "striped";

export interface ChipFill {
  fraction: number;
  color: string;
  texture: FillTexture;
  /** Opacity of the solid fill. */
  alpha: number;
  /** Opacity of the stripes (striped texture only). */
  stripeAlpha: number;
  /** Breathes slowly: the run is past its estimate. */
  pulse: boolean;
}

const WASH = {
  dark: { color: "#F2F4FA", alpha: 0.09, stripeAlpha: 0.055 },
  light: { color: "#141416", alpha: 0.07, stripeAlpha: 0.045 },
} as const;

export function chipFill(view: EtaView, scheme: ColorScheme): ChipFill {
  const overrunning = view.state === "overrunning";
  return { fraction: view.fraction, ...WASH[scheme], texture: overrunning || view.confident ? "solid" : "striped", pulse: overrunning };
}

/** A finished chip's full fill, before it fades. */
export function doneFill(scheme: ColorScheme): ChipFill {
  return { fraction: 1, ...WASH[scheme], texture: "solid", pulse: false };
}
