import { useEffect, useRef, useState } from 'react'
import { Badge, Stack, Text } from '@mantine/core'
import type { ModelSpec } from '@evaos/chat-core/widget'
import { mediaUrl } from '../media-url'
import { WidgetTitle } from './parts'
import { useRenderFailure } from '../render-report'
import { useMediaSlot } from '../media-slot'

const ASPECT = 4 / 3

type LoadState =
  { kind: 'waiting' } | { kind: 'loading' } | { kind: 'ready' } | { kind: 'error'; message: string }

/**
 * Interactive 3D model (GLB) in a 4:3 frame: drag orbits, pinch zooms, `autoRotate` spins it
 * until touched, and a "3D" corner tag shows once it has loaded. The frame waits empty until its
 * turn (media-slot.ts: near the viewport, newest message first, two loading at once) and drops
 * its WebGL context again once it is scrolled far away.
 */
export function ModelWidget({ spec }: { spec: ModelSpec }) {
  const host = useRef<HTMLDivElement>(null)
  const [state, setState] = useState<LoadState>({ kind: 'waiting' })
  const autoRotate = spec.autoRotate === true
  const slot = useMediaSlot('model', true)
  const { live, settled } = slot
  // The latest reporter, so a bubble's context changing never reloads the model.
  const reportFailure = useRenderFailure()
  const report = useRef(reportFailure)
  report.current = reportFailure

  useEffect(() => {
    const el = host.current
    if (!el) return
    if (!live) {
      setState({ kind: 'waiting' })
      return
    }
    setState({ kind: 'loading' })
    let mounted = true
    let dispose: (() => void) | null = null
    void import('./model-scene')
      .then(({ mountModel }) => {
        if (!mounted) return
        dispose = mountModel(el, mediaUrl(spec.src), {
          autoRotate,
          onLoad: () => {
            setState({ kind: 'ready' })
            settled()
          },
          onError: (message, detail) => {
            setState({ kind: 'error', message })
            settled()
            report.current('model', spec.src, detail ? `${message}: ${detail}` : message)
          },
        })
      })
      .catch((err: unknown) => {
        if (!mounted) return
        setState({ kind: 'error', message: "Couldn't load model" })
        settled()
        report.current('model', spec.src, `3D viewer failed to load: ${String(err)}`)
      })
    return () => {
      mounted = false
      dispose?.()
    }
  }, [spec.src, autoRotate, live, settled])

  return (
    <Stack gap="sm" data-testid="widget-model">
      {spec.title !== undefined ? <WidgetTitle>{spec.title}</WidgetTitle> : null}
      <div
        ref={slot.ref}
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
