import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MantineProvider } from '@mantine/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { placeOf } from '@evaos/shell-core'

const invoke = vi.fn()
vi.mock('../ipc', () => ({ invoke: (...a: unknown[]) => invoke(...a) }))
vi.mock('@mantine/notifications', () => ({ notifications: { show: vi.fn() } }))
vi.mock('../theme/theme-store', () => ({
  setAppearance: vi.fn(),
  useAppearance: () => 'system',
}))

import { SettingsPage } from './SettingsPage'
import { resetSettingsForTest } from './settings-store'
import { pageRegistry } from '../pages/registry'

function page(section: 'Theme' | 'Chat' | 'Notifications') {
  return render(
    <MantineProvider>
      <SettingsPage place={placeOf('settings', { settingsSection: section })} />
    </MantineProvider>,
  )
}

beforeEach(() => {
  invoke.mockReset()
  invoke.mockImplementation(async (c: string, input: Record<string, boolean>) =>
    c === 'settings.load'
      ? { ok: true, value: { show_thinking: true, show_tools: true } }
      : { ok: true, value: { show_thinking: true, show_tools: true, ...input } },
  )
  resetSettingsForTest()
})

describe('SettingsPage', () => {
  it('Theme section', () => {
    page('Theme')
    const root = screen.getByTestId('settings-theme')
    expect(root).toHaveTextContent('Colors, fonts and shape for the whole app.')
    expect(screen.getByText('Appearance')).toBeInTheDocument()
    expect(screen.getByText('Light, Dark or System. System follows your Mac.')).toBeInTheDocument()
    const ctl = screen.getByTestId('appearance-settings')
    for (const l of ['Light', 'Dark', 'System']) expect(ctl).toHaveTextContent(l)
    expect(screen.getByText('Theme editor')).toBeInTheDocument()
    expect(
      screen.getByText('Editing colors, fonts and shape arrives in a later update.'),
    ).toBeInTheDocument()
  })

  it('Chat section switches default on', () => {
    page('Chat')
    expect(screen.getByTestId('settings-chat')).toHaveTextContent(
      "What conversations show besides Eva's replies.",
    )
    const a = screen.getByTestId('settings-show-thinking')
    const b = screen.getByTestId('settings-show-tools')
    expect(a).toHaveAttribute('role', 'switch')
    expect(a).toBeChecked()
    expect(b).toBeChecked()
    expect(
      screen.getByText("The model's reasoning before each reply, in gray."),
    ).toBeInTheDocument()
    expect(screen.getByText('Show tool details')).toBeInTheDocument()
  })

  it('clicking the label text toggles once', async () => {
    page('Chat')
    fireEvent.click(screen.getByText('Show thinking'))
    await waitFor(() =>
      expect(invoke.mock.calls.filter((c) => c[0] === 'settings.save')).toEqual([
        ['settings.save', { show_thinking: false }],
      ]),
    )
    expect(screen.getByTestId('settings-show-thinking')).not.toBeChecked()
  })

  it('Notifications section', () => {
    page('Notifications')
    expect(screen.getByTestId('settings-notifications')).toHaveTextContent(
      'How the inbox tells you about new items.',
    )
    expect(screen.getByText('Notification settings')).toBeInTheDocument()
    expect(
      screen.getByText('Delivery, quiet hours and digests arrive in a later update.'),
    ).toBeInTheDocument()
  })

  it('registry maps settings to SettingsPage and has no em dash', () => {
    expect(pageRegistry.settings).toBe(SettingsPage)
    const files = import.meta.glob('./*.{ts,tsx,css}', {
      query: '?raw',
      import: 'default',
      eager: true,
    }) as Record<string, string>
    const dash = String.fromCharCode(8212)
    for (const [f, src] of Object.entries(files)) {
      if (f.includes('.test.')) continue
      expect(src).not.toContain(dash)
    }
  })
})
