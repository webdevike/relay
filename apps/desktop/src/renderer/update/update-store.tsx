import { Button, Group, Text } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import type { UpdateCheckStatus, UpdateState } from '@evaos/contract'
import { placeOf } from '@evaos/shell-core'
import { invoke, on } from '../ipc'
import { openPlace } from '../navigation/navigate'

const TOAST_ID = 'relay-update'

interface UpdateSlice {
  update: UpdateState
  /** A check is running (the packaged updater downloads and stages inside it). */
  checking: boolean
  /** A restart into the update was asked for and has not happened (unsaved edits may hold it). */
  installing: boolean
  /** Why the last check found nothing to offer; null after a good one. */
  error: string | null
}

/** Main's pending update (main/update) mirrored here, with the sidebar button's own state. */
export const updateStore = createStore<UpdateSlice>(() => ({
  update: { pending: false, build: null, summary: null },
  checking: false,
  installing: false,
  error: null,
}))

export function useUpdate<T>(selector: (s: UpdateSlice) => T): T {
  return useStore(updateStore, selector)
}

/** How long a restart that never happened (an unsaved-edits prompt said no) reads as installing. */
const INSTALLING_MS = 20_000

/** Restarts into the pending update; unsaved edits still ask first. */
export function restartForUpdate(): void {
  updateStore.setState({ installing: true })
  setTimeout(() => updateStore.setState({ installing: false }), INSTALLING_MS)
  void invoke('update.restart', {})
}

const CHECK_ERROR: Partial<Record<UpdateCheckStatus, string>> = {
  unavailable: 'This copy has no update source.',
  failed: "Couldn't check. Try again.",
}

/** Looks for a newer build now; a found one arrives as `update.changed`. */
export function checkForUpdate(): void {
  if (updateStore.getState().checking) return
  updateStore.setState({ checking: true, error: null })
  void invoke('update.check', {}).then((r) => {
    updateStore.setState({
      checking: false,
      error: r.ok ? (CHECK_ERROR[r.value.status] ?? null) : "Couldn't check. Try again.",
    })
  })
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
    updateStore.setState({ update, installing: false })
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
