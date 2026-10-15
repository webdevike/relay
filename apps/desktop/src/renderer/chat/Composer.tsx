import { useState } from 'react'
import { ActionIcon, Textarea } from '@mantine/core'
import { IconArrowUp } from '@tabler/icons-react'
import { invoke } from '../ipc'
import { chatStore } from './chat-store'

/** Phase 1 composer stub: Enter sends, Shift+Enter inserts a newline. Stop and Escape-abort arrive in 01-06. */
export function Composer({ paneId, disabled }: { paneId: string; disabled: boolean }) {
  const [text, setText] = useState('')

  const send = async (): Promise<void> => {
    const value = text.trim()
    if (value === '' || disabled) return
    setText('')
    const r = await invoke('chat.send', { paneId, text: value })
    if (!r.ok) chatStore.getState().setError(paneId, r.error.message)
  }

  return (
    <div className="eva-composer" data-testid="composer">
      <Textarea
        autosize
        minRows={1}
        maxRows={6}
        className="eva-composer-field"
        data-testid="composer-input"
        aria-label="Message"
        placeholder={
          disabled ? 'Session is not running. Resume it to send a message.' : 'Message Eva'
        }
        disabled={disabled}
        value={text}
        onChange={(e) => setText(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            void send()
          }
        }}
      />
      <ActionIcon
        size={28}
        variant="filled"
        data-testid="composer-send"
        aria-label="Send message"
        disabled={disabled || text.trim() === ''}
        onClick={() => void send()}
      >
        <IconArrowUp size={16} />
      </ActionIcon>
    </div>
  )
}
