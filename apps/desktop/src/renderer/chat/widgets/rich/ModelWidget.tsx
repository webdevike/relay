import { Badge, Loader, Stack, Text, UnstyledButton } from '@mantine/core'
import { IconCube } from '@tabler/icons-react'
import type { ModelSpec } from '@evaos/chat-core/widget'
import { formatBytes, modelTooLargeText } from '@evaos/chat-core/model-limit'
import { WidgetTitle } from './parts'
import { useModelViewer } from './model-viewer'

const ASPECT = 4 / 3

/**
 * Interactive 3D model (GLB) in a 4:3 frame. It starts as a poster (the file's name and size,
 * "Click to view in 3D") that downloads nothing; a click downloads the model and opens it (drag
 * orbits, pinch zooms, `autoRotate` spins it until touched, a "3D" tag once loaded). One model is
 * open in the whole app: opening another, scrolling it far away or leaving the chat closes it and
 * gives its WebGL context back (model-viewer.ts). A file over the size limit never opens.
 */
export function ModelWidget({ spec }: { spec: ModelSpec }) {
  return (
    <Stack gap="sm" data-testid="widget-model">
      {spec.title !== undefined ? <WidgetTitle>{spec.title}</WidgetTitle> : null}
      <ModelFrame
        key={`${spec.src}\n${String(spec.autoRotate === true)}`}
        src={spec.src}
        title={spec.title}
        autoRotate={spec.autoRotate === true}
      />
      {spec.caption !== undefined ? (
        <Text size="xs" c="dimmed">
          {spec.caption}
        </Text>
      ) : null}
    </Stack>
  )
}

function ModelFrame({
  src,
  title,
  autoRotate,
}: {
  src: string
  title: string | undefined
  autoRotate: boolean
}) {
  const model = useModelViewer(src, autoRotate)
  const { view } = model
  const name = model.name ?? title ?? '3D model'
  const live = view === 'loading' || view === 'ready'
  return (
    <div
      ref={model.frame}
      className="eva-w-frame eva-w-model"
      style={{ aspectRatio: ASPECT }}
      data-state={view}
      data-live={live || undefined}
      aria-label={title ?? '3D model'}
      role="group"
    >
      <div ref={model.host} className="eva-w-media" />
      {view === 'probing' || view === 'poster' || view === 'failed' ? (
        <UnstyledButton className="eva-w-media eva-w-model-poster" onClick={model.open}>
          <Stack gap="xs" align="center">
            <IconCube size={32} stroke={1.5} aria-hidden />
            <Text size="sm" fw={500} ta="center" lineClamp={2}>
              {name}
            </Text>
            {model.size !== null ? (
              <Text size="xs" c="dimmed">
                {formatBytes(model.size)}
              </Text>
            ) : null}
            <Text size="xs" c={view === 'failed' ? 'red' : 'dimmed'} ta="center">
              {view === 'failed'
                ? `${model.error ?? "Couldn't load model"}. Click to try again.`
                : 'Click to view in 3D'}
            </Text>
          </Stack>
        </UnstyledButton>
      ) : null}
      {view === 'loading' ? (
        <div className="eva-w-media">
          <Loader size="sm" aria-label="Loading model" />
        </div>
      ) : null}
      {view === 'tooLarge' ? (
        <div className="eva-w-media">
          <Stack gap="xs" align="center" maw="80%">
            <IconCube size={32} stroke={1.5} aria-hidden />
            <Text size="sm" fw={500} ta="center" lineClamp={2}>
              {name}
            </Text>
            <Text size="xs" c="dimmed" ta="center">
              {modelTooLargeText(model.size ?? 0)}
            </Text>
          </Stack>
        </div>
      ) : null}
      {view === 'ready' ? (
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
  )
}
