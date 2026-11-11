import { describe, expect, it } from 'vitest'
import { mentionMarkdown } from './mentions'
import { ROSTER } from './test-roster'

describe('mentionMarkdown', () => {
  it("turns @names into mention: links in the person's color, Isaac included, not inside code", () => {
    expect(
      mentionMarkdown('@Mara and @Theo Lindqvist, @Isaac decides; `@Mara` stays', ROSTER),
    ).toBe(
      '[@Mara](mention:orange) and [@Theo Lindqvist](mention:blue), [@Isaac](mention:gray) decides; `@Mara` stays',
    )
    expect(mentionMarkdown('@all in', ROSTER)).toBe('[@all](mention:gray) in')
    expect(mentionMarkdown('@Bob and a@b.c', ROSTER)).toBe('@Bob and a@b.c')
  })
})
