import { frameOf } from '@relay/widget-runtime/systems'

/**
 * A component card's chrome around its frame (canvas.css `.eva-cv-card[data-kind='proto']`): the
 * card's 1px border, the 12px inset its header and frame sit at, the frame's own 1px border, and
 * above the frame the 20px header and its 8px gap.
 */
export const PROTO_CHROME = { x: 2 * (1 + 12 + 1), y: 2 * (1 + 12 + 1) + 20 + 8 } as const

/**
 * A component card's size on the board: its frame (`data.frame`) plus the chrome. The card is an
 * artboard, so the frame decides it; main writes it to the file and the board draws it.
 */
export function protoCardSize(frame: string | undefined): { w: number; h: number } {
  const f = frameOf(frame)
  return { w: f.w + PROTO_CHROME.x, h: f.h + PROTO_CHROME.y }
}
