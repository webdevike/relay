import { ActionIcon, Avatar, Button, Checkbox, Textarea, Tooltip } from '@mantine/core'
import { IconPlus, IconSend, IconUsersGroup } from '@tabler/icons-react'
import { useEffect, useState, type KeyboardEvent } from 'react'
import type { Place } from '@evaos/shell-core'
import { pageMeta } from '../pages/page-meta'
import { TypingDots } from '../ui/TypingDots'
import { REPLIES_TO_ISAAC, SCRIPT, TOPIC } from './fixture'
import { createPlayer, type Player } from './player'
import { RoomFeed, typingLabel } from './RoomFeed'
import { AuthorAvatar, authorOf } from './RoomMessageRow'
import { ROSTER } from './roster'
import { createRoom, nextId, post, setActive, useRooms } from './rooms-store'
import { ISAAC, type Room, type RoomAgent, type RoomStatus } from './types'
import './rooms.css'

/** Players outlive the page: a room keeps talking while Isaac is on another tab. */
const players = new Map<string, Player>()

const STATUS_LABEL: Record<RoomStatus, string> = { live: 'Live', resolved: 'Resolved' }

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

function StatusPill({ status }: { status: RoomStatus }) {
  return (
    <span className="eva-rooms-pill" data-status={status}>
      {STATUS_LABEL[status]}
    </span>
  )
}

function NewRoomForm({ title, description }: { title: string; description: string }) {
  const [prompt, setPrompt] = useState(TOPIC)
  const [picked, setPicked] = useState<string[]>(() => ROSTER.map((a) => a.id))
  const canStart = prompt.trim() !== '' && picked.length > 0
  const start = (): void => {
    if (!canStart) return
    const agents: RoomAgent[] = ROSTER.filter((a) => picked.includes(a.id))
    const room = createRoom(prompt, agents)
    const player = createPlayer(room.id, SCRIPT, REPLIES_TO_ISAAC)
    players.set(room.id, player)
    player.start()
  }
  return (
    <div className="eva-rooms-new" data-testid="rooms-new">
      <div className="eva-rooms-new-head">
        <IconUsersGroup size={28} stroke={1.5} aria-hidden />
        <h1 className="eva-rooms-new-title">{title}</h1>
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
              <span className="eva-rooms-roster-text">
                <span className="eva-rooms-roster-name">{a.name}</span>
                <span className="eva-rooms-dim">
                  {a.role}, {a.model}
                </span>
              </span>
            }
          />
        ))}
      </div>
      <div>
        <Button onClick={start} disabled={!canStart} data-testid="rooms-start">
          Start room
        </Button>
      </div>
    </div>
  )
}

function Composer({ room }: { room: Room }) {
  const [text, setText] = useState('')
  const send = (): void => {
    const body = text.trim()
    if (body === '') return
    const player = players.get(room.id)
    if (player) player.isaacPosts(body)
    else
      post(room.id, {
        id: nextId('msg'),
        author: ISAAC,
        text: body,
        ts: Date.now(),
        reactions: [],
        kind: 'message',
      })
    setText('')
  }
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      send()
    }
  }
  const label = typingLabel(room)
  return (
    <div className="eva-rooms-composer">
      <div className="eva-rooms-typing" data-testid="room-typing" aria-live="polite">
        {label ? (
          <>
            <TypingDots label={label} size="inline" />
            <span>{label}</span>
          </>
        ) : null}
      </div>
      <div className="eva-rooms-composer-row">
        <Textarea
          autosize
          minRows={1}
          maxRows={6}
          className="eva-rooms-composer-field"
          placeholder="Message the room"
          aria-label="Message the room"
          value={text}
          onChange={(e) => setText(e.currentTarget.value)}
          onKeyDown={onKeyDown}
          data-testid="room-composer"
        />
        <Tooltip label="Send" openDelay={300}>
          <ActionIcon
            variant="filled"
            size="lg"
            aria-label="Send"
            disabled={text.trim() === ''}
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
  const now = useNow(room.status === 'live')
  const elapsed = (room.resolvedAt ?? now) - room.startedAt
  return (
    <div className="eva-rooms-main" data-testid={`room-${room.id}`}>
      <div className="eva-rooms-header">
        <h1 className="eva-rooms-title" title={room.prompt}>
          {room.title}
        </h1>
        <Avatar.Group spacing="xs">
          {room.agents.map((a) => (
            <Tooltip key={a.id} label={`${a.name}, ${a.model}`} openDelay={300}>
              <span>
                <AuthorAvatar author={authorOf(room.agents, a.id)} size="sm" />
              </span>
            </Tooltip>
          ))}
        </Avatar.Group>
        <StatusPill status={room.status} />
        <span className="eva-rooms-clock" data-testid="room-clock">
          {elapsedLabel(elapsed)}
        </span>
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
                <StatusPill status={r.status} />
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
  const live = useRooms((s) => s.order.some((id) => s.rooms[id]?.status === 'live'))
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
