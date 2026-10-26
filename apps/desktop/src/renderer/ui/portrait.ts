import { createAvatar } from '@dicebear/core'
import * as notionists from '@dicebear/notionists'

/** Generated portraits by seed; a seed always draws the same face, so each is drawn once. */
const drawn = new Map<string, string>()

/** A deterministic illustrated portrait for a seed, as an SVG data URI; no network involved. */
export function portrait(seed: string): string {
  let uri = drawn.get(seed)
  if (uri === undefined) {
    uri = createAvatar(notionists, { seed, backgroundColor: ['transparent'] }).toDataUri()
    drawn.set(seed, uri)
  }
  return uri
}
