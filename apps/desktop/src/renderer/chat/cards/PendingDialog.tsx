import './cards.css'
import { useState } from 'react'
import type { DialogResponse } from '@evaos/contract'
import { invoke } from '../../ipc'
import { useChatStore } from '../chat-store'
import { ExtensionUiCard } from './ExtensionUiCard'
import { QuestionCard } from './QuestionCard'

/** The open question above the composer, or the dimmed card of one that can no longer be answered. */
export function PendingDialog({ paneId }: { paneId: string }) {
  const live = useChatStore((s) => s.panes[paneId]?.dialog ?? null)
  const deadDialog = useChatStore((s) => s.panes[paneId]?.deadDialog ?? null)
  const [failed, setFailed] = useState<string | null>(null)
  const dialog = live ?? deadDialog
  if (!dialog) return null
  const dead = live === null

  const answer = (response: DialogResponse): void => {
    setFailed(null)
    void invoke('chat.answerUi', { paneId, id: dialog.id, response }).then((r) => {
      if (!r.ok) setFailed(r.error.message)
    })
  }

  return (
    <div className="eva-pending-dialog" data-testid="pending-dialog-slot">
      {dialog.kind === 'select' || dialog.kind === 'ask' ? (
        <QuestionCard key={dialog.id} dialog={dialog} dead={dead} onAnswer={answer} />
      ) : (
        <ExtensionUiCard key={dialog.id} dialog={dialog} dead={dead} onAnswer={answer} />
      )}
      {failed ? (
        <div className="eva-error-banner" role="alert">
          {failed}
        </div>
      ) : null}
    </div>
  )
}
