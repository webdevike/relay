import { Button } from '@mantine/core'
import { notifications } from '@mantine/notifications'

export const ARCHIVE_TOAST_ID = 'chat-archived'
export const ARCHIVE_TOAST_MS = 6000

/** `Chat archived` with an Undo action, closed after 6 s. */
export function showArchivedToast(onUndo: () => void): void {
  notifications.hide(ARCHIVE_TOAST_ID)
  notifications.show({
    id: ARCHIVE_TOAST_ID,
    autoClose: ARCHIVE_TOAST_MS,
    message: (
      <span className="eva-cl-toast">
        <span>Chat archived</span>
        <Button
          variant="subtle"
          size="compact-sm"
          onClick={() => {
            notifications.hide(ARCHIVE_TOAST_ID)
            onUndo()
          }}
        >
          Undo
        </Button>
      </span>
    ),
  })
}
