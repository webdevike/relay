import { useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { ActionIcon, Textarea } from '@mantine/core'
import { IconArrowUp, IconBrain, IconFileSearch } from '@tabler/icons-react'
import { roomIsLive } from '@evaos/contract'
import { SlashMenu, type MenuRow } from '../chat/composer/SlashMenu'
import '../chat/composer/composer.css'
import { TypingDots } from '../ui/TypingDots'
import { insertMention, insertRaw, mentionChoices, mentionQueryAt, mentionables } from './mentions'
import { presenceGroups } from './presence'
import { AuthorAvatar, authorOf } from './RoomMessageRow'
import { postToRoom } from './rooms-store'
import type { Room } from './types'

/** What the box says: a chat room is always open to Isaac; a council room only while it can take posts. */
function placeholderOf(room: Room, open: boolean): string {
  if (room.kind === 'chat') return 'Message the room, or @mention a member'
  if (room.phase === 'paused') return 'Paused: your message joins the next round'
  return open ? 'Message the room, @ to address someone' : 'The room is closed'
}

/**
 * A room's composer, built from the chat composer's parts: the box, the @ menu (the members and
 * Isaac) and the round send button, with who is doing what above it. A chat room's setup draft
 * waits in the box unsent.
 */
export function RoomComposer({ room }: { room: Room }) {
  const [text, setText] = useState(() =>
    room.kind === 'chat' && room.messages.length === 0 ? (room.chat?.setup.draft ?? '') : '',
  )
  const [caret, setCaret] = useState(0)
  const [pick, setPick] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const field = useRef<HTMLTextAreaElement>(null)
  // A paused council room takes posts too: they join the next round once it resumes.
  const open = room.kind === 'chat' || roomIsLive(room.phase) || room.phase === 'paused'
  const people = useMemo(() => mentionables(room.agents), [room.agents])
  const query = mentionQueryAt(text, caret)
  const choices = query ? mentionChoices(people, query.query) : []
  const rows: MenuRow[] = choices.map((c) => {
    const author = authorOf(room.agents, c.id)
    return {
      key: c.id,
      title: c.name,
      description: author.role || author.title,
      icon: <AuthorAvatar author={author} size="sm" />,
    }
  })
  const selected = Math.min(pick, rows.length - 1)

  const send = (): void => {
    const body = text.trim()
    if (body === '' || !open) return
    setText('')
    setCaret(0)
    setError(null)
    void postToRoom(room.id, body).then((e) => {
      if (e === null) return
      setError(e)
      setText(body)
    })
  }
  const choose = (i: number): void => {
    const c = choices[i]
    if (!query || !c) return
    const next = insertMention(text, caret, query, c.name)
    setText(next.text)
    setCaret(next.caret)
    setPick(0)
    const el = field.current
    if (el) {
      el.focus()
      requestAnimationFrame(() => el.setSelectionRange(next.caret, next.caret))
    }
  }
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (rows.length > 0) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const d = e.key === 'ArrowDown' ? 1 : -1
        setPick((selected + d + rows.length) % rows.length)
        return
      }
      if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
        e.preventDefault()
        choose(selected)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        // Closing means leaving the @word: a trailing space ends the query.
        const next = insertRaw(text, caret, ' ')
        setText(next.text)
        setCaret(next.caret)
        return
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      send()
    }
  }
  const groups = presenceGroups(room)
  return (
    <div className="eva-composer eva-room-composer" data-testid="room-composer-box">
      {groups.length > 0 ? (
        <div className="eva-rooms-typing" data-testid="room-presence" aria-live="polite">
          {groups.map((g) => (
            <span key={g.label} className="eva-rooms-presence" data-state={g.state}>
              {g.state === 'typing' ? (
                <TypingDots label={g.label} size="inline" />
              ) : g.state === 'reading' ? (
                <IconFileSearch size={14} stroke={1.5} aria-hidden />
              ) : (
                <IconBrain size={14} stroke={1.5} aria-hidden />
              )}
              <span>{g.label}</span>
            </span>
          ))}
        </div>
      ) : null}
      <div className="eva-composer-frame">
        {rows.length > 0 ? (
          <SlashMenu
            rows={rows}
            selected={selected}
            onPick={choose}
            label="Mentions"
            testid="room-mentions"
          />
        ) : null}
        <div className="eva-composer-line">
          <Textarea
            ref={field}
            autosize
            minRows={2}
            maxRows={8}
            className="eva-composer-field"
            classNames={{ input: 'eva-composer-input' }}
            variant="unstyled"
            placeholder={placeholderOf(room, open)}
            aria-label="Message the room"
            value={text}
            disabled={!open}
            onChange={(e) => {
              setText(e.currentTarget.value)
              setCaret(e.currentTarget.selectionStart ?? e.currentTarget.value.length)
              setPick(0)
            }}
            onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
            onKeyDown={onKeyDown}
            data-testid="room-composer"
          />
        </div>
        <div className="eva-composer-toolbar">
          <div className="eva-composer-tools" />
          <div className="eva-composer-actions">
            <ActionIcon
              className="eva-composer-round"
              size="var(--eva-tile-md)"
              variant="filled"
              aria-label="Send"
              disabled={text.trim() === '' || !open}
              onClick={send}
              data-testid="room-send"
            >
              <IconArrowUp size="calc(var(--eva-font-size) * .875)" />
            </ActionIcon>
          </div>
        </div>
      </div>
      {error ? (
        <div className="eva-composer-notice" role="alert">
          {error}
        </div>
      ) : null}
    </div>
  )
}
