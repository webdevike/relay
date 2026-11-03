import { MantineProvider } from '@mantine/core'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ChatRow as Row } from '@evaos/contract'

vi.mock('../../ipc', () => ({ invoke: async () => ({ ok: true, value: {} }), on: () => () => {} }))

import { ChatRow, type ChatRowProps } from './ChatRow'
import { chatRow } from './test-rows'

const NOW = 100_000
const base: Row = chatRow('p4-x', 'Some chat', { returnedMs: NOW - 18 * 60_000 })
const wrap = (row: Row, props: Partial<ChatRowProps> = {}) =>
  render(
    <MantineProvider>
      <ChatRow
        row={row}
        category="Relay"
        nested
        settled={false}
        now={NOW}
        active={false}
        onOpen={vi.fn()}
        {...props}
      />
    </MantineProvider>,
  )
const el = () => screen.getByTestId('chat-row-p4-x')

describe('ChatRow', () => {
  it('nested: the title on line 1 with the age, muted when read', () => {
    wrap(base)
    expect(el().querySelector('.eva-cl-line1')).toHaveTextContent(/^Some chat18m/)
    expect(el().querySelector('.eva-cl-title')).not.toHaveAttribute('data-bright')
    expect(el().querySelector('.eva-cl-badge-img')).toBeNull()
  })

  it('not nested: badge and workspace on line 1, the title on line 2', () => {
    wrap(base, { nested: false, category: 'Other' })
    expect(el().querySelector('.eva-cl-line1')).toHaveTextContent(/^OTOther18m/)
    expect(el().querySelector('.eva-cl-line2')).toHaveTextContent('Some chat')
  })

  it('a working chat shows the Working pill counting from its run start', () => {
    wrap({ ...base, running: true, status: 'working', startedMs: NOW - 16_000 })
    expect(el()).toHaveTextContent('Working 16s')
    expect(el()).toHaveAccessibleName('Some chat, Working')
    expect(el().querySelector('.eva-cl-spinner')).not.toBeNull()
  })

  it('unread is bright with Done; woke shows the Woke chip', () => {
    const { unmount } = wrap({ ...base, openedMs: null })
    expect(el().querySelector('.eva-cl-title')).toHaveAttribute('data-bright', 'true')
    expect(el()).toHaveTextContent('Done')
    unmount()
    wrap({ ...base, wokeMs: 1 })
    expect(el()).toHaveTextContent('Woke')
  })

  it('pin and snooze flags, and the work line with branch and PR', () => {
    wrap({
      ...base,
      pinned: true,
      snoozedUntilMs: NOW + 1,
      work: { key: 'ENG-1', branch: 'feat/x', pr: 225 },
    })
    expect(screen.getByLabelText('Pinned')).toBeInTheDocument()
    expect(screen.getByLabelText('Snoozed')).toBeInTheDocument()
    expect(el().querySelector('.eva-cl-line3')).toHaveTextContent('ENG-1 · feat/x#225')
  })

  it('no work line without a label or PR', () => {
    wrap(base)
    expect(el().querySelector('.eva-cl-line3')).toBeNull()
  })

  it('quick Settle does not open the chat', () => {
    const onOpen = vi.fn()
    const onSettle = vi.fn()
    wrap(base, { onOpen, onSettle, onSnooze: vi.fn() })
    fireEvent.click(screen.getByTestId('chat-settle-p4-x'))
    expect(onSettle).toHaveBeenCalledWith(base, true)
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('the hover card shows the workspace, work and model after a moment', async () => {
    wrap({ ...base, model: 'anthropic/claude-opus-5-5', work: { key: null, branch: 'b', pr: 3 } })
    fireEvent.mouseEnter(el())
    expect(screen.queryByTestId('chat-card')).toBeNull()
    const card = await screen.findByTestId('chat-card', {}, { timeout: 2000 })
    expect(card).toHaveTextContent('Relay')
    expect(card).toHaveTextContent('b · #3')
    expect(card).toHaveTextContent('Claude Opus 5.5')
  })

  it('click and Enter pass the row and the event', () => {
    const onOpen = vi.fn()
    wrap(base, { onOpen })
    fireEvent.click(el(), { metaKey: true })
    expect(onOpen.mock.calls[0][0]).toBe(base)
    expect(onOpen.mock.calls[0][1].metaKey).toBe(true)
    fireEvent.keyDown(el(), { key: 'Enter' })
    expect(onOpen).toHaveBeenCalledTimes(2)
  })
})
