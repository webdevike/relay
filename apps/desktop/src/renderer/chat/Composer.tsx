import { useState } from 'react'
import { ActionIcon, Textarea } from '@mantine/core'
import { IconArrowUp, IconPlayerStopFilled } from '@tabler/icons-react'
import { invoke } from '../ipc'
import { chatStore, useChatStore } from './chat-store'

/**
 * Phase 1 composer stub: Enter sends (a send while a reply runs is a steer), Shift+Enter inserts
 * a newline. Stop and Escape abort the running turn.
 */
export function Composer({ paneId, disabled }: { paneId: string; disabled: boolean }) {
  const [text, setText] = useState('')
  const running = useChatStore((s) => s.panes[paneId]?.running ?? false)
  const stopped = useChatStore((s) => s.panes[paneId]?.stopped ?? false)
  const hasError = useChatStore((s) => (s.panes[paneId]?.error ?? null) !== null)

  const abort = async (): Promise<void> => {
    await invoke('chat.abort', { paneId })
  }

  const send = async (): Promise<void> => {
    const value = text.trim()
    if (value === '' || disabled) return
    setText('')
    const r = await invoke('chat.send', { paneId, text: value })
    if (r.ok) {
      // A prompt that went through supersedes any earlier failure or unexpected exit.
      chatStore.getState().setError(paneId, null)
    } else {
      // Give the prompt back unless something new was typed meanwhile.
      setText((current) => (current === '' ? value : current))
      chatStore.getState().setError(paneId, r.error.message)
    }
  }

  const edit = (value: string): void => {
    setText(value)
    // Dismissed, not cleared: main keeps its error until the next prompt, and a resync in
    // between must not bring the banner back.
    if (hasError) chatStore.getState().dismissError(paneId)
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
          disabled || stopped
            ? 'Session is not running. Resume it to send a message.'
            : 'Message Eva'
        }
        disabled={disabled}
        value={text}
        onChange={(e) => edit(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && running) {
            e.preventDefault()
            void abort()
            return
          }
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            void send()
          }
        }}
      />
      {running ? (
        <ActionIcon
          size={28}
          variant="default"
          data-testid="composer-stop"
          aria-label="Stop"
          onClick={() => void abort()}
        >
          <IconPlayerStopFilled size={14} />
        </ActionIcon>
      ) : null}
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
