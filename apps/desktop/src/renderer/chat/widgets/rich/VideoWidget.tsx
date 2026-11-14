import { useState } from 'react'
import { Stack, Text } from '@mantine/core'
import type { VideoSpec } from '@evaos/chat-core/widget'
import { mediaUrl } from '../media-url'
import { WidgetTitle } from './parts'
import { mediaErrorText, useRenderFailure } from '../render-report'
import { useMediaSlot } from '../media-slot'

/** Until the metadata says otherwise. */
const DEFAULT_ASPECT = 16 / 9

/**
 * Inline video in a frame at the video's own aspect, with the native controls. It only fetches
 * its metadata at its turn (media-slot.ts: near the viewport, newest message first).
 */
export function VideoWidget({ spec }: { spec: VideoSpec }) {
  const [aspect, setAspect] = useState(DEFAULT_ASPECT)
  const [failed, setFailed] = useState(false)
  const report = useRenderFailure()
  const { ref, live, settled } = useMediaSlot('media')
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
          <video
            src={live ? mediaUrl(spec.src) : undefined}
            controls
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
          />
        )}
      </div>
    </Stack>
  )
}
