import { createAvatar, type Style } from '@dicebear/core'
import * as micah from '@dicebear/micah'
import * as notionists from '@dicebear/notionists'
import type { AssistantPortrait } from '@evaos/contract'

const STYLES: Record<AssistantPortrait['style'], Style<object>> = { notionists, micah }

/** Generated portraits by what they draw; the same portrait always draws the same face, so each is drawn once. */
const drawn = new Map<string, string>()

/**
 * A deterministic illustrated portrait as an SVG data URI; no network involved. A string is a
 * notionists seed on a transparent background; a designed portrait draws its style and part
 * options on its paper color, when it has one, which the round frame it sits in makes its disc.
 */
export function portrait(of: string | AssistantPortrait): string {
  const p: AssistantPortrait = typeof of === 'string' ? { style: 'notionists', seed: of } : of
  const paper = p.colors?.paper
  const key = JSON.stringify([p.style, p.seed, p.options ?? {}, paper ?? null])
  let uri = drawn.get(key)
  if (uri === undefined) {
    uri = createAvatar(STYLES[p.style], {
      ...p.options,
      seed: p.seed,
      backgroundColor: [paper === undefined ? 'transparent' : paper.slice(1)],
    }).toDataUri()
    drawn.set(key, uri)
  }
  return uri
}
