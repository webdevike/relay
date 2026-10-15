import { describe, expect, it } from 'vitest'
import { parseProtocol } from './protocol'

const PROTOCOL = `# Meeting Protocol - Team Daily Standup
**Date:** 2026-10-07
**Time:** 11:30
**Attendees:** David Taylor, Steve Arms, sime@spaceinch.com, Isaac Weber (Outlook: "SCRUM")

---

## Summary
The team gave **daily** status updates,
centered on release 126.

Finance meets on Monday.

## Participants
- Adam (impact review)

## Decisions
- Critical SmartTrack fix comes first.
- Tomislav will deliver a design document
  for 5996.

## Tasks
| Task | Responsible |
|------|-------------|
| Ping CJ | Elijah |

## Open Questions
- Who owns 5996?

---

## Full Transcript

[00:32] R_S5: Hello everybody. How's it going?
[00:37] R_S5: Hey. Pretty good.
[00:38] Yeah. Is this working? Hello: anyone
continues here
[01:34] Andy Weisensel: Okay.
`

describe('parseProtocol', () => {
  it('matches the Rust sample', () => {
    const p = parseProtocol(PROTOCOL)
    expect(p.summary).toEqual([
      'The team gave daily status updates, centered on release 126.',
      'Finance meets on Monday.',
    ])
    expect(p.attendees).toEqual(['David Taylor', 'Steve Arms', 'sime@spaceinch.com', 'Isaac Weber'])
    expect(p.attendeesSource).toBe('Outlook: "SCRUM"')
    expect(p.decisions).toEqual([
      'Critical SmartTrack fix comes first.',
      'Tomislav will deliver a design document for 5996.',
    ])
    expect(p.questions).toEqual(['Who owns 5996?'])
    expect(p.transcript).toEqual([
      { time: '00:32', speaker: 'R_S5', text: "Hello everybody. How's it going?" },
      { time: '00:37', speaker: 'R_S5', text: 'Hey. Pretty good.' },
      { time: '00:38', speaker: null, text: 'Yeah. Is this working? Hello: anyone continues here' },
      { time: '01:34', speaker: 'Andy Weisensel', text: 'Okay.' },
    ])
  })
  it('parses attendee sources', () => {
    const a = parseProtocol('**Attendees:** A, B (Source: "x: y")')
    expect(a.attendees).toEqual(['A', 'B'])
    expect(a.attendeesSource).toBe('Source: "x: y"')
    const b = parseProtocol('**Attendees:** A, B (maybe)')
    expect(b.attendees).toEqual(['A', 'B (maybe)'])
    expect(b.attendeesSource).toBeNull()
    expect(parseProtocol('**Attendees:** Ann, Bob\n## Summary\n').attendees).toEqual(['Ann', 'Bob'])
  })
  it('wraps summary and bullets', () => {
    const p = parseProtocol('## Summary\na **b**\nc\n\nd\n## Decisions\n* x\n  y\n- z\n')
    expect(p.summary).toEqual(['a b c', 'd'])
    expect(p.decisions).toEqual(['x y', 'z'])
  })
  it('detects speakers', () => {
    const p = parseProtocol(
      [
        '## Full Transcript',
        '[00:05] Sam: Beta is ready',
        '[00:09] text only',
        '[00:10] One two three four five: nope',
        '[00:11] ' + 'x'.repeat(41) + ': nope',
        '[00:12] Dr. Who: nope',
        '[00:13] URL http://x',
        'tail',
      ].join('\n'),
    )
    expect(p.transcript[0]).toEqual({ time: '00:05', speaker: 'Sam', text: 'Beta is ready' })
    expect(p.transcript[1]!.speaker).toBeNull()
    expect(p.transcript[2]!.speaker).toBeNull()
    expect(p.transcript[3]!.speaker).toBeNull()
    expect(p.transcript[4]!.speaker).toBeNull()
    expect(p.transcript[5]!.speaker).toBeNull()
    expect(p.transcript[5]!.text).toBe('URL http://x tail')
  })
  it('ignores titles, rules and unknown sections; empty input', () => {
    const p = parseProtocol('# Title\n---\n## Other\nstuff\n## Summary\nok')
    expect(p.summary).toEqual(['ok'])
    expect(parseProtocol('')).toEqual({
      attendees: [], attendeesSource: null, summary: [], decisions: [], questions: [], transcript: [],
    })
  })
})
