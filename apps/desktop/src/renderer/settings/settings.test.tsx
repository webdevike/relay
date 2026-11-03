import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MantineProvider } from '@mantine/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { placeOf } from '@evaos/shell-core'
import { DEFAULT_LINK_PREFS } from '@evaos/contract'

const invoke = vi.fn()
const MISSING = 'Claude Code was not found. Install it, then try again.'
let harnessStatus = { omp: true, claude: true }
vi.mock('../ipc', () => ({ invoke: (...a: unknown[]) => invoke(...a), on: () => () => undefined }))
vi.mock('@mantine/notifications', () => ({ notifications: { show: vi.fn() } }))

import { SettingsPage } from './SettingsPage'
import { resetSettingsForTest } from './settings-store'
import {
  THEME_PRESETS,
  applyPreset,
  persistTheme,
  seedTheme,
  themeStore,
  updateConfig,
} from '../theme/theme-config'
import { pageRegistry } from '../pages/registry'
import { assistantsStore } from '../assistants/assistants-store'

function page(section: 'Theme' | 'Chat' | 'Links' | 'About') {
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
      return { ok: true, value: { show_thinking: false, show_tools: false, harness: 'omp' } }
    if (c === 'chat.harnessStatus') return { ok: true, value: harnessStatus }
    if (c === 'links.get')
      return { ok: true, value: { prefs: DEFAULT_LINK_PREFS, apps: ['Arc', 'Linear', 'Slack'] } }
    if (c === 'links.set') return { ok: true, value: input.prefs }
    return {
      ok: true,
      value: { show_thinking: false, show_tools: false, harness: 'omp', ...input },
    }
  })
  resetSettingsForTest()
  seedTheme(undefined)
  persistTheme()
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn(),
  })
})

describe('SettingsPage', () => {
  it('renders the Texo tool column beside a live component preview', () => {
    page('Theme')
    expect(screen.getByTestId('theme-editor')).toBeInTheDocument()
    expect(screen.getByTestId('theme-preset-picker')).toHaveTextContent('Default')
    for (const name of ['Colors', 'Typography', 'Other', 'Generate'])
      expect(screen.getByRole('tab', { name })).toBeInTheDocument()
    const preview = within(screen.getByTestId('theme-preview'))
    expect(preview.getByRole('heading', { name: 'Buttons' })).toBeInTheDocument()
    expect(preview.getByRole('button', { name: 'Open menu' })).toBeInTheDocument()
  })

  it('applies a preset from the picker and saves it by name', async () => {
    const user = userEvent.setup()
    page('Theme')
    await user.click(screen.getByTestId('theme-preset-picker'))
    await user.click(await screen.findByRole('option', { name: 'Forest' }))
    const forest = THEME_PRESETS.find((p) => p.value === 'forest')!
    expect(themeStore.getState()).toMatchObject({ preset: 'forest', present: forest.config })
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('theme.save', {
        config: forest.config,
        preset: 'forest',
        themes: [],
        colorScheme: 'light',
        focusRingMigrated: true,
      }),
    )
    expect(screen.getByTestId('theme-preset-picker')).toHaveTextContent('Forest')
  })

  it('an edit stays on its theme as unsaved, and undo and redo walk the history', async () => {
    const user = userEvent.setup()
    page('Theme')
    expect(screen.getByTestId('theme-save')).toBeDisabled()
    await user.click(screen.getByRole('tab', { name: 'Other' }))
    await user.click(screen.getByRole('button', { name: 'SPACING' }))
    // Radius and spacing both have an md row; spacing md starts at 1rem.
    const md = within(screen.getByTestId('theme-properties'))
      .getAllByLabelText('md')
      .find((input) => (input as HTMLInputElement).value === '1rem')!
    fireEvent.change(md, { target: { value: '2rem' } })
    expect(themeStore.getState().present.spacing.md).toBe('2rem')
    expect(screen.getByTestId('theme-preset-picker')).toHaveTextContent('Default')
    expect(screen.getByTestId('theme-save-state')).toHaveTextContent('Unsaved changes')
    expect(screen.getByTestId('theme-save')).toBeEnabled()
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        'theme.save',
        expect.objectContaining({ preset: 'default', themes: [] }),
      ),
    )
    await user.click(screen.getByRole('button', { name: 'Undo theme' }))
    expect(themeStore.getState().present.spacing.md).toBe('1rem')
    expect(screen.getByTestId('theme-save-state')).toHaveTextContent('Saved')
    await user.click(screen.getByRole('button', { name: 'Redo theme' }))
    expect(themeStore.getState().present.spacing.md).toBe('2rem')
    expect(screen.getByRole('button', { name: 'Redo theme' })).toBeDisabled()
  })

  it('Save keeps the edits as his version of the theme; reset brings the original back', async () => {
    const user = userEvent.setup()
    applyPreset('forest')
    page('Theme')
    updateConfig((c) => ({ ...c, focusRing: 'always' }))
    await user.click(await screen.findByTestId('theme-save'))
    expect(screen.getByTestId('theme-save-state')).toHaveTextContent('Your version')
    expect(themeStore.getState().themes).toEqual([
      expect.objectContaining({ value: 'forest', label: 'Forest' }),
    ])
    // Switching away and back returns his saved version, not the shipped one.
    applyPreset('default')
    applyPreset('forest')
    expect(themeStore.getState().present.focusRing).toBe('always')
    await user.click(screen.getByTestId('theme-actions'))
    await user.click(await screen.findByTestId('theme-reset'))
    expect(themeStore.getState().themes).toEqual([])
    expect(themeStore.getState().present.focusRing).toBe('never')
  })

  it('Save as new makes his own theme, picks it, and it can be deleted', async () => {
    const user = userEvent.setup()
    page('Theme')
    updateConfig((c) => ({ ...c, primaryColor: 'teal' }))
    await user.click(screen.getByTestId('theme-save-as'))
    const name = await screen.findByTestId('theme-save-as-name')
    await user.clear(name)
    await user.type(name, 'Calm teal')
    await user.click(screen.getByTestId('theme-save-as-ok'))
    expect(themeStore.getState()).toMatchObject({ preset: 'user-calm-teal' })
    expect(screen.getByTestId('theme-preset-picker')).toHaveTextContent('Calm teal')
    expect(screen.getByTestId('theme-save-state')).toHaveTextContent('Saved')
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        'theme.save',
        expect.objectContaining({
          preset: 'user-calm-teal',
          themes: [expect.objectContaining({ value: 'user-calm-teal', label: 'Calm teal' })],
        }),
      ),
    )
    await user.click(screen.getByTestId('theme-actions'))
    await user.click(await screen.findByTestId('theme-delete'))
    expect(themeStore.getState()).toMatchObject({ preset: 'default', themes: [] })
  })

  it('the scheme toggle and presets stay independent: no reset to light', async () => {
    const user = userEvent.setup()
    page('Theme')
    await user.click(screen.getByTestId('theme-color-scheme'))
    expect(themeStore.getState()).toMatchObject({ colorScheme: 'dark', preset: 'default' })
    expect(screen.getByTestId('theme-color-scheme')).toHaveAttribute('data-scheme', 'dark')
    await user.click(screen.getByTestId('theme-preset-picker'))
    await user.click(await screen.findByRole('option', { name: 'Forest' }))
    expect(themeStore.getState()).toMatchObject({ colorScheme: 'dark', preset: 'forest' })
    await user.click(screen.getByTestId('theme-color-scheme'))
    expect(themeStore.getState()).toMatchObject({ colorScheme: 'light', preset: 'forest' })
    await waitFor(() =>
      expect(invoke).toHaveBeenLastCalledWith(
        'theme.save',
        expect.objectContaining({ preset: 'forest', colorScheme: 'light' }),
      ),
    )
  })

  it('Generate shows the createTheme code for the live config', async () => {
    const user = userEvent.setup()
    applyPreset('violet')
    page('Theme')
    await user.click(screen.getByRole('tab', { name: 'Generate' }))
    const code = screen.getByTestId('theme-properties').textContent ?? ''
    expect(code).toContain('export const theme = createTheme(')
    expect(code).toContain('"primaryColor": "violet"')
    expect(code).toContain('"--mantine-color-body"')
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
    expect(b).not.toBeChecked()
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

  it('About credits every Micah assistant with its license, links opening in the browser panel', () => {
    const agent = (id: string, style: 'micah' | 'notionists') => ({
      id,
      title: id[0]!.toUpperCase() + id.slice(1),
      scope: '',
      avatar: { style, seed: id },
      status: 'idle' as const,
      tool: null,
      file: null,
      reply: null,
    })
    assistantsStore.setState({
      data: {
        agents: [agent('astra', 'notionists'), agent('nova', 'micah'), agent('polaris', 'micah')],
        relayUp: true,
      },
    })
    page('About')
    const credits = screen.getByTestId('settings-credits')
    expect(credits).toHaveTextContent(
      'Nova and Polaris avatars: Micah by Micah Lanier, CC BY 4.0, modified',
    )
    fireEvent.click(within(credits).getByText('dicebear.com/styles/micah'))
    expect(invoke).toHaveBeenCalledWith('browser.createTab', {
      url: 'https://www.dicebear.com/styles/micah/',
    })
    expect(within(credits).getByText('creativecommons.org/licenses/by/4.0')).toHaveAttribute(
      'href',
      'https://creativecommons.org/licenses/by/4.0/',
    )
  })

  it('Links lists the default rules and saves an added site, a changed opener and a removal', async () => {
    const user = userEvent.setup()
    page('Links')
    const rules = await screen.findByTestId('links-rules')
    for (const p of ['linear.app', 'slack.com', '*.slack.com', 'github.com'])
      expect(within(rules).getByTestId(`links-rule-${p}`)).toBeInTheDocument()
    await waitFor(() => expect(screen.getByTestId('links-opener-github.com')).toHaveValue('Arc'))
    expect(screen.getByTestId('links-opener-github.com/*/*/pull')).toHaveValue('Relay Reviews')
    expect(screen.getByTestId('links-opener-fallback')).toHaveValue('Relay browser')

    await user.type(screen.getByTestId('links-add-input'), 'https://Docs.Example.com/a?b=1')
    await user.click(screen.getByTestId('links-add'))
    const added = {
      rules: [
        ...DEFAULT_LINK_PREFS.rules,
        { pattern: 'docs.example.com/a', opener: { kind: 'browser' } },
      ],
      fallback: { kind: 'browser' },
      seeded: ['reviews'],
    }
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('links.set', { prefs: added }))

    await user.click(screen.getByTestId('links-opener-docs.example.com/a'))
    await user.click(await screen.findByRole('option', { name: 'Default browser' }))
    await waitFor(() =>
      expect(invoke).toHaveBeenLastCalledWith('links.set', {
        prefs: {
          ...added,
          rules: [
            ...DEFAULT_LINK_PREFS.rules,
            { pattern: 'docs.example.com/a', opener: { kind: 'system' } },
          ],
        },
      }),
    )

    await user.click(screen.getByTestId('links-remove-github.com'))
    await waitFor(() =>
      expect(screen.queryByTestId('links-rule-github.com')).not.toBeInTheDocument(),
    )

    await user.type(screen.getByTestId('links-add-input'), 'localhost')
    await user.click(screen.getByTestId('links-add'))
    expect(screen.getByText('Type a site like example.com or *.example.com')).toBeInTheDocument()
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
