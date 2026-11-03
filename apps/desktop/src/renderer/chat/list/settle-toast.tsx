import { Button } from '@mantine/core'
import { notifications } from '@mantine/notifications'

export const SETTLE_TOAST_ID = 'chat-settled'
export const SETTLE_TOAST_MS = 6000

/** `Chat settled` with an Undo action, closed after 6 s. */
export function showSettledToast(onUndo: () => void): void {
  notifications.hide(SETTLE_TOAST_ID)
  notifications.show({
    id: SETTLE_TOAST_ID,
    autoClose: SETTLE_TOAST_MS,
    message: (
      <span className="eva-cl-toast">
        <span>Chat settled</span>
        <Button
          variant="subtle"
          size="compact-sm"
          onClick={() => {
            notifications.hide(SETTLE_TOAST_ID)
            onUndo()
          }}
        >
          Undo
        </Button>
      </span>
    ),
  })
}
