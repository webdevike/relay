import { describe, expect, it } from 'vitest'
import { aliasesFor, canonicalTag } from './tags'
import { displayName, plain, tagline, taglineOf } from './plain'
import {
  activeSince,
  addDays,
  daysBetween,
  isoWeekStart,
  localDate,
  makeClock,
  relativeLabel,
} from './dates'
import { parseJournal, parseJournalHeading } from './journal'

const DASH = '—'

describe('tags', () => {
  it('canonicalises tags and aliases', () => {
    expect(canonicalTag('eva/e3')).toBe('eva')
    expect(canonicalTag(' Flo ')).toBe('flo')
    expect(canonicalTag('goodword')).toBe('goodops')
    expect(canonicalTag('eva-app')).toBe('eva-interface')
    expect(aliasesFor('goodops')).toEqual(['goodword'])
    expect(aliasesFor('flo')).toEqual([])
  })
})

describe('plain', () => {
  it('strips markdown', () => {
    expect(plain(' Ship **iOS** `build` ')).toBe('Ship iOS build')
    expect(plain('see [the docs](https://x.y/z) now')).toBe('see the docs now')
  })
  it('derives display names', () => {
    expect(displayName(`Flo ${DASH} Field ops (beta)`)).toBe('Flo')
    expect(displayName('GoodOps (formerly GoodWord)')).toBe('GoodOps')
    expect(displayName(`OpenFlight ${DASH} DIY golf launch monitor`)).toBe('OpenFlight')
  })
  it('derives taglines', () => {
    expect(taglineOf('Status: Live and shipping. More text here.')).toBe('Live and shipping.')
    expect(taglineOf('A long label here: kept as is')).toBe('A long label here: kept as is')
    expect(taglineOf('- **What:** a thing')).toBe('a thing')
    const text = '# Flo\n\n\nField ops tool\nthat wraps. Second.\n\n## Next\n'
    expect(tagline(text)).toBe('Field ops tool that wraps.')
    expect(tagline('# Flo\n| table |\n')).toBe('')
    expect(tagline('no heading at all')).toBe('')
  })
})

describe('dates', () => {
  it('formats local dates and diffs across DST', () => {
    expect(localDate(new Date(2026, 9, 5, 23, 30))).toBe('2026-10-05')
    expect(daysBetween('2026-10-01', '2026-10-15')).toBe(14)
    expect(daysBetween('2026-03-01', '2026-04-01')).toBe(31)
    expect(daysBetween('2026-10-15', '2026-10-01')).toBe(-14)
    expect(addDays('2026-10-15', -7)).toBe('2026-10-08')
    expect(addDays('2026-12-30', 3)).toBe('2027-01-02')
  })
  it('finds the iso week start', () => {
    expect(isoWeekStart('2026-10-15')).toBe('2026-10-12')
    expect(isoWeekStart('2026-10-12')).toBe('2026-10-12')
    expect(isoWeekStart('2026-10-18')).toBe('2026-10-12')
  })
  it('shifts the clock by a fixed offset that keeps moving', () => {
    let t = Date.parse('2026-01-01T00:00:00Z')
    const clock = makeClock('2026-10-15T12:00:00Z', () => t)
    expect(clock.now().toISOString()).toBe('2026-10-15T12:00:00.000Z')
    t += 5000
    expect(clock.now().toISOString()).toBe('2026-10-15T12:00:05.000Z')
    const real = makeClock(null, () => t)
    expect(real.now().getTime()).toBe(t)
    expect(real.today()).toBe(localDate(new Date(t)))
  })
  it('labels relative days', () => {
    const today = '2026-10-15'
    expect(relativeLabel(null, today)).toBe('No activity')
    expect(relativeLabel('2026-10-15', today)).toBe('Today')
    expect(relativeLabel('2026-10-14', today)).toBe('Yesterday')
    expect(relativeLabel('2026-10-10', today)).toBe('5d ago')
    expect(relativeLabel('2026-10-02', today)).toBe('13d ago')
    expect(relativeLabel('2026-10-01', today)).toBe('Oct 1')
    expect(activeSince(null, today)).toBe('never')
    expect(activeSince('2026-10-15', today)).toBe('today')
    expect(activeSince('2026-10-14', today)).toBe('yesterday')
    expect(activeSince('2026-10-10', today)).toBe('5d ago')
    expect(activeSince('2026-09-14', today)).toBe('Sep 14')
  })
})

describe('journal', () => {
  it('parses headings in every house style', () => {
    const cases: [string, string, string][] = [
      ['## 2026-10-01 [relay] Relay host', 'relay', 'Relay host'],
      [`## 2026-08-19 ${DASH} [flo] Portless login fixed`, 'flo', 'Portless login fixed'],
      [`## 2026-08-19 (cont2) ${DASH} [eva] omp xdev catalog`, 'eva', 'omp xdev catalog'],
      ['## 2026-07-20 [goodword] `$screen` fix', 'goodops', '$screen fix'],
      [`## 2026-07-30 ${DASH} [eva/e3] PR tab`, 'eva', 'PR tab'],
    ]
    for (const [line, tag, title] of cases) {
      const e = parseJournalHeading(line, 'f.md')
      expect(e, line).not.toBeNull()
      expect([e!.tag, e!.title]).toEqual([tag, title])
    }
    expect(parseJournalHeading(`## 2026-07-07 ${DASH} Eva hub bootstrapped`, 'f.md')).toBeNull()
    expect(parseJournalHeading('## Digest', 'f.md')).toBeNull()
  })
  it('collects top level bullets until the next heading', () => {
    const text =
      '# Journal\n\n## Digest\n- not an entry\n\n## 2026-10-01 [relay] Host\n- built `daemon`\n  - nested detail\n- verified\n\n## 2026-10-02 [eva] Next\n'
    const entries = parseJournal(text, 'memory/journal.md')
    expect(entries).toHaveLength(2)
    expect(entries[0]!.body).toEqual(['built daemon', 'verified'])
    expect(entries[0]!.file).toBe('memory/journal.md')
    expect(entries[1]!.body).toEqual([])
  })
})
