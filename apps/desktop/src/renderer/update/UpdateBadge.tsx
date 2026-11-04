import { Badge, Button, HoverCard, Stack, Text } from '@mantine/core'
import { IconRefresh } from '@tabler/icons-react'
import { useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { shortBuild, type ChangelogEntry } from '@evaos/contract'
import { useAbout } from '../about/build-info'
import { useChatStore } from '../chat/chat-store'
import { invoke } from '../ipc'
import { changesSince, restartNote, updateSummaryLine } from './update-badge'
import { restartForUpdate, useUpdate } from './update-store'

/** Changes listed before "and N more". */
const SHOWN = 8

/**
 * A small pill above Settings for as long as an update waits; only a restart removes it. Hover
 * (or focus then hover) opens what the update brings and the Restart button.
 */
export function UpdateBadge() {
  const update = useUpdate((s) => s.update)
  const about = useAbout()
  const [history, setHistory] = useState<ChangelogEntry[] | null>(null)
  const running = useChatStore(
    useShallow((s) =>
      Object.values(s.panes)
        .filter((p) => p.running)
        .map((p) => p.title),
    ),
  )
  if (!update.pending) return null
  const changes = history === null ? [] : changesSince(history, about?.build ?? null, update.build)
  const note = restartNote(running)
  return (
    <HoverCard
      width={300}
      position="top-start"
      shadow="md"
      withArrow={false}
      openDelay={150}
      closeDelay={200}
      withinPortal
      onOpen={() => {
        void invoke('update.changelog', {}).then((r) => setHistory(r.ok ? r.value.entries : []))
      }}
    >
      <HoverCard.Target>
        <Badge
          component="button"
          type="button"
          variant="light"
          size="sm"
          radius="sm"
          tt="none"
          fw={500}
          leftSection={<IconRefresh size={12} aria-hidden />}
          className="eva-update-badge"
          data-testid="update-badge"
        >
          Update
        </Badge>
      </HoverCard.Target>
      <HoverCard.Dropdown data-testid="update-popover">
        <Stack gap="xs">
          <div>
            <Text size="sm" fw={500}>
              Update ready
            </Text>
            {update.build ? (
              <Text size="xs" c="dimmed" data-testid="update-popover-build">
                Build {shortBuild(update.build)}
              </Text>
            ) : null}
          </div>
          {changes.length > 0 ? (
            <ul className="eva-update-changes" data-testid="update-popover-changes">
              {changes.slice(0, SHOWN).map((c, i) => (
                <li key={`${i}-${c}`}>
                  <Text size="xs">{c}</Text>
                </li>
              ))}
              {changes.length > SHOWN ? (
                <li>
                  <Text size="xs" c="dimmed">
                    and {changes.length - SHOWN} more
                  </Text>
                </li>
              ) : null}
            </ul>
          ) : (
            <Text size="xs" c="dimmed" data-testid="update-popover-summary">
              {updateSummaryLine(update)}
            </Text>
          )}
          {note ? (
            <Text size="xs" c="dimmed" data-testid="update-popover-note">
              {note}
            </Text>
          ) : null}
          <Button
            size="compact-sm"
            data-testid="update-popover-restart"
            onMouseDown={(e) => e.preventDefault()}
            onClick={restartForUpdate}
          >
            Restart
          </Button>
        </Stack>
      </HoverCard.Dropdown>
    </HoverCard>
  )
}
