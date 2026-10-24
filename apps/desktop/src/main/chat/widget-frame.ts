// The pages agent-made widgets (```html-widget, ```mantine-widget) run in, served on the
// `relay-widget:` scheme. A srcdoc, blob: or data: iframe would inherit the shell's CSP
// (`script-src 'self'`) and could run neither its inline scripts nor the Mantine runtime's eval;
// a page from its own scheme has only the frame's own policy (@relay/widget-runtime/frame), sent
// here as a header as well as the page's meta tag. The renderer builds the URL
// (renderer/chat/widgets/frame-theme.ts frameUrl): the agent's code, the host palette and, for
// Mantine, the theme config, so a page is a pure function of its URL and nothing is stored.
import {
  HTML_FRAME_CSP,
  MANTINE_FRAME_CSP,
  htmlFrameDocument,
  mantineFrameDocument,
  type FrameTheme,
} from '@relay/widget-runtime/frame'
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

/**
 * Answers `relay-widget://frame/html?source=&theme=` and
 * `relay-widget://frame/mantine?source=&theme=&config=` with the widget's page.
 */
export function handleFrameRequest(request: Request): Response {
  const url = new URL(request.url)
  const runtime = url.pathname.replace(/^\//, '')
  if (url.host !== 'frame' || (runtime !== 'html' && runtime !== 'mantine'))
    return new Response('Unknown widget page', { status: 404 })
  const source = url.searchParams.get('source')
  const theme = parseObject(url.searchParams.get('theme')) as FrameTheme | null
  if (source === null || theme === null)
    return new Response('Missing source or theme', { status: 400 })
  const config = parseObject(url.searchParams.get('config')) as ThemeConfig | null
  const html =
    runtime === 'mantine'
      ? mantineFrameDocument(source, theme, config ?? undefined)
      : htmlFrameDocument(source, theme)
  return new Response(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': runtime === 'mantine' ? MANTINE_FRAME_CSP : HTML_FRAME_CSP,
      'Cache-Control': 'no-store',
    },
  })
}
