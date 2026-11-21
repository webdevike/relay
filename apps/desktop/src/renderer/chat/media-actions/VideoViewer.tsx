import { useState, type ReactNode, type RefObject } from 'react'
import { ActionIcon, Tooltip } from '@mantine/core'
import { IconMaximize } from '@tabler/icons-react'
import { EvaModal } from '../../overlay'
import { mediaTarget } from './media-actions'
import { useMediaMenu } from './MediaMenu'
import { useViewerMediaKeys } from './useViewerMediaKeys'
import { ViewerDownload } from './ViewerDownload'
import './media-actions.css'

/**
 * A chat video full screen, in the app's viewer rather than Chromium's own full screen (which has
 * room for no controls of ours): its caption, Download (or Cmd+S) and the right-click media menu.
 * It plays on from where the inline video was.
 */
function VideoViewer({
  url,
  caption,
  poster,
  startAt,
  onClose,
}: {
  url: string
  caption: string | undefined
  poster: string | undefined
  startAt: number
  onClose(): void
}) {
  const target = mediaTarget('video', url, caption)
  useViewerMediaKeys(target, true)
  const media = useMediaMenu()
  return (
    <EvaModal
      opened
      onClose={onClose}
      fullScreen
      testid="video-viewer"
      title={caption || 'Video'}
      actions={<ViewerDownload target={target} testid="viewer-download" />}
    >
      <div className="eva-video-viewer">
        <video
          src={url}
          poster={poster}
          controls
          controlsList="nofullscreen"
          autoPlay
          playsInline
          aria-label={caption || 'Video'}
          data-testid="video-viewer-video"
          onLoadedMetadata={(e) => {
            if (startAt > 0) e.currentTarget.currentTime = startAt
          }}
          onContextMenu={media.onContextMenu(target)}
        />
      </div>
      {media.menu}
    </EvaModal>
  )
}

/**
 * The full-screen way into a chat video: a quiet button on its top right corner (and a double
 * click on it) opens the viewer, pausing the inline one. Inline videos set
 * `controlsList="nofullscreen"`, so this is their only full screen. `open` is for the double click.
 */
export function useVideoViewer(opts: {
  video: RefObject<HTMLVideoElement | null>
  url: string
  caption: string | undefined
  poster: string | undefined
}): { open(): void; button: ReactNode; viewer: ReactNode } {
  const [startAt, setStartAt] = useState<number | null>(null)
  const open = (): void => {
    const v = opts.video.current
    v?.pause()
    setStartAt(v?.currentTime ?? 0)
  }
  return {
    open,
    button: (
      <Tooltip label="Full screen" openDelay={400}>
        <ActionIcon
          className="eva-video-expand"
          variant="default"
          size="sm"
          aria-label="Full screen"
          data-testid="video-expand"
          onClick={open}
        >
          <IconMaximize size={14} stroke={1.5} />
        </ActionIcon>
      </Tooltip>
    ),
    viewer:
      startAt === null ? null : (
        <VideoViewer
          url={opts.url}
          caption={opts.caption}
          poster={opts.poster}
          startAt={startAt}
          onClose={() => setStartAt(null)}
        />
      ),
  }
}
