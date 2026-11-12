/**
 * Guest page to main: the page asked for a passkey (`start`) or got one (`done`). Sent by the guest
 * preload (guest.ts); main shows or clears the "Passkeys don't work here" bar for that tab.
 */
export const PASSKEY_CHANNEL = 'relay:guest-passkey'

export type PasskeyPhase = 'start' | 'done'

/**
 * Main to guest page: Design Mode is on (`true`) or off in this page (main/browser/design-mode.ts).
 * While on, the guest preload's pointer gate keeps every pointer event from the page's own
 * listeners and hands each mouse move, press and release to the design picker as a
 * DESIGN_INPUT_EVENT on the document (annotate-picker.ts).
 */
export const DESIGN_GATE_CHANNEL = 'relay:design-gate'

/** Guest top frame to main, as its document starts: is Design Mode on in this page? (boolean) */
export const DESIGN_GATE_QUERY = 'relay:design-gate-query'

/** The gate's event on the document; `detail` is JSON of DesignInput. */
export const DESIGN_INPUT_EVENT = 'relay-design-input'

/** One gated mouse event, in viewport CSS px. */
export interface DesignInput {
  type: 'mousemove' | 'mousedown' | 'mouseup'
  x: number
  y: number
  button: number
  shift: boolean
}
