import './strips.css'
import { Button, Group, Loader, Paper, Text } from '@mantine/core'
import { IconTarget } from '@tabler/icons-react'
import { invoke } from '../../ipc'
import { useChatStore } from '../chat-store'

/**
 * A tab tucked over the composer while a goal is set or a handoff generates (native
 * chat_view.rs status_strip). omp sends no handoff progress, so that shows from `/handoff` until
 * its output arrives. The goal buttons send omp's RPC `goal` command.
 */
export function StatusStrip({ paneId }: { paneId: string }) {
  const goal = useChatStore((s) => s.panes[paneId]?.goal ?? null)
  const handingOff = useChatStore((s) => s.panes[paneId]?.handingOff ?? false)
  const stopped = useChatStore((s) => s.panes[paneId]?.stopped ?? true)
  if (stopped) return null
  const act = (op: 'pause' | 'resume' | 'drop') => () => void invoke('chat.goal', { paneId, op })
  let row
  if (handingOff) {
    row = (
      <>
        <Loader size={12} aria-label="Generating handoff" />
        <Text size="xs" fw={500} className="eva-status-strip-title">
          Generating handoff
        </Text>
        <Text size="xs" c="dimmed" truncate className="eva-status-strip-detail">
          Summarizing this session, then compacting in place
        </Text>
      </>
    )
  } else if (goal) {
    row = (
      <>
        <IconTarget size={14} aria-hidden="true" className="eva-status-strip-icon" />
        <Text size="xs" fw={500} className="eva-status-strip-title">
          {goal.paused ? 'Goal paused' : 'Goal'}
        </Text>
        <Text size="xs" c="dimmed" truncate className="eva-status-strip-detail">
          {goal.tokensUsed > 0
            ? `${goal.objective} · ${Math.floor(goal.tokensUsed / 1000)}k tokens`
            : goal.objective}
        </Text>
        <Group gap={4} wrap="nowrap" className="eva-status-strip-actions">
          {goal.paused ? (
            <Button variant="subtle" size="compact-xs" onClick={act('resume')}>
              Resume
            </Button>
          ) : (
            <Button variant="subtle" size="compact-xs" onClick={act('pause')}>
              Pause
            </Button>
          )}
          <Button variant="subtle" size="compact-xs" onClick={act('drop')}>
            Drop
          </Button>
        </Group>
      </>
    )
  } else return null
  return (
    <Paper className="eva-status-strip" data-testid="status-strip">
      <Group gap="sm" wrap="nowrap" px="md" py={6}>
        {row}
      </Group>
    </Paper>
  )
}
