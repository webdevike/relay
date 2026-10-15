import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MantineProvider } from '@mantine/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { placeOf } from '@evaos/shell-core'
import { exportTheme, parseThemeDoc } from '@evaos/theme-core'

const invoke = vi.fn()
const MISSING = 'Claude Code was not found. Install it, then try again.'
let harnessStatus = { omp: true, claude: true }
vi.mock('../ipc', () => ({ invoke: (...a: unknown[]) => invoke(...a) }))
vi.mock('@mantine/notifications', () => ({ notifications: { show: vi.fn() } }))

import { SettingsPage } from './SettingsPage'
import { resetSettingsForTest } from './settings-store'
import { initTheme, themeStore } from '../theme/theme-store'
import { pageRegistry } from '../pages/registry'
import { dismissTop } from '../hotkeys/dismiss'

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
    const picker = screen.getByRole('button', { name: 'Theme family' })
    await waitFor(() => expect(picker).toBeEnabled())
    expect(picker).toHaveTextContent('Flexoki')
    expect(screen.getByRole('radio', { name: 'Dark' })).toBeChecked()
    expect(invoke).toHaveBeenCalledWith('theme.list', {})
  })

  it('picks a catalog family by keyboard and preserves appearance', async () => {
    const user = userEvent.setup()
    page('Theme')
    const picker = screen.getByTestId('theme-family-picker')
    await waitFor(() => expect(picker).toBeEnabled())
    await user.click(picker)
    await screen.findByRole('menuitem', { name: 'Flexoki' })
    await user.keyboard('{ArrowDown}{ArrowDown}{Enter}')
    await waitFor(() => expect(picker).toHaveTextContent('Flexoki'))
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
    await user.click(await screen.findByRole('menuitem', { name: 'Flexoki' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('previous theme'))
    expect(picker).toHaveTextContent('EvaOS')
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

  it('occludes the browser for menus and color pickers and joins the Escape dismissal ladder', async () => {
    const user = userEvent.setup()
    page('Theme')
    const family = screen.getByTestId('theme-family-picker')
    await waitFor(() => expect(family).toBeEnabled())
    await user.click(family)
    await waitFor(() => expect(invoke).toHaveBeenLastCalledWith('browser.setOccluded', { occluded: true }))
    act(() => { expect(dismissTop()).toBe(true) })
    await waitFor(() => expect(invoke).toHaveBeenLastCalledWith('browser.setOccluded', { occluded: false }))
    await user.click(screen.getByRole('button', { name: 'Pick background color' }))
    await waitFor(() => expect(invoke).toHaveBeenLastCalledWith('browser.setOccluded', { occluded: true }))
    act(() => { expect(dismissTop()).toBe(true) })
    await waitFor(() => expect(invoke).toHaveBeenLastCalledWith('browser.setOccluded', { occluded: false }))
    await user.click(within(screen.getByTestId('theme-preview')).getByRole('button', { name: 'Open menu' }))
    await waitFor(() => expect(invoke).toHaveBeenLastCalledWith('browser.setOccluded', { occluded: true }))
    act(() => { expect(dismissTop()).toBe(true) })
    await waitFor(() => expect(invoke).toHaveBeenLastCalledWith('browser.setOccluded', { occluded: false }))
  })

  it('renders the full native editor and all live preview panels', () => {
    page('Theme')
    expect(screen.getByTestId('theme-editor')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Theme' })).not.toBeInTheDocument()
    for (const name of ['Colors', 'Typography', 'Syntax', 'Other', 'Export']) {
      expect(screen.getByRole('tab', { name })).toBeInTheDocument()
    }
    const preview = within(screen.getByTestId('theme-preview'))
    for (const name of ['Buttons', 'Controls', 'Tabs and tags', 'Alerts', 'Chart colors', 'Text and code', 'Popover and menu']) {
      expect(preview.getByRole('region', { name })).toBeInTheDocument()
    }
    expect(preview.getByRole('img', { name: /Ten bars/ }).children).toHaveLength(10)
  })

  it('searches every property section and persists mode colors with undo, redo and reset', async () => {
    const user = userEvent.setup()
    initTheme('dark')
    page('Theme')
    const search = screen.getByTestId('theme-property-search')
    fireEvent.change(search, { target: { value: 'background' } })
    const color = screen.getByRole('textbox', { name: 'background' })
    fireEvent.change(color, { target: { value: '#102030' } })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Undo' })).toBeEnabled())
    expect(themeStore.getState().doc.dark.edits.background).toBe('#102030')
    expect(themeStore.getState().doc.light.edits.background).toBeUndefined()
    expect(invoke).toHaveBeenCalledWith('theme.saveDoc', expect.objectContaining({ doc: expect.any(Object) }))
    await user.click(screen.getByRole('button', { name: 'Undo' }))
    await waitFor(() => expect(themeStore.getState().doc.dark.edits.background).toBeUndefined())
    await waitFor(() => expect(screen.getByRole('button', { name: 'Redo' })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: 'Redo' }))
    await waitFor(() => expect(themeStore.getState().doc.dark.edits.background).toBe('#102030'))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Reset Dark' })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: 'Reset Dark' }))
    await waitFor(() => expect(themeStore.getState().doc.dark.edits).toEqual({}))
    fireEvent.change(search, { target: { value: 'font.family' } })
    expect(screen.getByRole('combobox', { name: 'Font family' })).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Code font family' })).toBeInTheDocument()
  })

  it('saves typography and shared shape edits without losing mode colors', async () => {
    const user = userEvent.setup()
    initTheme('dark', parseThemeDoc({ dark: { edits: { background: '#102030' } } }))
    page('Theme')
    await user.click(screen.getByRole('tab', { name: 'Typography' }))
    const font = screen.getByRole('combobox', { name: 'Font family' })
    fireEvent.change(font, { target: { value: 'Georgia' } })
    fireEvent.blur(font)
    await waitFor(() => expect(themeStore.getState().doc.shared['font.family']).toBe('Georgia'))
    await user.click(screen.getByRole('tab', { name: 'Other' }))
    const shadows = screen.getByRole('switch', { name: 'Control shadows' })
    const previous = (shadows as HTMLInputElement).checked
    await user.click(shadows)
    await waitFor(() => expect(themeStore.getState().doc.shared.shadow).toBe(!previous))
    expect(themeStore.getState().doc.dark.edits.background).toBe('#102030')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Reset shared edits' })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: 'Reset shared edits' }))
    await waitFor(() => expect(themeStore.getState().doc.shared).toEqual({}))
    expect(themeStore.getState().doc.dark.edits.background).toBe('#102030')
  })

  it('edits real syntax colors, italic and bold styles', async () => {
    const user = userEvent.setup()
    initTheme('dark', parseThemeDoc({ dark: { edits: { highlight: { syntax: { keyword: { font_style: 'normal', font_weight: 400 } } } } } }))
    page('Theme')
    await user.click(screen.getByRole('tab', { name: 'Syntax' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Syntax keyword color' }), { target: { value: '#aabbcc' } })
    await waitFor(() => expect(themeStore.getState().doc.dark.edits.highlight?.syntax?.keyword?.color).toBe('#aabbcc'))
    await user.click(screen.getByRole('button', { name: 'Italic keyword' }))
    await waitFor(() => expect(themeStore.getState().doc.dark.edits.highlight?.syntax?.keyword?.font_style).toBe('italic'))
    await user.click(screen.getByRole('button', { name: 'Bold keyword' }))
    await waitFor(() => expect(themeStore.getState().doc.dark.edits.highlight?.syntax?.keyword?.font_weight).toBe(700))
    const preview = within(screen.getByTestId('theme-preview'))
    expect(preview.getByText('fn')).toHaveStyle({ color: '#aabbcc', fontStyle: 'italic', fontWeight: '700' })
  })

  it('restores failed document edits and does not add a failed undo step', async () => {
    const original = invoke.getMockImplementation()!
    invoke.mockImplementation((channel: string, input: Record<string, unknown>) =>
      channel === 'theme.saveDoc'
        ? Promise.resolve({ ok: false, error: { code: 'IO', message: 'read only' } })
        : original(channel, input),
    )
    initTheme('dark')
    page('Theme')
    fireEvent.change(screen.getByRole('textbox', { name: 'background' }), { target: { value: '#102030' } })
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/restored|previous/i))
    expect(themeStore.getState().doc.dark.edits.background).toBeUndefined()
    expect(screen.getByRole('button', { name: 'Undo' })).toBeDisabled()
  })

  it('keeps preview interaction local and copies the actual exported theme', async () => {
    const user = userEvent.setup()
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue()
    page('Theme')
    const preview = within(screen.getByTestId('theme-preview'))
    await user.type(preview.getByPlaceholderText('Type to preview'), 'Hello theme')
    expect(preview.getByPlaceholderText('Type to preview')).toHaveValue('Hello theme')
    await user.click(preview.getByRole('checkbox', { name: 'Checkbox' }))
    expect(preview.getByRole('checkbox', { name: 'Checkbox' })).not.toBeChecked()
    await user.click(preview.getByRole('tab', { name: 'Activity' }))
    expect(preview.getByRole('radio', { name: 'Week' })).toBeChecked()
    await user.click(preview.getByRole('button', { name: 'Open menu' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Rename' }))
    expect(preview.getByRole('status')).toHaveTextContent('Rename selected')
    expect(invoke.mock.calls.some(([channel]) => channel === 'theme.saveDoc')).toBe(false)
    await user.click(screen.getByRole('tab', { name: 'Export' }))
    await user.click(screen.getByRole('button', { name: 'Copy JSON' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(screen.getByLabelText('Theme JSON').textContent))
    expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument()
    expect(JSON.parse(writeText.mock.calls[0]![0])).toEqual(exportTheme(themeStore.getState().doc))
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
