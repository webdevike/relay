import { describe, expect, it } from 'vitest'
import {
  insertMention,
  insertRaw,
  mentionChoices,
  mentionMarkdown,
  mentionQueryAt,
  mentionables,
} from './mentions'
import { ROSTER } from './roster'

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

describe('composer @ picker', () => {
  const people = mentionables(ROSTER)

  it('opens on @ at the start or after whitespace, with what was typed so far', () => {
    expect(mentionQueryAt('@', 1)).toEqual({ start: 0, query: '' })
    expect(mentionQueryAt('hey @ma', 7)).toEqual({ start: 4, query: 'ma' })
    expect(mentionQueryAt('hey @ma', 5)).toEqual({ start: 4, query: '' })
    expect(mentionQueryAt('hey @mara ', 10)).toBeNull()
    expect(mentionQueryAt('a@b', 3)).toBeNull()
    expect(mentionQueryAt('hey @ma', 3)).toBeNull()
  })

  it('filters people by first name and inserts @First with a trailing space', () => {
    expect(mentionChoices(people, '').map((p) => p.id)).toEqual([
      'skeptic',
      'builder',
      'advocate',
      'pm',
      'ops',
      'isaac',
    ])
    expect(mentionChoices(people, 'ma').map((p) => p.id)).toEqual(['skeptic'])
    expect(mentionChoices(people, 'x')).toEqual([])
    const q = mentionQueryAt('hey @ma tail', 7)!
    expect(insertMention('hey @ma tail', 7, q, 'Mara Voss')).toEqual({
      text: 'hey @Mara  tail',
      caret: 10,
    })
    expect(insertRaw('hey @ma', 7, ' ')).toEqual({ text: 'hey @ma ', caret: 8 })
    expect(mentionQueryAt('hey @ma ', 8)).toBeNull()
  })
})
