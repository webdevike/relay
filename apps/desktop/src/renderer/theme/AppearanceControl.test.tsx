import { fireEvent, render, screen } from '@testing-library/react'
import { MantineProvider } from '@mantine/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const setAppearance = vi.fn()
vi.mock('./theme-store', () => ({
  setAppearance: (a: string) => setAppearance(a),
  useAppearance: () => 'dark',
}))

import { AppearanceControl } from './AppearanceControl'

function wrap(ui: React.ReactNode) {
  return render(<MantineProvider>{ui}</MantineProvider>)
}

beforeEach(() => setAppearance.mockReset())

describe('AppearanceControl', () => {
  it('renders Light, Dark, System in order as a radiogroup', () => {
    wrap(<AppearanceControl />)
    const group = screen.getByRole('radiogroup', { name: 'Appearance' })
    const ids = [...group.querySelectorAll('[data-testid^="appearance-"]')].map((n) =>
      n.getAttribute('data-testid'),
    )
    expect(ids).toEqual(['appearance-light', 'appearance-dark', 'appearance-system'])
    expect(screen.getByText('Light')).toBeInTheDocument()
    expect(screen.getByTestId('appearance-dark')).toHaveAttribute('data-active', 'true')
  })

  it('clicking a segment calls setAppearance', () => {
    wrap(<AppearanceControl />)
    fireEvent.click(screen.getByTestId('appearance-light'))
    expect(setAppearance).toHaveBeenCalledWith('light')
  })

  it('iconOnly hides text and labels each segment', () => {
    wrap(<AppearanceControl iconOnly />)
    expect(screen.queryByText('Light')).toBeNull()
    expect(screen.getByTestId('appearance-light')).toHaveAttribute('aria-label', 'Light')
    expect(screen.getByTestId('appearance-system')).toHaveAttribute('aria-label', 'System')
  })

  it('accepts a root testid', () => {
    wrap(<AppearanceControl testid="appearance-settings" />)
    expect(screen.getByTestId('appearance-settings')).toBeInTheDocument()
  })
})
