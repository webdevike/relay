import { Button } from '@mantine/core'
import { EvaModal } from '../../overlay'

/** Confirms deleting a custom category. Keep category has initial focus; no chat is deleted. */
export function DeleteCategoryModal({
  name,
  onClose,
  onConfirm,
}: {
  name: string | null
  onClose: () => void
  onConfirm: (name: string) => void
}) {
  return (
    <EvaModal
      opened={name !== null}
      onClose={onClose}
      title={`Delete category "${name ?? ''}"?`}
      testid="delete-category-modal"
    >
      <p className="eva-cl-delete-body">
        Its chats go back to their workspace group. No chats are deleted.
      </p>
      <div className="eva-cl-delete-actions">
        <Button variant="default" data-autofocus onClick={onClose}>
          Keep category
        </Button>
        <Button
          className="eva-cl-delete-confirm"
          onClick={() => {
            if (name !== null) onConfirm(name)
            onClose()
          }}
        >
          Delete category
        </Button>
      </div>
    </EvaModal>
  )
}
