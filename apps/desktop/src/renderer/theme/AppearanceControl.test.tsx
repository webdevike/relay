import { fireEvent, render, screen } from '@testing-library/react'
import { MantineProvider } from '@mantine/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../ipc', () => ({ invoke: vi.fn(() => Promise.resolve({ ok: true, value: {} })) }))

import { AppearanceControl } from './AppearanceControl'
import { seedTheme, setColorScheme, themeStore } from './theme-config'

function wrap(ui: React.ReactNode) {
  return render(<MantineProvider>{ui}</MantineProvider>)
}

beforeEach(() => {
  seedTheme(undefined)
  setColorScheme('dark')
})

describe('AppearanceControl', () => {
  it('renders Light and Dark in order as a radiogroup with the current scheme active', () => {
    wrap(<AppearanceControl />)
    const group = screen.getByRole('radiogroup', { name: 'Appearance' })
    const ids = [...group.querySelectorAll('[data-testid^="appearance-"]')].map((n) =>
      n.getAttribute('data-testid'),
    )
    expect(ids).toEqual(['appearance-light', 'appearance-dark'])
    expect(screen.getByTestId('appearance-dark')).toHaveAttribute('data-active', 'true')
  })

  it('clicking a segment sets the scheme and keeps the preset', () => {
    wrap(<AppearanceControl />)
    fireEvent.click(screen.getByTestId('appearance-light'))
    expect(themeStore.getState().colorScheme).toBe('light')
    expect(themeStore.getState().preset).toBe('default')
  })

  it('iconOnly hides text and labels each segment', () => {
    wrap(<AppearanceControl iconOnly />)
    expect(screen.queryByText('Light')).toBeNull()
    expect(screen.getByTestId('appearance-light')).toHaveAttribute('aria-label', 'Light')
    expect(screen.getByTestId('appearance-dark')).toHaveAttribute('aria-label', 'Dark')
  })
})
