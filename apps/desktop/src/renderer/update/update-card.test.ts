import { describe, expect, it } from 'vitest'
import type { UpdateState } from '@evaos/contract'
import { restartTooltip, updateCardLine, updateChipVisible } from './update-card'

const pending: UpdateState = { pending: true, build: 'b42', summary: 'Faster chat list' }
const none: UpdateState = { pending: false, build: null, summary: null }

describe('updateChipVisible', () => {
  it('shows only when an update waits and the sidebar is not on screen', () => {
    expect(updateChipVisible(pending, 'open')).toBe(false)
    expect(updateChipVisible(pending, 'hidden')).toBe(true)
    expect(updateChipVisible(pending, 'folded')).toBe(true)
    expect(updateChipVisible(none, 'hidden')).toBe(false)
  })
})

describe('updateCardLine', () => {
  it('prefers the summary, then the build, then a plain line', () => {
    expect(updateCardLine(pending)).toBe('Faster chat list')
    expect(updateCardLine({ ...pending, summary: null })).toBe('Build b42')
    expect(updateCardLine({ pending: true, build: null, summary: null })).toBe(
      'A new build is ready',
    )
  })
})

describe('restartTooltip', () => {
  it('is plain when nothing is running', () => {
    expect(restartTooltip([])).toBe('Restart Relay into the update')
  })
  it('names one running chat', () => {
    expect(restartTooltip(['Fix login'])).toBe(
      '1 chat is working and will stop: Fix login. Resume it after the restart.',
    )
  })
  it('caps the list at three and names untitled chats', () => {
    expect(restartTooltip(['A', '', 'C', 'D', 'E'])).toBe(
      '5 chats are working and will stop: A, Untitled chat, C, and 2 more. Resume them after the restart.',
    )
  })
})
