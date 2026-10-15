import { useEffect, useRef, useState } from 'react'
import type { Dialog } from '@evaos/chat-core/message'
import type { DialogResponse } from '@evaos/contract'

type Free = Extract<Dialog, { kind: 'confirm' | 'input' | 'editor' }>

/** Extension UI requests that are not a choice list: confirm, input and editor. */
export function ExtensionUiCard({
  dialog,
  dead = false,
  onAnswer,
}: {
  dialog: Free
  dead?: boolean
  onAnswer: (response: DialogResponse) => void
}) {
  const [value, setValue] = useState(dialog.kind === 'editor' ? (dialog.prefill ?? '') : '')
  const declineRef = useRef<HTMLButtonElement>(null)
  const textRef = useRef<HTMLTextAreaElement | HTMLInputElement>(null)
  const sent = useRef(false)

  useEffect(() => {
    if (dead) return
    if (dialog.kind === 'confirm') declineRef.current?.focus()
    else if (dialog.kind === 'editor') textRef.current?.focus()
  }, [dialog.kind, dead])

  const answer = (r: DialogResponse): void => {
    if (sent.current || dead) return
    sent.current = true
    onAnswer(r)
  }
  const sendText = (): void => answer({ kind: 'text', value })
  const cancel = (): void => answer({ kind: 'cancel' })

  return (
    <div
      className="eva-question"
      data-testid="pending-dialog"
      data-dead={dead ? 'true' : undefined}
    >
      <div className="eva-question-text">{dialog.title}</div>
      {dialog.kind === 'confirm' && dialog.message ? (
        <div className="eva-dim eva-question-desc">{dialog.message}</div>
      ) : null}
      {dialog.kind === 'input' ? (
        <input
          ref={textRef as React.RefObject<HTMLInputElement>}
          className="eva-card-input"
          type="text"
          aria-label={dialog.title}
          placeholder={dialog.placeholder}
          disabled={dead}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) sendText()
          }}
        />
      ) : null}
      {dialog.kind === 'editor' ? (
        <textarea
          ref={textRef as React.RefObject<HTMLTextAreaElement>}
          className="eva-card-input eva-mono"
          rows={4}
          aria-label={dialog.title}
          placeholder={dialog.placeholder}
          disabled={dead}
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
      ) : null}
      <div className="eva-question-actions">
        {dialog.kind === 'confirm' ? (
          <>
            <button
              type="button"
              className="eva-card-button"
              disabled={dead}
              onClick={() => answer({ kind: 'confirm', confirmed: true })}
            >
              Confirm
            </button>
            <button
              ref={declineRef}
              type="button"
              className="eva-card-button"
              disabled={dead}
              onClick={cancel}
            >
              Decline
            </button>
          </>
        ) : (
          <>
            <button type="button" className="eva-card-button" disabled={dead} onClick={sendText}>
              Send answer
            </button>
            {dialog.kind === 'editor' ? (
              <button type="button" className="eva-card-button" disabled={dead} onClick={cancel}>
                Discard input
              </button>
            ) : null}
          </>
        )}
      </div>
      {dead ? (
        <div className="eva-label eva-dim eva-question-caption">
          This question can no longer be answered.
        </div>
      ) : null}
    </div>
  )
}
