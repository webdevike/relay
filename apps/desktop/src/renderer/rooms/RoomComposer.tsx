import { useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { ActionIcon, Textarea } from '@mantine/core'
import { IconArrowUp } from '@tabler/icons-react'
import { roomIsLive } from '@evaos/contract'
import { useAssistants } from '../assistants/assistants-store'
import { AgentFace } from '../comments/ThreadParts'
import { MentionBackdrop } from '../chat/composer/MentionBackdrop'
import { SlashMenu, type MenuRow } from '../chat/composer/SlashMenu'
import {
  atQueryAt,
  atRows,
  insertAgent,
  roomAgentsAt,
  type AtAgent,
} from '../chat/composer/at-menu'
import '../chat/composer/composer.css'
import { postToRoom } from './rooms-store'
import type { Room } from './types'

/** What the box says: a chat room is always open to Isaac; a council room only while it can take posts. */
function placeholderOf(room: Room, open: boolean): string {
  if (room.phase === 'paused')
    return room.kind === 'chat'
      ? 'Paused: your message waits for Resume'
      : 'Paused: your message joins the next round'
  if (room.kind === 'chat') return 'Message the room, or @mention a member'
  return open ? 'Message the room, @ to address someone' : 'The room is closed'
}

/**
 * A room's composer, built from the chat composer's parts: the box, the one `@` menu (the members
 * "in this room", then the assistants who would join as guests; a council room's people) with
 * inline chips, and the round send button. A chat room's setup draft waits in the box unsent.
 */
export function RoomComposer({ room }: { room: Room }) {
  const [text, setText] = useState(() =>
    room.kind === 'chat' && room.messages.length === 0 ? (room.chat?.setup.draft ?? '') : '',
  )
  const [caret, setCaret] = useState(0)
  const [pick, setPick] = useState(0)
  const [hidden, setHidden] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const field = useRef<HTMLTextAreaElement>(null)
  // A paused room takes posts too: they are answered once it resumes.
  const open = room.kind === 'chat' || roomIsLive(room.phase) || room.phase === 'paused'
  const registry = useAssistants((s) => s.data?.agents)
  const members = room.chat?.setup.members
  const agents: AtAgent[] = useMemo(
    () =>
      members
        ? roomAgentsAt(members, registry ?? [])
        : room.agents.map((a) => ({ id: a.id, name: a.name, note: a.role || a.title })),
    [members, registry, room.agents],
  )
  const query = open ? atQueryAt(text, caret) : null
  const at = query && !hidden ? atRows(null, query.query, 'top', agents, false) : []
  const rows: MenuRow[] = at.map((r) => ({
    key: r.key,
    title: r.title,
    description: r.description,
    ...(r.section ? { section: r.section } : {}),
    icon: <AgentFace id={r.item.kind === 'agent' ? r.item.id : r.key} name={r.title} />,
  }))
  const selected = Math.min(pick, rows.length - 1)

  const edit = (value: string, at: number): void => {
    setText(value)
    setCaret(at)
    setPick(0)
    setHidden(false)
  }
  const send = (): void => {
    const body = text.trim()
    if (body === '' || !open) return
    edit('', 0)
    setError(null)
    void postToRoom(room.id, body).then((e) => {
      if (e === null) return
      setError(e)
      setText(body)
    })
  }
  const choose = (i: number): void => {
    const item = at[i]?.item
    if (!query || item?.kind !== 'agent') return
    const next = insertAgent(text, caret, query, item.name)
    edit(next.text, next.caret)
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
      if ((e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) || e.key === 'Tab') {
        e.preventDefault()
        choose(selected)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        setHidden(true)
        return
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      send()
    }
  }
  return (
    <div className="eva-composer eva-room-composer" data-testid="room-composer-box">
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
            onChange={(e) =>
              edit(
                e.currentTarget.value,
                e.currentTarget.selectionStart ?? e.currentTarget.value.length,
              )
            }
            onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
            onKeyDown={onKeyDown}
            data-testid="room-composer"
          />
          <MentionBackdrop text={text} field={field} people={agents} />
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
