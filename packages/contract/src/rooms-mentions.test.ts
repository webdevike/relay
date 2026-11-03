import { describe, expect, it } from 'vitest'
import { MENTION_EVERYONE, mentionSpans, mentionsIn } from './rooms-mentions'
import { ROOM_PEOPLE } from './rooms-roster'

const isaac = { id: 'isaac', name: 'Isaac' }

describe('mentionsIn', () => {
  it('matches first names, full names, any case, once each, in order', () => {
    expect(mentionsIn('@Theo and @mara voss, then @THEO again', ROOM_PEOPLE)).toEqual([
      'builder',
      'skeptic',
    ])
    expect(
      mentionsIn('@Mara Smith is not her last name but it is still Mara', ROOM_PEOPLE),
    ).toEqual(['skeptic'])
  })

  it('@everyone or @all is the whole room, and unknown names are ignored', () => {
    expect(mentionsIn('@all please', ROOM_PEOPLE)).toEqual([MENTION_EVERYONE])
    expect(mentionsIn('@Theo and @Everyone', ROOM_PEOPLE)).toEqual([MENTION_EVERYONE])
    expect(mentionsIn('@Bob? mail me at a@b.c', ROOM_PEOPLE)).toEqual([])
    expect(mentionsIn('no mentions here', ROOM_PEOPLE)).toEqual([])
    expect(mentionsIn('@Isaac decides', ROOM_PEOPLE)).toEqual([])
    expect(mentionsIn('@Isaac decides', [...ROOM_PEOPLE, isaac])).toEqual(['isaac'])
  })
})

describe('mentionSpans', () => {
  it('spans the @First or the @First Last when the last name matches', () => {
    const text = 'Hey @Mara Voss and @Theo said, @all @nobody'
    expect(mentionSpans(text, ROOM_PEOPLE)).toEqual([
      { start: 4, end: 14, id: 'skeptic' },
      { start: 19, end: 24, id: 'builder' },
      { start: 31, end: 35, id: MENTION_EVERYONE },
    ])
  })
})
