import { Button, Modal } from '@mantine/core'
import { useOccludeBrowser } from './overlay-store'

export function TestOverlay({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  useOccludeBrowser(opened)
  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title="Test overlay"
      size={400}
      padding="md"
      centered
      withCloseButton={false}
    >
      <div data-testid="overlay-test">
        <p className="eva-overlay-body">The browser view is hidden while this is open.</p>
        <Button variant="default" onClick={onClose}>
          Close
        </Button>
      </div>
    </Modal>
  )
}
