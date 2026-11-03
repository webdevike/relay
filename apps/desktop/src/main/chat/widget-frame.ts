// The pages agent-made widgets (```html-widget, ```mantine-widget) and canvas prototypes (`proto`
// cards) run in, served on the `relay-widget:` scheme. A srcdoc, blob: or data: iframe would inherit
// the shell's CSP (`script-src 'self'`) and could run neither its inline scripts nor the Mantine
// runtime's eval; a page from its own scheme has only the frame's own policy
// (@relay/widget-runtime/frame and /proto), sent here as a header as well as the page's meta tag.
// The renderer builds the URL (renderer/chat/widgets/frame-theme.ts frameUrl, protoFrameUrl): the
// agent's code and the host palette and, for Mantine, the theme config, or for a prototype its
// design system and scheme, so a page is a pure function of its URL and nothing is stored.
import {
  HTML_FRAME_CSP,
  MANTINE_FRAME_CSP,
  htmlFrameDocument,
  mantineFrameDocument,
  type FrameTheme,
} from '@relay/widget-runtime/frame'
import { PROTO_FRAME_CSP, protoFrameDocument } from '@relay/widget-runtime/proto'
import { isDesignSystem } from '@relay/widget-runtime/systems'
import type { ThemeConfig } from '@relay/widget-runtime/theme'

export const FRAME_SCHEME = 'relay-widget'

function parseObject(text: string | null): object | null {
  if (text === null) return null
  try {
    const value: unknown = JSON.parse(text)
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : null
  } catch {
    return null
  }
}

function page(html: string, csp: string): Response {
  return new Response(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': csp,
      'Cache-Control': 'no-store',
    },
  })
}

/**
 * Answers `relay-widget://frame/html?source=&theme=`,
 * `relay-widget://frame/mantine?source=&theme=&config=` and
 * `relay-widget://frame/proto?source=&system=&scheme=` with the widget's page.
 */
export function handleFrameRequest(request: Request): Response {
  const url = new URL(request.url)
  const runtime = url.pathname.replace(/^\//, '')
  const source = url.searchParams.get('source')
  if (url.host === 'frame' && runtime === 'proto') {
    const system = url.searchParams.get('system')
    if (source === null || !isDesignSystem(system))
      return new Response('Missing source or design system', { status: 400 })
    const dark = url.searchParams.get('scheme') === 'dark'
    return page(protoFrameDocument(source, { system, dark }), PROTO_FRAME_CSP)
  }
  if (url.host !== 'frame' || (runtime !== 'html' && runtime !== 'mantine'))
    return new Response('Unknown widget page', { status: 404 })
  const theme = parseObject(url.searchParams.get('theme')) as FrameTheme | null
  if (source === null || theme === null)
    return new Response('Missing source or theme', { status: 400 })
  const config = parseObject(url.searchParams.get('config')) as ThemeConfig | null
  return runtime === 'mantine'
    ? page(mantineFrameDocument(source, theme, config ?? undefined), MANTINE_FRAME_CSP)
    : page(htmlFrameDocument(source, theme), HTML_FRAME_CSP)
}
