import { ActionIcon, Avatar, Button, Checkbox, Textarea, Tooltip } from '@mantine/core'
import {
  IconBrain,
  IconFileSearch,
  IconPlayerStop,
  IconPlus,
  IconSend,
  IconTool,
  IconUsersGroup,
} from '@tabler/icons-react'
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { roomIsLive, type RoomPresence } from '@evaos/contract'
import type { Place } from '@evaos/shell-core'
import { pageMeta } from '../pages/page-meta'
import { TypingDots } from '../ui/TypingDots'
import { RoomFeed } from './RoomFeed'
import { presenceGroups } from './presence'
import { EvaPopover } from '../overlay'
import { insertMention, insertRaw, mentionChoices, mentionQueryAt, mentionables } from './mentions'
import { AuthorAvatar, authorOf, type Author } from './RoomMessageRow'
import { ROSTER } from './roster'
import { postToRoom, setActive, startRoom, stopRoom, useRooms } from './rooms-store'
import type { Room, RoomPhase } from './types'
import './rooms.css'

const PHASE_LABEL: Record<RoomPhase, string> = {
  open: 'Live',
  wrapping: 'Wrapping up',
  resolved: 'Resolved',
  failed: 'Failed',
}

const PRESENCE_VERB: Record<RoomPresence['state'], string> = {
  thinking: 'thinking',
  reading: 'reading',
  typing: 'typing',
}

/** "0:42", "12:05", "1:02:09". */
export function elapsedLabel(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m)
  return `${h > 0 ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`
}

function useNow(tick: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!tick) return
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [tick])
  return now
}

/** The phase, the judge's last word as its tooltip (or the failure). */
function StatusPill({ room }: { room: Room }) {
  const note = room.phase === 'failed' ? room.error : room.judge?.note
  const pill = (
    <span className="eva-rooms-pill" data-status={room.phase} data-testid="room-phase">
      {PHASE_LABEL[room.phase]}
    </span>
  )
  return note ? (
    <Tooltip label={note} openDelay={300} multiline maw={320}>
      {pill}
    </Tooltip>
  ) : (
    pill
  )
}

function NewRoomForm({ title, description }: { title: string; description: string }) {
  const [prompt, setPrompt] = useState('')
  const [picked, setPicked] = useState<string[]>(() => ROSTER.map((a) => a.id))
  const [starting, setStarting] = useState(false)
  const error = useRooms((s) => s.createError)
  const canStart = prompt.trim() !== '' && picked.length > 0 && !starting
  const start = (): void => {
    if (!canStart) return
    setStarting(true)
    void startRoom(prompt, picked).finally(() => setStarting(false))
  }
  return (
    <div className="eva-rooms-new" data-testid="rooms-new">
      <div className="eva-rooms-new-head">
        <IconUsersGroup size={28} stroke={1.5} aria-hidden />
        <h1 className="eva-rooms-new-title" data-page-title>
          {title}
        </h1>
        <p className="eva-rooms-dim">{description}</p>
      </div>
      <Textarea
        label="Question for the room"
        autosize
        minRows={2}
        maxRows={6}
        value={prompt}
        onChange={(e) => setPrompt(e.currentTarget.value)}
        data-testid="rooms-prompt"
      />
      <div className="eva-rooms-roster">
        <div className="eva-rooms-roster-label">Who is in the room</div>
        {ROSTER.map((a) => (
          <Checkbox
            key={a.id}
            className="eva-rooms-roster-row"
            checked={picked.includes(a.id)}
            onChange={(e) =>
              setPicked((p) =>
                e.currentTarget.checked ? [...p, a.id] : p.filter((id) => id !== a.id),
              )
            }
            data-testid={`rooms-pick-${a.id}`}
            label={
              <span className="eva-rooms-roster-person">
                <AuthorAvatar author={a} size="md" />
                <span className="eva-rooms-roster-text">
                  <span className="eva-rooms-roster-line">
                    <span className="eva-rooms-roster-name">{a.name}</span>
                    <span className="eva-rooms-dim">{a.title}</span>
                    {a.tools === 'read-only' ? (
                      <Tooltip label="Can read code and the web" openDelay={300}>
                        <IconTool
                          size={14}
                          stroke={1.5}
                          className="eva-rooms-roster-tool"
                          aria-label="Can read code and the web"
                          data-testid={`rooms-tools-${a.id}`}
                        />
                      </Tooltip>
                    ) : null}
                  </span>
                  <span className="eva-rooms-dim">
                    {a.role}, {a.model}
                  </span>
                </span>
              </span>
            }
          />
        ))}
      </div>
      <div className="eva-rooms-new-actions">
        <Button onClick={start} disabled={!canStart} loading={starting} data-testid="rooms-start">
          Start room
        </Button>
        {error ? (
          <span className="eva-rooms-error" role="alert" data-testid="rooms-error">
            {error}
          </span>
        ) : null}
      </div>
    </div>
  )
}

function Composer({ room }: { room: Room }) {
  const [text, setText] = useState('')
  const [caret, setCaret] = useState(0)
  const [pick, setPick] = useState(0)
  const field = useRef<HTMLTextAreaElement>(null)
  const live = roomIsLive(room.phase)
  const people = useMemo(() => mentionables(room.agents), [room.agents])
  const query = mentionQueryAt(text, caret)
  const choices = query ? mentionChoices(people, query.query) : []
  const open = choices.length > 0
  const avatarOf = (id: string): Author => authorOf(room.agents, id)

  const send = (): void => {
    const body = text.trim()
    if (body === '' || !live) return
    void postToRoom(room.id, body)
    setText('')
    setCaret(0)
  }
  const choose = (name: string): void => {
    if (!query) return
    const next = insertMention(text, caret, query, name)
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
    if (open) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const d = e.key === 'ArrowDown' ? 1 : -1
        setPick((i) => (i + d + choices.length) % choices.length)
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        choose(choices[Math.min(pick, choices.length - 1)]!.name)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
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
  const track = (el: HTMLTextAreaElement): void => {
    setText(el.value)
    setCaret(el.selectionStart ?? el.value.length)
    setPick(0)
  }
  const groups = presenceGroups(room)
  return (
    <div className="eva-rooms-composer">
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
      <div className="eva-rooms-composer-row">
        <EvaPopover opened={open} onChange={() => undefined} position="top-start" trapFocus={false}>
          <EvaPopover.Target>
            <Textarea
              ref={field}
              autosize
              minRows={1}
              maxRows={6}
              className="eva-rooms-composer-field"
              placeholder={live ? 'Message the room, @ to address someone' : 'The room is closed'}
              aria-label="Message the room"
              value={text}
              disabled={!live}
              onChange={(e) => track(e.currentTarget)}
              onKeyUp={(e) => setCaret(e.currentTarget.selectionStart ?? caret)}
              onClick={(e) => setCaret(e.currentTarget.selectionStart ?? caret)}
              onKeyDown={onKeyDown}
              data-testid="room-composer"
            />
          </EvaPopover.Target>
          <EvaPopover.Dropdown p={0}>
            <div className="eva-rooms-mention-list" role="listbox" data-testid="room-mentions">
              {choices.map((c, i) => (
                <button
                  key={c.id}
                  type="button"
                  role="option"
                  aria-selected={i === pick}
                  className="eva-rooms-mention-row"
                  data-active={i === pick ? 'true' : undefined}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => choose(c.name)}
                  data-testid={`room-mention-${c.id}`}
                >
                  <AuthorAvatar author={avatarOf(c.id)} size="sm" />
                  <span className="eva-rooms-mention-name">{c.name.split(' ')[0]}</span>
                  <span className="eva-rooms-dim">{avatarOf(c.id).title}</span>
                </button>
              ))}
            </div>
          </EvaPopover.Dropdown>
        </EvaPopover>
        <Tooltip label="Send" openDelay={300}>
          <ActionIcon
            variant="filled"
            size="lg"
            aria-label="Send"
            disabled={text.trim() === '' || !live}
            onClick={send}
            data-testid="room-send"
          >
            <IconSend size={16} stroke={1.5} />
          </ActionIcon>
        </Tooltip>
      </div>
    </div>
  )
}

function RoomView({ room }: { room: Room }) {
  const live = roomIsLive(room.phase)
  const now = useNow(live)
  const elapsed = (room.resolvedAt ?? now) - room.startedAt
  return (
    <div className="eva-rooms-main" data-testid={`room-${room.id}`}>
      <div className="eva-rooms-header">
        <h1 className="eva-rooms-title" title={room.prompt}>
          {room.title}
        </h1>
        <Avatar.Group spacing="xs">
          {room.agents.map((a) => {
            const p = room.presence[a.id]
            const state = p ? `${PRESENCE_VERB[p.state]}${p.detail ? `: ${p.detail}` : ''}` : null
            return (
              <Tooltip
                key={a.id}
                label={`${a.name}, ${a.title} (${a.role})${state ? `, ${state}` : ''}`}
                openDelay={300}
              >
                <span className="eva-rooms-head-avatar" data-testid={`room-avatar-${a.id}`}>
                  <AuthorAvatar author={a} size="sm" />
                  {p ? <span className="eva-rooms-presence-dot" data-state={p.state} /> : null}
                </span>
              </Tooltip>
            )
          })}
        </Avatar.Group>
        <StatusPill room={room} />
        <span className="eva-rooms-clock" data-testid="room-clock">
          {elapsedLabel(elapsed)}
        </span>
        {live ? (
          <Tooltip label="Resolve now: pin the summary from what was said" openDelay={300}>
            <ActionIcon
              variant="subtle"
              color="gray"
              aria-label="Resolve now"
              onClick={() => void stopRoom(room.id)}
              data-testid="room-stop"
            >
              <IconPlayerStop size={16} stroke={1.5} />
            </ActionIcon>
          </Tooltip>
        ) : null}
      </div>
      <RoomFeed room={room} />
      <Composer room={room} />
    </div>
  )
}

function Rail({ now }: { now: number }) {
  const order = useRooms((s) => s.order)
  const rooms = useRooms((s) => s.rooms)
  const active = useRooms((s) => s.activeRoomId)
  return (
    <div className="eva-rooms-rail" data-testid="rooms-rail">
      <div className="eva-rooms-rail-head">
        <span className="eva-rooms-rail-title">Rooms</span>
        <Tooltip label="New room" openDelay={300}>
          <ActionIcon
            variant="subtle"
            color="gray"
            aria-label="New room"
            onClick={() => setActive(null)}
            data-testid="rooms-new-button"
          >
            <IconPlus size={16} stroke={1.5} />
          </ActionIcon>
        </Tooltip>
      </div>
      <div className="eva-rooms-rail-list">
        {order.map((id) => {
          const r = rooms[id]!
          return (
            <button
              key={id}
              type="button"
              className="eva-rooms-rail-row"
              data-active={active === id ? 'true' : undefined}
              aria-current={active === id ? 'true' : undefined}
              onClick={() => setActive(id)}
              data-testid={`rooms-rail-${id}`}
            >
              <span className="eva-rooms-rail-row-title">{r.title}</span>
              <span className="eva-rooms-rail-row-meta">
                <StatusPill room={r} />
                <span className="eva-rooms-clock">
                  {elapsedLabel((r.resolvedAt ?? now) - r.startedAt)}
                </span>
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

export function RoomsPage({ place }: { place: Place }) {
  const meta = pageMeta(place)
  const room = useRooms((s) => (s.activeRoomId ? (s.rooms[s.activeRoomId] ?? null) : null))
  const any = useRooms((s) => s.order.length > 0)
  const live = useRooms((s) => s.order.some((id) => roomIsLive(s.rooms[id]?.phase ?? 'resolved')))
  const now = useNow(any && live)
  return (
    <div className="eva-rooms" data-testid="rooms-page">
      {any ? <Rail now={now} /> : null}
      {room ? (
        <RoomView key={room.id} room={room} />
      ) : (
        <NewRoomForm title={meta.title} description={meta.description} />
      )}
    </div>
  )
}
