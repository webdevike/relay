import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { DEFAULT_THEME, MantineProvider } from '@mantine/core'
import type { ReactNode } from 'react'
import { THEME_PRESETS as RELAY_THEME_PRESETS } from '@relay/widget-runtime/theme'
import { Markdown } from '../markdown/Markdown'
import { WidgetActions } from './actions'
import { frameThemeFor, frameUrl } from './frame-theme'
import { MAX_FRAME_HEIGHT, WidgetFrame } from './WidgetFrame'
import { THEME_PRESETS, seedTheme, setColorScheme } from '../../theme/theme-config'

vi.mock('../../navigation/open-link', () => ({ openLink: vi.fn() }))
vi.mock('../../ipc', () => ({ invoke: vi.fn(() => Promise.resolve({ ok: true })), on: vi.fn() }))

const defaults = THEME_PRESETS[0]!.config
const attio = RELAY_THEME_PRESETS.find((p) => p.value === 'attio')!.config

const show = (ui: ReactNode, reply = vi.fn(), canReply = true) => {
  render(
    <MantineProvider>
      <WidgetActions.Provider value={{ reply, canReply }}>{ui}</WidgetActions.Provider>
    </MantineProvider>,
  )
  return reply
}

const iframe = () => screen.getByTestId('widget-page').querySelector('iframe')!

/** The frame's page posting `message` to the shell, as the bridge script does. */
function post(message: object, source: MessageEventSource | null = iframe().contentWindow) {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(message), source }))
  })
}

beforeEach(() => seedTheme(undefined))
afterEach(() => seedTheme(undefined))

describe('frameThemeFor', () => {
  it('maps the Default preset in light to the page palette', () => {
    expect(frameThemeFor(defaults, 'light')).toEqual({
      dark: false,
      colors: {
        fg: '#212529',
        muted: '#868e96',
        faint: '#adb5bd',
        border: '#dee2e6',
        surface: '#f8f9fa',
        raised: '#ffffff',
        accent: '#228be6',
        ok: DEFAULT_THEME.colors.green[6],
        warn: DEFAULT_THEME.colors.yellow[6],
        danger: DEFAULT_THEME.colors.red[6],
        bg: 'transparent',
      },
      font: {
        family: defaults.fontFamily,
        mono: defaults.fontFamilyMonospace,
        size: 14,
        lineHeight: 20,
      },
      radius: { sm: 4, md: 8, lg: 12 },
    })
  })

  it('takes dark colors at the dark primary shade', () => {
    const theme = frameThemeFor(defaults, 'dark')
    expect(theme.dark).toBe(true)
    expect(theme.colors).toMatchObject({
      fg: '#c1c2c5',
      muted: '#909296',
      raised: '#1a1b1e',
      accent: defaults.primaryPalette[8],
      ok: DEFAULT_THEME.colors.green[8],
      bg: 'transparent',
    })
  })

  it('follows a preset: fonts, radii and the scale', () => {
    const theme = frameThemeFor({ ...attio, scale: 1.5 }, 'light')
    expect(theme.font.family).toBe(attio.fontFamily)
    expect(theme.font.size).toBe(21)
    expect(theme.radius).toEqual({ sm: 9, md: 15, lg: 21 })
    expect(theme.colors.border).toBe('#e6e7ea')
  })
})

describe('frameUrl', () => {
  it('carries the code, the palette and, for Mantine, the config', () => {
    const theme = frameThemeFor(defaults, 'light')
    const url = new URL(frameUrl('mantine', '<Button>Hi</Button>', theme, defaults))
    expect(url.protocol).toBe('relay-widget:')
    expect(url.host).toBe('frame')
    expect(url.pathname).toBe('/mantine')
    expect(url.searchParams.get('source')).toBe('<Button>Hi</Button>')
    expect(JSON.parse(url.searchParams.get('theme')!)).toEqual(theme)
    expect(JSON.parse(url.searchParams.get('config')!)).toEqual(defaults)
    expect(new URL(frameUrl('html', '<p>x</p>', theme)).searchParams.has('config')).toBe(false)
  })
})

describe('Markdown widget fences', () => {
  const closed = (lang: string, body: string) => `Here:\n\n\`\`\`${lang}\n${body}\n\`\`\`\n`

  it('draws a closed ```mantine-widget in a sandboxed frame with the theme config', () => {
    show(<Markdown text={closed('mantine-widget', '<Button>Go</Button>')} />)
    const page = screen.getByTestId('widget-page')
    expect(page).toHaveAttribute('data-runtime', 'mantine')
    const frame = iframe()
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts')
    const url = new URL(frame.getAttribute('src')!)
    expect(url.pathname).toBe('/mantine')
    expect(url.searchParams.get('source')).toBe('<Button>Go</Button>')
    expect(JSON.parse(url.searchParams.get('config')!)).toEqual(defaults)
    expect(screen.queryByTestId('code-block')).toBeNull()
  })

  it('draws a closed ```html-widget with the palette only', () => {
    show(<Markdown text={closed('html-widget', '<p>Hello</p>')} />)
    expect(screen.getByTestId('widget-page')).toHaveAttribute('data-runtime', 'html')
    const url = new URL(iframe().getAttribute('src')!)
    expect(url.pathname).toBe('/html')
    expect(url.searchParams.get('source')).toBe('<p>Hello</p>')
    expect(url.searchParams.has('config')).toBe(false)
  })

  it('shows a placeholder, not a half-written page, while the fence streams', () => {
    for (const lang of ['html-widget', 'mantine-widget']) {
      const { unmount } = render(<Markdown text={`Here:\n\n\`\`\`${lang}\n<Card>\n  <Text>`} />)
      expect(screen.getByTestId('widget-page-pending')).toHaveTextContent('Building widget')
      expect(screen.queryByTestId('widget-page')).toBeNull()
      expect(document.querySelector('iframe')).toBeNull()
      unmount()
    }
  })
})

describe('WidgetFrame', () => {
  it('sizes to the height its page posts, capped, and drops the placeholder', () => {
    show(<WidgetFrame runtime="html" code="<p>sized</p>" />)
    expect(screen.getByTestId('widget-page-pending')).toBeInTheDocument()
    expect(iframe().style.height).toBe('0px')
    post({ type: 'height', height: 312 })
    expect(iframe().style.height).toBe('312px')
    expect(screen.queryByTestId('widget-page-pending')).toBeNull()
    post({ type: 'height', height: 5000 })
    expect(iframe().style.height).toBe(`${MAX_FRAME_HEIGHT}px`)
  })

  it('ignores messages from any window but its own frame', () => {
    const reply = show(<WidgetFrame runtime="mantine" code="<p>mine</p>" />)
    post({ type: 'height', height: 200 }, window)
    post({ type: 'reply', text: 'spoofed' }, window)
    post({ type: 'reply', text: 'no source' }, null)
    expect(iframe().style.height).toBe('0px')
    expect(reply).not.toHaveBeenCalled()
  })

  it("sends a page's reply as the next turn through the widget reply path", () => {
    const reply = show(<WidgetFrame runtime="mantine" code="<p>reply</p>" />)
    post({ type: 'reply', text: 'Runs by week' })
    expect(reply).toHaveBeenCalledExactlyOnceWith('Runs by week')
    post({ type: 'reply', text: '   ' })
    post({ type: 'unknown' })
    expect(reply).toHaveBeenCalledTimes(1)
  })

  it('sends nothing where the pane cannot reply', () => {
    const reply = show(<WidgetFrame runtime="html" code="<p>off</p>" />, vi.fn(), false)
    post({ type: 'reply', text: 'Runs by week' })
    expect(reply).not.toHaveBeenCalled()
  })

  it('follows the theme editor and the color scheme live', () => {
    show(<WidgetFrame runtime="mantine" code="<p>live</p>" />)
    const theme = () => JSON.parse(new URL(iframe().src).searchParams.get('theme')!)
    expect(theme().dark).toBe(false)
    act(() => setColorScheme('dark'))
    expect(theme().dark).toBe(true)
    act(() => seedTheme({ config: attio, preset: 'attio', themes: [], colorScheme: 'dark' }))
    expect(JSON.parse(new URL(iframe().src).searchParams.get('config')!)).toEqual(attio)
    expect(theme().colors.raised).toBe('#202126')
  })
})
