/** What the thread's Pinned row shows for a pin: pure, so the chip's text is tested without rendering. */
import type { Pin } from "@relay/protocol";

/** A value this short rides beside its label on the chip; a longer one is only copied. */
export const CHIP_VALUE_MAX = 16;
/** A label past this many characters ends in an ellipsis on the chip. */
export const CHIP_LABEL_MAX = 24;

export interface PinChipText {
  label: string;
  /** The value beside the label, or null when it is long, multi-line or a whole message. */
  value: string | null;
  /** Code and numbers read in a monospace face. */
  mono: boolean;
}

export function pinChipText(pin: Pin): PinChipText {
  const label = pin.label.length > CHIP_LABEL_MAX ? `${pin.label.slice(0, CHIP_LABEL_MAX - 1).trimEnd()}…` : pin.label;
  const short = pin.kind !== "message" && !pin.value.includes("\n") && pin.value.length <= CHIP_VALUE_MAX && pin.value !== pin.label;
  return { label, value: short ? pin.value : null, mono: pin.kind === "code" || pin.kind === "number" };
}

/** How long a tapped chip reads "Copied". */
export const COPIED_MS = 1200;
