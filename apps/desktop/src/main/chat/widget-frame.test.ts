import { describe, expect, it } from 'vitest'
import { HTML_FRAME_CSP, MANTINE_FRAME_CSP, type FrameTheme } from '@relay/widget-runtime/frame'
import { THEME_PRESETS } from '@relay/widget-runtime/theme'
import { handleFrameRequest } from './widget-frame'

const THEME: FrameTheme = {
  dark: true,
  colors: {
    fg: '#c1c2c5',
    muted: '#909296',
    faint: '#5c5f66',
    border: '#373a40',
    surface: '#25262b',
    raised: '#1a1b1e',
    accent: '#1971c2',
    ok: '#2f9e44',
    warn: '#f08c00',
    danger: '#e03131',
    bg: 'transparent',
  },
  font: { family: 'system-ui', mono: 'monospace', size: 14, lineHeight: 20 },
  radius: { sm: 4, md: 8, lg: 12 },
}

const page = (runtime: string, params: Record<string, string>) =>
  handleFrameRequest(
    new Request(`relay-widget://frame/${runtime}?${new URLSearchParams(params).toString()}`),
  )

describe('handleFrameRequest', () => {
  it('serves an html-widget page under the html frame policy', async () => {
    const res = page('html', { source: '<p id="w">Hello</p>', theme: JSON.stringify(THEME) })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(res.headers.get('content-security-policy')).toBe(HTML_FRAME_CSP)
    const html = await res.text()
    expect(html).toContain('<p id="w">Hello</p>')
    expect(html).toContain('--accent: #1971c2')
    expect(html).not.toContain('RelayWidget.mount')
  })

  it('serves a mantine-widget page with the runtime, the source and the theme config', async () => {
    const config = THEME_PRESETS.find((p) => p.value === 'violet')!.config
    const res = page('mantine', {
      source: '<Button>Go</Button>',
      theme: JSON.stringify(THEME),
      config: JSON.stringify(config),
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-security-policy')).toBe(MANTINE_FRAME_CSP)
    const html = await res.text()
    expect(html).toContain('data-mantine-color-scheme="dark"')
    expect(html).toContain('RelayWidget.mount(')
    expect(html).toContain('"source":"\\u003cButton>Go\\u003c/Button>"')
    expect(html).toContain('"primaryColor":"violet"')
  })

  it('draws a Mantine page with the Default preset when no config comes', async () => {
    const html = await page('mantine', {
      source: '<Text>x</Text>',
      theme: JSON.stringify(THEME),
    }).text()
    expect(html).toContain('"primaryColor":"blue"')
  })

  it('refuses unknown pages and missing or broken parameters', () => {
    expect(page('svg', { source: 'x', theme: JSON.stringify(THEME) }).status).toBe(404)
    expect(
      handleFrameRequest(new Request('relay-widget://other/html?source=x&theme=%7B%7D')).status,
    ).toBe(404)
    expect(page('html', { theme: JSON.stringify(THEME) }).status).toBe(400)
    expect(page('html', { source: 'x' }).status).toBe(400)
    expect(page('html', { source: 'x', theme: '{nope' }).status).toBe(400)
    expect(page('html', { source: 'x', theme: '[1]' }).status).toBe(400)
  })
})
