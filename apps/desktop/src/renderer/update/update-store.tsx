import { Button, Group, Text } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import type { UpdateState } from '@evaos/contract'
import { invoke, on } from '../ipc'

const TOAST_ID = 'relay-update'

/**
 * Main's pending update (main/update) mirrored here. `dismissed`: Isaac clicked Later, so the
 * footer chip offers the restart instead of the toast.
 */
export const updateStore = createStore<{ update: UpdateState; dismissed: boolean }>(() => ({
  update: { pending: false, build: null, summary: null },
  dismissed: false,
}))

export function useUpdate<T>(selector: (s: { update: UpdateState; dismissed: boolean }) => T): T {
  return useStore(updateStore, selector)
}

/** Restarts into the pending update; unsaved edits still ask first. */
export function restartForUpdate(): void {
  void invoke('update.restart', {})
}

function showToast(update: UpdateState): void {
  notifications.hide(TOAST_ID)
  notifications.show({
    id: TOAST_ID,
    autoClose: false,
    withCloseButton: false,
    title: `Update ready: ${update.summary ?? ''}`,
    'data-testid': 'update-toast',
    message: (
      <>
        {update.build ? (
          <Text size="xs" c="dimmed">
            Build {update.build}
          </Text>
        ) : null}
        <Group gap="xs" mt="xs">
          <Button
            size="compact-xs"
            onMouseDown={(e) => e.preventDefault()}
            onClick={restartForUpdate}
          >
            Restart now
          </Button>
          <Button
            size="compact-xs"
            variant="default"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              notifications.hide(TOAST_ID)
              updateStore.setState({ dismissed: true })
            }}
          >
            Later
          </Button>
        </Group>
      </>
    ),
  })
}

/** A new offer shows the toast again, even after Later. */
function apply(update: UpdateState): void {
  const prev = updateStore.getState().update
  const changed = prev.build !== update.build || prev.summary !== update.summary
  if (!update.pending) {
    notifications.hide(TOAST_ID)
    updateStore.setState({ update, dismissed: false })
    return
  }
  if (!changed) return
  updateStore.setState({ update, dismissed: false })
  showToast(update)
}

export function startUpdate(): () => void {
  const off = on('update.changed', apply)
  // An offer made before this page loaded is already pending in main.
  void invoke('update.state', {}).then((r) => {
    if (r.ok) apply(r.value)
  })
  return off
}
