import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MantineProvider } from '@mantine/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { placeOf } from '@evaos/shell-core'
import { parseThemeDoc } from '@evaos/theme-core'

const invoke = vi.fn()
const MISSING = 'Claude Code was not found. Install it, then try again.'
let harnessStatus = { omp: true, claude: true }
vi.mock('../ipc', () => ({ invoke: (...a: unknown[]) => invoke(...a) }))
vi.mock('@mantine/notifications', () => ({ notifications: { show: vi.fn() } }))

import { SettingsPage } from './SettingsPage'
import { resetSettingsForTest } from './settings-store'
import { initTheme, themeStore } from '../theme/theme-store'
import { pageRegistry } from '../pages/registry'

function page(section: 'Theme' | 'Chat' | 'Notifications') {
  return render(
    <MantineProvider env="test">
      <SettingsPage place={placeOf('settings', { settingsSection: section })} />
    </MantineProvider>,
  )
}

beforeEach(() => {
  invoke.mockReset()
  harnessStatus = { omp: true, claude: true }
  invoke.mockImplementation(async (c: string, input: Record<string, unknown>) => {
    if (c === 'settings.load')
      return { ok: true, value: { show_thinking: false, show_tools: true, harness: 'omp' } }
    if (c === 'chat.harnessStatus') return { ok: true, value: harnessStatus }
    if (c === 'theme.list')
      return {
        ok: true,
        value: {
          themes: [
            { id: 'EvaOS', name: 'EvaOS' },
            { id: 'Flexoki', name: 'Flexoki' },
            { id: 'Gruvbox', name: 'Gruvbox' },
          ],
        },
      }
    return { ok: true, value: { show_thinking: false, show_tools: true, harness: 'omp', ...input } }
  })
  resetSettingsForTest()
  initTheme('system')
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn(),
  })
})

describe('SettingsPage', () => {
  it('loads the catalog and restores the selected family and appearance', async () => {
    initTheme('dark', parseThemeDoc({ base: 'Flexoki', app: { appearance: 'dark' } }))
    page('Theme')
    const picker = screen.getByRole('combobox', { name: 'Theme family' })
    await waitFor(() => expect(picker).toBeEnabled())
    expect(picker).toHaveValue('Flexoki')
    expect(screen.getByRole('radio', { name: 'Dark' })).toBeChecked()
    expect(invoke).toHaveBeenCalledWith('theme.list', {})
  })

  it('picks a catalog family by keyboard and preserves appearance', async () => {
    const user = userEvent.setup()
    page('Theme')
    const picker = screen.getByTestId('theme-family-picker')
    await waitFor(() => expect(picker).toBeEnabled())
    await user.click(picker)
    expect((await screen.findAllByRole('option')).map((option) => option.textContent)).toEqual([
      'EvaOS',
      'Flexoki',
      'Gruvbox',
    ])
    await user.keyboard('{ArrowDown}{Enter}')
    await waitFor(() => expect(picker).toHaveValue('Flexoki'))
    expect(themeStore.getState().doc.base).toBe('Flexoki')
    expect(themeStore.getState().appearance).toBe('system')
    expect(invoke.mock.calls.filter(([channel]) => channel === 'theme.setBase')).toEqual([
      ['theme.setBase', { base: 'Flexoki' }],
    ])
    await user.click(screen.getByRole('radio', { name: 'Light' }))
    expect(themeStore.getState().appearance).toBe('light')
    expect(themeStore.getState().doc.base).toBe('Flexoki')
    expect(invoke).toHaveBeenCalledWith('theme.setAppearance', { appearance: 'light' })
  })

  it('restores the previous selection and reports a save failure', async () => {
    const user = userEvent.setup()
    const original = invoke.getMockImplementation()!
    invoke.mockImplementation((channel: string, input: Record<string, unknown>) =>
      channel === 'theme.setBase'
        ? Promise.resolve({ ok: false, error: { code: 'IO', message: 'read only' } })
        : original(channel, input),
    )
    page('Theme')
    const picker = screen.getByTestId('theme-family-picker')
    await waitFor(() => expect(picker).toBeEnabled())
    await user.click(picker)
    await user.click(await screen.findByRole('option', { name: 'Flexoki' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('previous theme'))
    expect(picker).toHaveValue('EvaOS')
    expect(picker).toBeEnabled()
    expect(themeStore.getState().doc.base).toBe('EvaOS')
  })

  it('shows a catalog failure without offering unavailable families', async () => {
    invoke.mockImplementation(async () => ({
      ok: false,
      error: { code: 'IO', message: 'unavailable' },
    }))
    page('Theme')
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Could not load'))
    expect(screen.getByTestId('theme-family-picker')).toBeDisabled()
    expect(themeStore.getState().doc.base).toBe('EvaOS')
  })

  it('Chat section switches default to Rust values', () => {
    page('Chat')
    expect(screen.getByTestId('settings-chat')).toHaveTextContent(
      "What conversations show besides Eva's replies.",
    )
    const a = screen.getByTestId('settings-show-thinking')
    const b = screen.getByTestId('settings-show-tools')
    expect(a).toHaveAttribute('role', 'switch')
    expect(a).not.toBeChecked()
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
        ['settings.save', { show_thinking: true }],
      ]),
    )
    expect(screen.getByTestId('settings-show-thinking')).toBeChecked()
  })

  it('Harness control saves the choice and explains when Claude Code is missing', async () => {
    harnessStatus = { omp: true, claude: false }
    page('Chat')
    const ctl = screen.getByTestId('settings-harness')
    expect(ctl).toHaveTextContent('omp')
    expect(ctl).toHaveTextContent('Claude Code')
    expect(screen.getByText('Applies to new chats.')).toBeInTheDocument()
    expect(screen.queryByText(MISSING)).toBeNull()
    fireEvent.click(screen.getByText('Claude Code'))
    await waitFor(() =>
      expect(invoke.mock.calls.filter((c) => c[0] === 'settings.save')).toEqual([
        ['settings.save', { harness: 'claude' }],
      ]),
    )
    expect(await screen.findByText(MISSING)).toBeInTheDocument()
  })

  it('Harness notice stays hidden when Claude Code is found', async () => {
    page('Chat')
    fireEvent.click(screen.getByText('Claude Code'))
    await waitFor(() =>
      expect(invoke.mock.calls.filter((c) => c[0] === 'settings.save')).toHaveLength(1),
    )
    expect(screen.queryByText(MISSING)).toBeNull()
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
