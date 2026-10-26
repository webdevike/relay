import { createAvatar } from '@dicebear/core'
import * as notionists from '@dicebear/notionists'

/** A deterministic illustrated portrait for a seed, as an SVG data URI; no network involved. */
export function portrait(seed: string): string {
  return createAvatar(notionists, { seed, backgroundColor: ['transparent'] }).toDataUri()
}
