import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { DISMISSED_CARDS_KEY, dismissCard, reloadDismissedForTests } from './dismissed-cards'
import { StatusCard } from './StatusCard'

beforeEach(() => {
  localStorage.clear()
  reloadDismissedForTests()
})

describe('StatusCard', () => {
  it('opens its details on a row click, but not on a click in its own button', () => {
    const act = vi.fn()
    render(
      <StatusCard
        id="a"
        line="Join Nova"
        details={<p>Why</p>}
        actions={<button onClick={act}>Join</button>}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Join' }))
    expect(act).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('Why')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Join Nova', expanded: false }))
    expect(screen.getByText('Why')).toBeInTheDocument()
  })

  it('Enter opens the row; Delete dismisses it and calls onDismiss first', () => {
    const order: string[] = []
    const onOpen = vi.fn(() => order.push('open'))
    render(
      <StatusCard
        id="b"
        line="Agent done"
        onOpen={onOpen}
        onDismiss={() => order.push('dismiss')}
      />,
    )
    const row = screen.getByRole('button', { name: 'Agent done' })
    fireEvent.keyDown(row, { key: 'Enter' })
    expect(order).toEqual(['open'])
    fireEvent.keyDown(row, { key: 'Delete' })
    expect(order).toEqual(['open', 'dismiss'])
    expect(screen.queryByText('Agent done')).toBeNull()
  })

  it('the X dismisses without opening, and the card stays gone after a reload', () => {
    const onOpen = vi.fn()
    const { unmount } = render(<StatusCard id="c" line="Room ready" onOpen={onOpen} />)
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(onOpen).not.toHaveBeenCalled()
    expect(screen.queryByText('Room ready')).toBeNull()
    expect(JSON.parse(localStorage.getItem(DISMISSED_CARDS_KEY)!)).toEqual(['c'])
    unmount()
    reloadDismissedForTests()
    render(<StatusCard id="c" line="Room ready" onOpen={onOpen} />)
    expect(screen.queryByText('Room ready')).toBeNull()
    render(<StatusCard id="d" line="Other card" onOpen={onOpen} />)
    expect(screen.getByText('Other card')).toBeInTheDocument()
  })

  it('keeps only the newest dismissals and reads damaged storage as none', () => {
    for (let i = 0; i < 520; i++) dismissCard(`k${i}`)
    const kept = JSON.parse(localStorage.getItem(DISMISSED_CARDS_KEY)!) as string[]
    expect(kept).toHaveLength(500)
    expect(kept[0]).toBe('k20')
    localStorage.setItem(DISMISSED_CARDS_KEY, '{not json')
    reloadDismissedForTests()
    render(<StatusCard id="k519" line="Back again" />)
    expect(screen.getByText('Back again')).toBeInTheDocument()
  })
})
