import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from 'zustand'
import { parseFrameMessage } from '@relay/widget-runtime/frame'
import { themeStore, useColorScheme } from '../../theme/theme-config'
import { openLink } from '../../navigation/open-link'
import { useWidgetActions } from './actions'
import { frameThemeFor, frameUrl, type FrameRuntime } from './frame-theme'

/** Taller pages scroll inside the frame. */
export const MAX_FRAME_HEIGHT = 1200

/** Measured heights by page, so a row the log remounts comes back at its size, not collapsed.
 * Least recently used go first. */
const heights = new Map<string, number>()
const MAX_HEIGHTS = 200

function rememberHeight(url: string, height: number): void {
  heights.delete(url)
  heights.set(url, height)
  if (heights.size > MAX_HEIGHTS) heights.delete(heights.keys().next().value!)
}

/** What a widget fence shows until its page can draw: while it streams, and while the page loads. */
export function WidgetFramePending() {
  return (
    <div className="eva-widget-page-pending" data-testid="widget-page-pending">
      Building widget
    </div>
  )
}

/**
 * An agent-made widget (```html-widget or ```mantine-widget, or a dashboard's Mantine tile): its
 * page from @relay/widget-runtime/frame, served by main on `relay-widget:` and run in a sandboxed
 * iframe (scripts only: opaque origin, no popups, no top navigation). It draws with the Settings >
 * Theme config in the current scheme and reloads when either changes. The page posts its height,
 * which sizes the frame up to MAX_FRAME_HEIGHT, and `relay.reply` text, which goes out as Isaac's
 * next turn exactly like a widget reply button. Messages count only from this frame's own window.
 * With `height` (a Mantine tile's) the frame is that tall and the page fills it instead.
 */
export function WidgetFrame({
  runtime,
  code,
  height: box,
}: {
  runtime: FrameRuntime
  code: string
  height?: number | undefined
}) {
  const config = useStore(themeStore, (s) => s.present)
  const scheme = useColorScheme()
  const fill = runtime === 'mantine' && box !== undefined
  const url = useMemo(() => {
    const theme = frameThemeFor(config, scheme)
    return runtime === 'mantine'
      ? frameUrl('mantine', code, theme, config, fill)
      : frameUrl('html', code, theme)
  }, [runtime, code, config, scheme, fill])
  const frame = useRef<HTMLIFrameElement>(null)
  const actions = useWidgetActions()
  const [measured, setMeasured] = useState<{ url: string; height: number } | null>(null)
  const height = measured?.url === url ? measured.height : heights.get(url)

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (!frame.current || event.source !== frame.current.contentWindow) return
      const message = parseFrameMessage(event.data)
      if (message?.type === 'height') {
        rememberHeight(url, message.height)
        setMeasured({ url, height: message.height })
      } else if (message?.type === 'open') {
        openLink(message.url)
      } else if (message?.type === 'reply' && actions.canReply) {
        actions.reply(message.text)
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [url, actions])

  return (
    <div className="eva-widget" data-testid="widget-page" data-runtime={runtime}>
      {height === undefined && !fill && <WidgetFramePending />}
      <iframe
        ref={frame}
        className="eva-widget-page"
        title={runtime === 'mantine' ? 'Mantine widget' : 'HTML widget'}
        src={url}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        style={{ height: fill ? box : Math.min(height ?? 0, MAX_FRAME_HEIGHT) }}
      />
    </div>
  )
}
