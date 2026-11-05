import { Button, Group, Text } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import type { UpdateState } from '@evaos/contract'
import { placeOf } from '@evaos/shell-core'
import { invoke, on } from '../ipc'
import { openPlace } from '../navigation/navigate'

const TOAST_ID = 'relay-update'

/** Main's pending update (main/update) mirrored here; the sidebar card and footer chip read it. */
export const updateStore = createStore<{ update: UpdateState }>(() => ({
  update: { pending: false, build: null, summary: null },
}))

export function useUpdate<T>(selector: (s: { update: UpdateState }) => T): T {
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
    title: 'Update ready',
    'data-testid': 'update-toast',
    message: (
      <>
        {update.summary ? (
          <Text size="sm" data-testid="update-toast-summary">
            {update.summary}
          </Text>
        ) : null}
        <Group gap="xs" mt="xs">
          <Button
            size="compact-xs"
            onMouseDown={(e) => e.preventDefault()}
            onClick={restartForUpdate}
          >
            Restart
          </Button>
          <Button
            size="compact-xs"
            variant="default"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => notifications.hide(TOAST_ID)}
          >
            Later
          </Button>
          <Button
            size="compact-xs"
            variant="subtle"
            data-testid="update-toast-notes"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              notifications.hide(TOAST_ID)
              openPlace(placeOf('settings', { settingsSection: 'Changelog' }))
            }}
          >
            {"What's new"}
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
    updateStore.setState({ update })
    return
  }
  if (!changed) return
  updateStore.setState({ update })
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
