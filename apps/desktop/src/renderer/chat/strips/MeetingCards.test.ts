import { describe, expect, it } from 'vitest'
import { toolTabFromJson, toolTabId } from '@evaos/shell-core'
import { endedLine, endedMeta, meetingCardId } from './MeetingCards'

const r = {
  id: 'abcd1234-ef',
  title: 'Developer Sync',
  app: 'Teams',
  startedAt: 0,
  endedAt: 42 * 60_000 + 20_000,
}

describe('meeting cards', () => {
  it('names the live card and the ended one apart, so dismissing one keeps the other', () => {
    expect(meetingCardId(r, true)).toBe('meeting:abcd1234-ef')
    expect(meetingCardId(r, false)).toBe('meeting-ended:abcd1234-ef')
  })

  it('says how long the call ran, at least a minute, and an untitled call by its app', () => {
    expect(endedLine(r)).toBe('Meeting ended · 42 min · Developer Sync')
    expect(endedLine({ ...r, title: null, endedAt: 10_000 })).toBe(
      'Meeting ended · 1 min · Teams call',
    )
  })

  it('shows what the host is doing until the notes are done, then when it ended', () => {
    expect(endedMeta({ ...r, stage: 'summarizing' }, r.endedAt)).toBe('Writing notes')
    expect(endedMeta({ ...r, stage: 'done' }, r.endedAt)).toMatch(/\d:\d\d [AP]M/)
  })

  it('keeps a meeting tab across a reload of the layout', () => {
    const tab = toolTabFromJson({ kind: 'meeting', id: r.id })
    expect(tab).toEqual({ kind: 'meeting', id: r.id })
    expect(toolTabId(tab!)).toBe(`meeting:${r.id}`)
  })
})
