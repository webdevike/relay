import { Button, useComputedColorScheme } from '@mantine/core'
import { IconArrowLeft } from '@tabler/icons-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { invoke } from '../../ipc'
import { useInToolPane } from '../../pages/place-host'
import { AgentAvatar } from './AgentAvatar'
import { originPlace, useLiveRooms } from './live-store'
import { canvasThemeMessage } from './theme-message'
import { useThemeConfig } from '../../theme/theme-config'
import { backToChat, returnPointOf } from './return-point'
import { isCommentKey } from './slash'
import { POSITION_TIMEOUT_MS, readBoardCarry } from './handoff'
import { restoreMessage } from '@relay/canvas-live/carry'

const noop = (): void => {}

/** "Isaac here", "Isaac and Sam here", "Isaac, Sam and Ana here"; empty with nobody in. */
export function hereLabel(humans: readonly string[]): string {
  if (humans.length === 0) return ''
  if (humans.length === 1) return `${humans[0]} here`
  return `${humans.slice(0, -1).join(', ')} and ${humans[humans.length - 1]} here`
}

/**
 * A board while a live room holds it: the Relay host's room page in a frame (cursors, the agent's
 * caret, '/' notes), under a header with the way back to the chat the room was joined from. The
 * host writes the board file meanwhile, so the local editor is not mounted. When the room ends
 * this says so; `onBoard` goes back to the normal board.
 */
export function LiveCanvasView({
  slug,
  roomId,
  covered = false,
  onPositioned = noop,
  onBoard,
}: {
  slug: string
  roomId: string
  /** The frame loads behind the board that is still on screen (handoff.ts): invisible until `onPositioned`. */
  covered?: boolean
  /** The frame shows the carried view (or cannot, in time): swap it in. */
  onPositioned?: () => void
  onBoard: () => void
}) {
  const room = useLiveRooms((s) => s.data?.rooms.find((r) => r.id === roomId) ?? null)
  const relayUp = useLiveRooms((s) => s.data?.relayUp ?? false)
  const [url, setUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [endedHere, setEndedHere] = useState(false)
  const frame = useRef<HTMLIFrameElement>(null)
  const inPane = useInToolPane()
  const scheme = useComputedColorScheme('light')
  // The room's last known self: it stays named after it ends or Relay drops.
  const [known, setKnown] = useState(room)
  useEffect(() => {
    if (room) setKnown(room)
  }, [room])
  const shown = room ?? known

  const ended = endedHere || (relayUp && room?.live !== true)
  const open = !ended && url === null && error === null && relayUp

  // A fresh way in from the host each time the room is shown, in the app's light or dark.
  useEffect(() => {
    if (!open) return
    let live = true
    void invoke('canvas.live.open', { slug }).then((r) => {
      if (!live) return
      if (!r.ok) {
        setError(r.error.message)
        return
      }
      const page = new URL(r.value.url)
      page.searchParams.set('theme', scheme)
      setUrl(page.toString())
    })
    return () => {
      live = false
    }
  }, [open, slug, scheme])

  const settled = useRef(false)
  /** The room is as positioned as it will get: the page swaps it in (once). */
  const settle = useCallback((): void => {
    if (settled.current) return
    settled.current = true
    onPositioned()
  }, [onPositioned])

  // The page follows the app's appearance and theme preset live, not only as it was when opened.
  const { config } = useThemeConfig()
  const postTheme = useCallback((): void => {
    frame.current?.contentWindow?.postMessage(canvasThemeMessage(config, scheme), '*')
  }, [config, scheme])
  useEffect(postTheme, [postTheme, url])

  // The room page says when it ended (Wrap up) before the host's list does.
  useEffect(() => {
    const onMessage = (e: MessageEvent): void => {
      if (e.source !== frame.current?.contentWindow) return
      const type = (e.data as { type?: unknown } | null)?.type
      if (type === 'canvas.ended') setEndedHere(true)
      if (type === 'canvas.ready') {
        postTheme()
        // Behind the board: hand the room the page, view, selection and thread the board shows.
        if (covered && url !== null) {
          const carry = readBoardCarry(slug)
          if (carry === null) settle()
          else frame.current?.contentWindow?.postMessage(restoreMessage(carry), new URL(url).origin)
        }
      }
      if (type === 'canvas.positioned') settle()
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [postTheme, covered, url, slug, settle])

  // Swapping in must not wait on a frame that never answers, or a room that ended or could not open.
  useEffect(() => {
    if (!covered) return
    if (ended || error !== null || !relayUp) {
      settle()
      return
    }
    const timer = window.setTimeout(settle, POSITION_TIMEOUT_MS)
    return () => window.clearTimeout(timer)
  }, [covered, ended, error, relayUp, settle])

  // `/` writes a comment on the board. The room page hears it only while its frame has focus, so a
  // press anywhere else in the app (header, sidebar, nothing focused) is passed in: the frame takes
  // focus (a page without the message handler then hears the next `/` itself) and is told to open it.
  useEffect(() => {
    if (url === null || covered) return
    const origin = new URL(url).origin
    const onKey = (e: KeyboardEvent): void => {
      const win = frame.current
      if (!win || win.getClientRects().length === 0 || !isCommentKey(e)) return
      e.preventDefault()
      win.focus()
      win.contentWindow?.postMessage({ type: 'canvas.comment' }, origin)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [url, covered])

  const origin = shown ? originPlace(shown) : null
  const canGoBack = !inPane && (returnPointOf(slug) !== null || origin !== null)
  const goBack = (): void => backToChat(slug, origin)
  const title = shown?.board || slug

  return (
    <div
      className="eva-cv-page"
      data-testid="canvas-live"
      data-slug={slug}
      data-covered={covered ? 'true' : undefined}
      aria-hidden={covered ? true : undefined}
      inert={covered}
    >
      <header className="eva-cv-header">
        {canGoBack ? (
          <Button
            variant="default"
            size="compact-sm"
            leftSection={<IconArrowLeft size={14} stroke={1.5} />}
            data-testid="canvas-live-back"
            onClick={goBack}
          >
            Back to chat
          </Button>
        ) : null}
        <h1 className="eva-cv-title" data-testid="canvas-title">
          {title}
        </h1>
        <span className="eva-cv-status-line" />
        {shown ? (
          <div className="eva-cv-live-who" data-testid="canvas-live-agent">
            <AgentAvatar agent={shown.agent} size={24} />
            <span className="eva-cv-live-with">
              {ended ? `Ended with ${shown.agent.name}` : `Live with ${shown.agent.name}`}
            </span>
            {!ended && shown.humans.length > 0 ? (
              <span className="eva-cv-live-here">{hereLabel(shown.humans)}</span>
            ) : null}
            {!relayUp && !ended ? (
              <span className="eva-cv-live-here">Relay isn't connected</span>
            ) : null}
          </div>
        ) : null}
      </header>
      {ended ? (
        <div className="eva-cv-empty" data-testid="canvas-live-ended">
          <span>This canvas session ended. The board keeps everything you did.</span>
          <div className="eva-cv-live-actions">
            {canGoBack ? (
              <Button
                size="sm"
                leftSection={<IconArrowLeft size={14} stroke={1.5} />}
                onClick={goBack}
              >
                Back to chat
              </Button>
            ) : null}
            <Button size="sm" variant="default" data-testid="canvas-live-board" onClick={onBoard}>
              Open board
            </Button>
          </div>
        </div>
      ) : url !== null ? (
        <iframe
          ref={frame}
          className="eva-cv-live-frame"
          data-testid="canvas-live-frame"
          title={`Live canvas: ${title}`}
          src={url}
          sandbox="allow-scripts allow-same-origin"
          onLoad={postTheme}
        />
      ) : (
        <div className="eva-cv-empty" data-testid="canvas-live-status">
          {error ?? (relayUp ? 'Opening the room' : "Relay isn't connected.")}
        </div>
      )}
    </div>
  )
}
