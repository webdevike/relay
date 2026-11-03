import { Button } from '@mantine/core'
import { useEffect, useState } from 'react'
import type { ChatRow as Row } from '@evaos/contract'
import { EvaModal } from '../../overlay'
import { invoke } from '../../ipc'

/** Confirms deleting a chat. Keep chat has initial focus; an error stays in the dialog. */
export function DeleteChatModal({ row, onClose }: { row: Row | null; onClose: () => void }) {
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    setError(null)
    setBusy(false)
  }, [row?.id])

  const confirm = async (): Promise<void> => {
    if (!row || busy) return
    setBusy(true)
    const r = await invoke('chat.delete', { file: row.file })
    setBusy(false)
    if (r.ok) onClose()
    else setError(r.error.message)
  }

  return (
    <EvaModal
      opened={row !== null}
      onClose={onClose}
      title="Delete this chat?"
      testid="delete-chat-modal"
    >
      <p className="eva-cl-delete-body">
        {`This removes the session file for "${row?.title ?? ''}". This cannot be undone.`}
      </p>
      {error ? (
        <p role="alert" className="eva-cl-delete-error" data-testid="delete-chat-error">
          {error}
        </p>
      ) : null}
      <div className="eva-cl-delete-actions">
        <Button variant="default" data-autofocus onClick={onClose}>
          Keep chat
        </Button>
        <Button className="eva-cl-delete-confirm" loading={busy} onClick={() => void confirm()}>
          Delete chat
        </Button>
      </div>
    </EvaModal>
  )
}
