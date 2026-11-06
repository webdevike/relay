import { ActionIcon, HoverCard, Loader, Stack, Text, Tooltip } from '@mantine/core'
import { IconDownload, IconRefresh } from '@tabler/icons-react'
import { useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { shortBuild, type ChangelogEntry } from '@evaos/contract'
import { useAbout } from '../about/build-info'
import { useChatStore } from '../chat/chat-store'
import { invoke } from '../ipc'
import { changesSince, restartNote, updateSummaryLine } from './update-badge'
import { checkForUpdate, restartForUpdate, useUpdate } from './update-store'

/** Changes listed before "and N more". */
const SHOWN = 8

/**
 * The sidebar footer's update icon. Quiet refresh checks for updates; once one waits it turns into
 * a download icon with an accent dot and one click restarts into it. A spinner covers checking and
 * installing. Hover shows what the update brings, or why a check found nothing.
 */
export function UpdateButton() {
  const { update, checking, installing, error } = useUpdate(useShallow((s) => s))
  const about = useAbout()
  const [history, setHistory] = useState<ChangelogEntry[] | null>(null)
  const running = useChatStore(
    useShallow((s) =>
      Object.values(s.panes)
        .filter((p) => p.running)
        .map((p) => p.title),
    ),
  )
  const busy = checking || installing
  const ready = update.pending
  const label = installing
    ? 'Restarting to update'
    : checking
      ? 'Checking for updates'
      : ready
        ? 'Update and restart'
        : 'Check for updates'
  const changes = history === null ? [] : changesSince(history, about?.build ?? null, update.build)
  const note = restartNote(running)
  return (
    <HoverCard
      width={280}
      position="top-end"
      shadow="md"
      withArrow={false}
      openDelay={150}
      closeDelay={200}
      withinPortal
      disabled={!ready && error === null}
      onOpen={() => {
        if (ready)
          void invoke('update.changelog', {}).then((r) => setHistory(r.ok ? r.value.entries : []))
      }}
    >
      <HoverCard.Target>
        <Tooltip
          label={label}
          position="top"
          openDelay={400}
          withinPortal
          disabled={ready || error !== null}
        >
          <ActionIcon
            variant="subtle"
            color="gray"
            className="eva-sb-icon"
            data-testid="update-button"
            aria-label={label}
            aria-busy={busy}
            disabled={busy}
            onMouseDown={(e) => e.preventDefault()}
            onClick={ready ? restartForUpdate : checkForUpdate}
          >
            {busy ? (
              <Loader size={14} color="currentColor" />
            ) : ready ? (
              <>
                <IconDownload size={16} stroke={1.5} />
                <span className="eva-sb-icon-dot" aria-hidden />
              </>
            ) : (
              <IconRefresh size={16} stroke={1.5} />
            )}
          </ActionIcon>
        </Tooltip>
      </HoverCard.Target>
      <HoverCard.Dropdown data-testid="update-popover">
        {ready ? (
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
          </Stack>
        ) : (
          <Text size="xs" data-testid="update-popover-error">
            {error}
          </Text>
        )}
      </HoverCard.Dropdown>
    </HoverCard>
  )
}
