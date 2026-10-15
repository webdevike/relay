import { MantineProvider } from '@mantine/core'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ChatRow as Row } from '@evaos/contract'
import { ChatRow } from './ChatRow'

const base: Row = {
  id: 'p4-x',
  file: '/s/p4-x.jsonl',
  title: 'Some chat',
  mtimeMs: 1,
  archived: false,
  pinned: false,
  running: false,
  status: null,
}
const wrap = (row: Row, onOpen = vi.fn()) =>
  render(
    <MantineProvider>
      <ChatRow row={row} active={false} onOpen={onOpen} />
    </MantineProvider>,
  )

describe('ChatRow', () => {
  it('labels the indicator and shows trailing text for non-open states', () => {
    wrap({ ...base, status: 'needs-approval' })
    expect(screen.getByLabelText('Needs approval')).toBeInTheDocument()
    expect(screen.getByTestId('chat-row-p4-x')).toHaveTextContent('Needs approval')
  })

  it('open has an Open label but no trailing text; null has no label', () => {
    const { unmount } = wrap({ ...base, status: 'open' })
    expect(screen.getByLabelText('Open')).toBeInTheDocument()
    expect(screen.getByTestId('chat-row-p4-x')).toHaveTextContent(/^Some chat$/)
    unmount()
    wrap(base)
    expect(screen.queryByRole('img')).toBeNull()
  })

  it('click passes the row and the event', () => {
    const onOpen = vi.fn()
    wrap(base, onOpen)
    fireEvent.click(screen.getByTestId('chat-row-p4-x'), { metaKey: true })
    expect(onOpen.mock.calls[0][0]).toBe(base)
    expect(onOpen.mock.calls[0][1].metaKey).toBe(true)
  })
})
