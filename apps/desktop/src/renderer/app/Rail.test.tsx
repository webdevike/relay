import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Rail } from './Rail'

const info = (live: boolean) => ({
  ok: true,
  value: {
    evaRoot: '/x',
    configDir: '/c',
    ompBin: 'o',
    sessionsDir: '/s',
    live,
    e2e: false,
    launchCount: 1,
    version: '1',
  },
})

describe('Rail', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('shows the wordmark and the fixture badge', async () => {
    window.eva = { invoke: vi.fn(async () => info(false)), on: vi.fn() } as unknown as Window['eva']
    render(<Rail />)
    expect(screen.getByText('EvaOS')).toBeInTheDocument()
    expect(await screen.findByText('Fixture data')).toBeInTheDocument()
  })

  it('shows the live badge when live', async () => {
    window.eva = { invoke: vi.fn(async () => info(true)), on: vi.fn() } as unknown as Window['eva']
    render(<Rail />)
    expect(await screen.findByText('Live Eva data')).toBeInTheDocument()
  })
})
