import { describe, expect, it } from 'vitest'
import type { ChangelogEntry, UpdateState } from '@evaos/contract'
import { changesSince, restartNote, updateChipVisible, updateSummaryLine } from './update-badge'

const pending: UpdateState = { pending: true, build: 'b42', summary: 'Faster chat list' }
const none: UpdateState = { pending: false, build: null, summary: null }

const desktop = (build: string, changes: string[]): ChangelogEntry => ({
  kind: 'desktop',
  build,
  at: '2026-11-03T10:00:00Z',
  changes,
})
// Newest first, like parseHistory returns it.
const HISTORY: ChangelogEntry[] = [
  desktop('ccccccc111', ['Third A', 'Third B']),
  { kind: 'host', version: '0.2.52', at: '2026-11-03T09:00:00Z' },
  desktop('bbbbbbb222', ['Second']),
  desktop('aaaaaaa333', ['First']),
]

describe('updateChipVisible', () => {
  it('shows only when an update waits and the sidebar is not on screen', () => {
    expect(updateChipVisible(pending, 'open')).toBe(false)
    expect(updateChipVisible(pending, 'hidden')).toBe(true)
    expect(updateChipVisible(pending, 'folded')).toBe(true)
    expect(updateChipVisible(none, 'hidden')).toBe(false)
  })
})

describe('updateSummaryLine', () => {
  it('prefers the summary, then the build, then a plain line', () => {
    expect(updateSummaryLine(pending)).toBe('Faster chat list')
    expect(updateSummaryLine({ ...pending, summary: null })).toBe('Build b42')
    expect(updateSummaryLine({ pending: true, build: null, summary: null })).toBe(
      'A new build is ready',
    )
  })
})

describe('changesSince', () => {
  it('lists every desktop deploy newer than the running build, skipping host installs', () => {
    expect(changesSince(HISTORY, 'aaaaaaa333', 'ccccccc111')).toEqual(['Third A', 'Third B', 'Second'])
    expect(changesSince(HISTORY, 'bbbbbbb222xyz', 'ccccccc111')).toEqual(['Third A', 'Third B'])
  })
  it('falls back to the pending build when the running build is not in the history', () => {
    expect(changesSince(HISTORY, 'ddddddd', 'bbbbbbb222')).toEqual(['Second'])
    expect(changesSince(HISTORY, null, 'ccccccc111')).toEqual(['Third A', 'Third B'])
  })
  it('is empty when the history knows neither build', () => {
    expect(changesSince(HISTORY, 'ddddddd', 'eeeeeee')).toEqual([])
    expect(changesSince([], 'aaaaaaa', 'bbbbbbb')).toEqual([])
  })
})

describe('restartNote', () => {
  it('is null when nothing is running', () => {
    expect(restartNote([])).toBeNull()
  })
  it('names one running chat', () => {
    expect(restartNote(['Fix login'])).toBe(
      '1 chat is working and will stop: Fix login. Resume it after the restart.',
    )
  })
  it('caps the list at three and names untitled chats', () => {
    expect(restartNote(['A', '', 'C', 'D', 'E'])).toBe(
      '5 chats are working and will stop: A, Untitled chat, C, and 2 more. Resume them after the restart.',
    )
  })
})
