import { useEffect, useRef, useState } from 'react'
import { Badge, Stack, Text } from '@mantine/core'
import type { ModelSpec } from '@evaos/chat-core/widget'
import { mediaUrl } from '../media-url'
import { WidgetTitle } from './parts'

const ASPECT = 4 / 3

type LoadState = { kind: 'loading' } | { kind: 'ready' } | { kind: 'error'; message: string }

/**
 * Interactive 3D model (GLB) in a 4:3 frame: drag orbits, pinch zooms, `autoRotate` spins it
 * until touched, and a "3D" corner tag shows once it has loaded.
 */
export function ModelWidget({ spec }: { spec: ModelSpec }) {
  const host = useRef<HTMLDivElement>(null)
  const [state, setState] = useState<LoadState>({ kind: 'loading' })
  const autoRotate = spec.autoRotate === true

  useEffect(() => {
    const el = host.current
    if (!el) return
    setState({ kind: 'loading' })
    let live = true
    let dispose: (() => void) | null = null
    void import('./model-scene')
      .then(({ mountModel }) => {
        if (!live) return
        dispose = mountModel(el, mediaUrl(spec.src), {
          autoRotate,
          onLoad: () => setState({ kind: 'ready' }),
          onError: (message) => setState({ kind: 'error', message }),
        })
      })
      .catch(() => {
        if (live) setState({ kind: 'error', message: "Couldn't load model" })
      })
    return () => {
      live = false
      dispose?.()
    }
  }, [spec.src, autoRotate])

  return (
    <Stack gap="sm" data-testid="widget-model">
      {spec.title !== undefined ? <WidgetTitle>{spec.title}</WidgetTitle> : null}
      <div
        className="eva-w-frame eva-w-model"
        style={{ aspectRatio: ASPECT }}
        data-state={state.kind}
        aria-label={spec.title ?? '3D model'}
        role="img"
      >
        <div ref={host} className="eva-w-media" />
        {state.kind === 'error' ? (
          <div className="eva-w-media">
            <Text size="xs" c="dimmed">
              {state.message}
            </Text>
          </div>
        ) : null}
        {state.kind === 'ready' ? (
          <Badge
            className="eva-w-tag"
            style={{ right: 'var(--mantine-spacing-xs)' }}
            size="sm"
            variant="default"
            tt="none"
          >
            3D
          </Badge>
        ) : null}
      </div>
      {spec.caption !== undefined ? (
        <Text size="xs" c="dimmed">
          {spec.caption}
        </Text>
      ) : null}
    </Stack>
  )
}
