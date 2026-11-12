/**
 * What a running chip's background fill looks like, from the estimate alone (protocol `etaView`):
 * how far it reaches, which palette color tints it and whether it is solid or striped. Solid in the
 * agent's color when the estimate is confident, striped in the same color when it is a rough guess,
 * amber (solid) once the run is taking longer than usual. Pure so the choice is tested; drawing is
 * `ui/ProgressFill`.
 */
import type { EtaView } from "@relay/protocol";

export type FillTexture = "solid" | "striped";

export interface ChipFill {
  fraction: number;
  color: string;
  texture: FillTexture;
}

/** `tint` is the agent's accent, `warn` the palette's amber. */
export function chipFill(view: EtaView, tint: string, warn: string): ChipFill {
  if (view.state === "overrunning") return { fraction: view.fraction, color: warn, texture: "solid" };
  return { fraction: view.fraction, color: tint, texture: view.confident ? "solid" : "striped" };
}
