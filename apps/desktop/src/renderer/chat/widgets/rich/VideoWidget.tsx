import { useState } from 'react'
import { Stack, Text } from '@mantine/core'
import type { VideoSpec } from '@evaos/chat-core/widget'
import { mediaUrl } from '../media-url'
import { WidgetTitle } from './parts'
import { mediaErrorText, useRenderFailure } from '../render-report'

/** Until the metadata says otherwise. */
const DEFAULT_ASPECT = 16 / 9

/** Inline video in a frame at the video's own aspect, with the native controls. */
export function VideoWidget({ spec }: { spec: VideoSpec }) {
  const [aspect, setAspect] = useState(DEFAULT_ASPECT)
  const [failed, setFailed] = useState(false)
  const report = useRenderFailure()
  return (
    <Stack gap="sm" data-testid="widget-video">
      {spec.title !== undefined ? <WidgetTitle>{spec.title}</WidgetTitle> : null}
      <div className="eva-w-frame eva-w-video" style={{ aspectRatio: aspect }}>
        {failed ? (
          <div className="eva-w-media">
            <Text size="xs" c="dimmed">
              Couldn&apos;t load video
            </Text>
          </div>
        ) : (
          <video
            src={mediaUrl(spec.src)}
            controls
            preload="metadata"
            playsInline
            aria-label={spec.title ?? 'Video'}
            onLoadedMetadata={(e) => {
              const { videoWidth: w, videoHeight: h } = e.currentTarget
              if (w > 0 && h > 0) setAspect(w / h)
            }}
            onError={(e) => {
              setFailed(true)
              report('video', spec.src, mediaErrorText('video', e.currentTarget))
            }}
          />
        )}
      </div>
    </Stack>
  )
}
