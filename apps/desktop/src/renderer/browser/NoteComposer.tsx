import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { ActionIcon, Textarea, Tooltip } from '@mantine/core'
import { IconArrowUp, IconMessagePlus, IconX } from '@tabler/icons-react'
import type { AnnotateMark } from '@evaos/contract'

/** The mark in a few words: the element's tag and name, or the dragged region's size. */
export function markLabel(mark: AnnotateMark): string {
  const el = mark.element
  if (!el) return `Area ${mark.region.w}×${mark.region.h}`
  const name = (el.label ?? el.text ?? '').trim()
  return name ? `${el.tag} · ${name}` : el.tag
}

/**
 * Isaac's note on a mark he made on a page (browser.annotate). It is written here in the shell,
 * in the address row's place while the mark is up (so the page doesn't move), never in the page:
 * the page keeps only the mark's outline and never sees a key of the note. Enter sends,
 * Shift+Enter starts a new line, Escape drops the note and the mark.
 */
export function NoteComposer({
  mark,
  color,
  sending,
  onSend,
  onCancel,
}: {
  mark: AnnotateMark
  /** The mark's color on the page. */
  color: string
  sending: boolean
  onSend: (text: string) => void
  onCancel: () => void
}) {
  const [text, setText] = useState('')
  const field = useRef<HTMLTextAreaElement>(null)
  useEffect(() => field.current?.focus(), [])
  // One line high (the address row's height, so the page stays put) until the note itself needs
  // more; CSS caps it at four. Not Mantine's autosize: it counts the placeholder, which wraps in
  // a narrow pane.
  useLayoutEffect(() => {
    const el = field.current
    if (!el) return
    el.style.removeProperty('height')
    if (text)
      el.style.setProperty('height', `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`)
  }, [text])
  const note = text.trim()
  const submit = (): void => {
    if (note && !sending) onSend(note)
  }
  const label = markLabel(mark)
  return (
    <div
      className="eva-address-row eva-note-row"
      data-testid="annotate-composer"
      style={{ '--eva-note-c': color } as CSSProperties}
    >
      <Tooltip label={label} openDelay={400}>
        <span className="eva-note-mark" data-testid="annotate-mark">
          <IconMessagePlus size={13} aria-hidden />
          <span className="eva-note-mark-label">{label}</span>
        </span>
      </Tooltip>
      <Textarea
        ref={field}
        className="eva-note-input"
        size="xs"
        rows={1}
        maxLength={4000}
        placeholder="Note for the chat, Enter sends"
        aria-label="Note for the chat"
        data-testid="annotate-note"
        value={text}
        readOnly={sending}
        onChange={(e) => setText(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            if (!sending) onCancel()
          } else if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            submit()
          }
        }}
      />
      <Tooltip label="Cancel" openDelay={400}>
        <ActionIcon
          variant="subtle"
          size={28}
          aria-label="Cancel note"
          data-testid="annotate-cancel"
          disabled={sending}
          onClick={onCancel}
        >
          <IconX size={16} />
        </ActionIcon>
      </Tooltip>
      <Tooltip label="Send to the chat" openDelay={400}>
        <ActionIcon
          variant="filled"
          radius="xl"
          size={28}
          color={color}
          aria-label="Send note"
          data-testid="annotate-send"
          disabled={!note}
          loading={sending}
          onClick={submit}
        >
          <IconArrowUp size={16} />
        </ActionIcon>
      </Tooltip>
    </div>
  )
}
