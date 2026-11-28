import type { MouseEvent } from 'react'
import { ActionIcon, Button, Tooltip, UnstyledButton } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { IconAt, IconCheck } from '@tabler/icons-react'
import { PersonAvatar, stopKeys } from './CardChips'
import { setWaitingHandled } from './agents-store'
import { agoLabel, type CardWaiting } from './board-view'

const TOAST_ID = 'agents-handled'
const TOAST_MS = 6000

function toastFailed(message: string): void {
  notifications.show({ id: TOAST_ID, color: 'red', message })
}

async function handle(w: CardWaiting): Promise<void> {
  const error = await setWaitingHandled(w, false)
  if (error !== null) return toastFailed(`Couldn't mark it as handled: ${error}`)
  notifications.hide(TOAST_ID)
  notifications.show({
    id: TOAST_ID,
    autoClose: TOAST_MS,
    message: (
      <span className="eva-ab-toast">
        <span>Marked as handled</span>
        <Button
          variant="subtle"
          size="compact-sm"
          data-testid="agents-handled-undo"
          onClick={() => {
            notifications.hide(TOAST_ID)
            void setWaitingHandled(w, true).then((e) => {
              if (e !== null) toastFailed(`Couldn't bring it back: ${e}`)
            })
          }}
        >
          Undo
        </Button>
      </span>
    ),
  })
}

/**
 * "Waiting on you": who, how long ago, and their words on hover. Clicking it opens the card's
 * conversation; the check beside it marks it handled (Relay-only) with an Undo toast. Neither
 * reaches the card under it.
 */
export function WaitChip({
  waiting,
  now,
  onOpen,
}: {
  waiting: CardWaiting
  now: number
  onOpen: () => void
}) {
  const more = waiting.count > 1 ? ` (${waiting.count} waiting)` : ''
  return (
    <span className="eva-ab-wait" data-testid="agents-wait">
      <Tooltip
        label={`${waiting.author.name}: ${waiting.excerpt}${more}`}
        openDelay={300}
        multiline
        maw={320}
      >
        <UnstyledButton
          className="eva-ab-wait-open"
          onKeyDown={stopKeys}
          onClick={(e: MouseEvent) => {
            e.stopPropagation()
            onOpen()
          }}
          data-testid="agents-wait-open"
        >
          <IconAt size={12} stroke={2} aria-hidden />
          <span>Waiting on you</span>
          <PersonAvatar person={waiting.author} size={14} />
          <span className="eva-ab-wait-who">
            {waiting.author.name.trim().split(/\s+/)[0]} · {agoLabel(waiting.at, now)}
          </span>
        </UnstyledButton>
      </Tooltip>
      <Tooltip label="Mark as handled" openDelay={300}>
        <ActionIcon
          variant="subtle"
          color="gray"
          size={20}
          className="eva-ab-wait-done"
          aria-label="Mark as handled"
          data-testid="agents-wait-handled"
          onKeyDown={stopKeys}
          onClick={(e: MouseEvent) => {
            e.stopPropagation()
            void handle(waiting)
          }}
        >
          <IconCheck size={13} stroke={2} />
        </ActionIcon>
      </Tooltip>
    </span>
  )
}
