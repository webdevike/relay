import { Button, Text, Tooltip } from '@mantine/core'
import { IconRefresh } from '@tabler/icons-react'
import { useShallow } from 'zustand/react/shallow'
import { useChatStore } from '../chat/chat-store'
import { restartTooltip, updateCardLine } from './update-card'
import { restartForUpdate, useUpdate } from './update-store'

/** Pinned above Settings for as long as an update waits; only a restart removes it. */
export function UpdateCard() {
  const update = useUpdate((s) => s.update)
  const running = useChatStore(
    useShallow((s) =>
      Object.values(s.panes)
        .filter((p) => p.running)
        .map((p) => p.title),
    ),
  )
  if (!update.pending) return null
  const line = updateCardLine(update)
  return (
    <div className="eva-update-card" data-testid="update-card">
      <IconRefresh size={16} aria-hidden className="eva-update-card-icon" />
      <div className="eva-update-card-text">
        <Text size="sm" fw={500} lh={1.3}>
          Update ready
        </Text>
        <Tooltip label={line} position="top-start" openDelay={300} withinPortal>
          <Text size="xs" c="dimmed" truncate data-testid="update-card-summary">
            {line}
          </Text>
        </Tooltip>
      </div>
      <Tooltip
        label={restartTooltip(running)}
        position="top-end"
        multiline
        w={240}
        withinPortal
        data-testid="update-card-restart-tip"
      >
        <Button
          size="compact-xs"
          data-testid="update-card-restart"
          data-running={running.length > 0 ? running.length : undefined}
          onMouseDown={(e) => e.preventDefault()}
          onClick={restartForUpdate}
        >
          Restart
        </Button>
      </Tooltip>
    </div>
  )
}
