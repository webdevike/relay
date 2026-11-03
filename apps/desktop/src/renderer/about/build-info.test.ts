import { describe, expect, it } from 'vitest'
import type { ChangelogEntry } from '@evaos/contract'
import { brandTooltip, formatStamp, groupByDay, hostLabel } from './build-info'

describe('build info formatting', () => {
  it('formats a stamp as month, day and time, leaving a bad one as it came', () => {
    expect(formatStamp('2026-11-03T10:22:00')).toBe('Nov 3, 10:22 AM')
    expect(formatStamp('soon')).toBe('soon')
  })

  it('the logo tooltip names the short sha and the build date', () => {
    expect(brandTooltip('31e55632a7', '2026-11-03T10:22:00')).toBe(
      'Relay 31e5563 · Nov 3, 10:22 AM',
    )
    expect(brandTooltip(null, '2026-11-03T10:22:00')).toBe('Relay dev · Nov 3, 10:22 AM')
  })

  it('says the host version, the name alone when it sent none, and when not connected', () => {
    expect(hostLabel({ hostName: 'Mini', hostVersion: '0.2.51' })).toBe('Mini 0.2.51')
    expect(hostLabel({ hostName: 'Mini', hostVersion: null })).toBe('Mini')
    expect(hostLabel({ hostName: null, hostVersion: null })).toBe('Not connected')
  })

  it('groups entries into local days, keeping their order', () => {
    const d = (build: string, at: string): ChangelogEntry => ({
      kind: 'desktop',
      build,
      at,
      changes: [],
    })
    const days = groupByDay([
      d('c', '2026-11-03T15:00:00'),
      d('b', '2026-11-03T09:00:00'),
      d('a', '2026-11-02T22:00:00'),
    ])
    expect(days.map((x) => [x.day, x.entries.length])).toEqual([
      ['Tuesday, November 3', 2],
      ['Monday, November 2', 1],
    ])
  })
})
