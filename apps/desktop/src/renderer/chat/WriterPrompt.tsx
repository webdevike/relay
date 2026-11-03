import { Button } from '@mantine/core'
import { EvaModal } from '../overlay'

/**
 * Asks before sending into a chat another pane (or another omp) is writing to. `Don't send`
 * has initial focus; the choice is remembered by main until the owner changes.
 */
export function WriterPrompt({
  opened,
  message,
  onCancel,
  onConfirm,
}: {
  opened: boolean
  message: string
  onCancel: () => void
  onConfirm: () => void
}) {
  return (
    <EvaModal
      opened={opened}
      onClose={onCancel}
      title="Chat is open elsewhere"
      size={400}
      testid="writer-prompt"
    >
      <p className="eva-writer-prompt-body">{message}</p>
      <div className="eva-writer-prompt-actions">
        <Button variant="default" data-autofocus onClick={onCancel}>
          Don&apos;t send
        </Button>
        <Button onClick={onConfirm} data-testid="writer-prompt-confirm">
          Send anyway
        </Button>
      </div>
    </EvaModal>
  )
}
