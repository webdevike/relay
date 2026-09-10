// The only seam between pointer/keyboard logic and the kernel. Mirrors CGEventPoster.swift:
// TrackpadInputSink and KeyboardInjector decide *what* to emit; UinputDevice is *how*. Tests use
// a recording fake and never open /dev/uinput.

export type MouseButton = "left" | "right";

export interface EventPoster {
  /** Relative pointer motion in pixels, one SYN_REPORT. */
  moveBy(dx: number, dy: number): void;
  /** Button press (`down: true`) or release, one SYN_REPORT. */
  button(button: MouseButton, down: boolean): void;
  /** Scroll in pixel units, positive `dy` scrolls content up (finger moves down). */
  scroll(dx: number, dy: number): void;
  /** Key press + release for a Linux `KEY_*` code, each its own SYN_REPORT. */
  tapKey(code: number, modifiers?: readonly number[]): void;
}
