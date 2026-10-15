import { Button, Group } from '@mantine/core'
import { EvaModal } from '../overlay'

export function ImportArcModal(props: {
  opened: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <EvaModal opened={props.opened} onClose={props.onCancel} title="Import Arc logins" size={440}>
      <div data-testid="import-arc-modal">
        <p className="eva-overlay-body">
          Copies Arc&apos;s saved logins for the sites on your allowlist into this browser, then
          reloads the page. Imported cookies are stored unencrypted in this browser&apos;s profile,
          so keep banking and password managers off the list.
        </p>
        <Group justify="flex-end" gap="xs">
          <Button variant="default" onClick={props.onCancel}>
            Cancel
          </Button>
          <Button variant="default" data-testid="import-arc-confirm" onClick={props.onConfirm}>
            Import logins
          </Button>
        </Group>
      </div>
    </EvaModal>
  )
}
