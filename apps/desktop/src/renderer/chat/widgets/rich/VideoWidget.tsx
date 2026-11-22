import { useRef, useState } from 'react'
import { Stack, Text } from '@mantine/core'
import type { VideoSpec } from '@evaos/chat-core/widget'
import { mediaUrl } from '../media-url'
import { WidgetTitle } from './parts'
import { mediaErrorText, useRenderFailure } from '../render-report'
import { useMediaSlot } from '../media-slot'
import { mediaTarget } from '../../media-actions/media-actions'
import { useMediaMenu } from '../../media-actions/MediaMenu'
import { useVideoViewer } from '../../media-actions/VideoViewer'

/** Until the metadata says otherwise. */
const DEFAULT_ASPECT = 16 / 9

/**
 * Inline video in a frame at the video's own aspect, with the native controls; full screen is the
 * app's video viewer (Download, Cmd+S). It only fetches its metadata at its turn (media-slot.ts:
 * near the viewport, newest message first).
 */
export function VideoWidget({ spec }: { spec: VideoSpec }) {
  const [aspect, setAspect] = useState(DEFAULT_ASPECT)
  const [failed, setFailed] = useState(false)
  const report = useRenderFailure()
  const { ref, live, settled } = useMediaSlot()
  const media = useMediaMenu()
  const video = useRef<HTMLVideoElement>(null)
  const url = mediaUrl(spec.src)
  const viewer = useVideoViewer({ video, url, caption: spec.title, poster: undefined })
  return (
    <Stack gap="sm" data-testid="widget-video">
      {spec.title !== undefined ? <WidgetTitle>{spec.title}</WidgetTitle> : null}
      <div ref={ref} className="eva-w-frame eva-w-video" style={{ aspectRatio: aspect }}>
        {failed ? (
          <div className="eva-w-media">
            <Text size="xs" c="dimmed">
              Couldn&apos;t load video
            </Text>
          </div>
        ) : (
          <>
            <video
              ref={video}
              src={live ? url : undefined}
              controls
              controlsList="nofullscreen"
              preload="metadata"
              playsInline
              aria-label={spec.title ?? 'Video'}
              onLoadedMetadata={(e) => {
                settled()
                const { videoWidth: w, videoHeight: h } = e.currentTarget
                if (w > 0 && h > 0) setAspect(w / h)
              }}
              onError={(e) => {
                setFailed(true)
                settled()
                report('video', spec.src, mediaErrorText('video', e.currentTarget))
              }}
              onDoubleClick={viewer.open}
              onContextMenu={media.onContextMenu(mediaTarget('video', url, spec.title))}
            />
            {viewer.button}
          </>
        )}
      </div>
      {media.menu}
      {viewer.viewer}
    </Stack>
  )
}
