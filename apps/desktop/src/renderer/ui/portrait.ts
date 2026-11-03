import { assistantAvatarSvg } from '@relay/portrait-motion'
import type { AssistantPortrait } from '@evaos/contract'

/**
 * A deterministic illustrated portrait as an SVG data URI; no network involved. The drawing is the
 * shared `assistantAvatarSvg` (also behind the canvas host's `/canvas/avatar/<key>`): a string is a
 * notionists seed on a transparent background; a designed portrait draws its style and part
 * options on its paper color, when it has one, which the round frame it sits in makes its disc.
 */
export function portrait(of: string | AssistantPortrait): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(assistantAvatarSvg(of))}`
}
