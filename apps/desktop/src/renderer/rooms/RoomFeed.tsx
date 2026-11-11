import { IconArrowDown, IconBrain, IconFileSearch, IconPin } from '@tabler/icons-react'
import { Fragment, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ROOM_SYSTEM, mentionSpans } from '@evaos/contract'
import { Markdown } from '../chat/markdown/Markdown'
import '../chat/chat.css'
import '../chat/composer/composer.css'
import { TypingDots } from '../ui/TypingDots'
import { MemberFace } from './MemberStack'
import { mentionMarkdown } from './mentions'
import { presenceGroups } from './presence'
import { RoomMessageRow, authorOf } from './RoomMessageRow'
import { ISAAC_PERSON } from './roster'
import { groupMessages } from './rooms-store'
import { ISAAC, type Room, type RoomMessage } from './types'

/** Within this many px of the bottom counts as following. */
const FOLLOW_SLACK_PX = 24

/** Isaac's text with its @mentions as the composer's chips. */
function MentionText({ text, room }: { text: string; room: Room }) {
  const people = [...room.agents, { id: ISAAC_PERSON.id, name: ISAAC_PERSON.name }]
  let at = 0
  const parts = mentionSpans(text, people).map((s) => {
    const before = text.slice(at, s.start)
    at = s.end
    return (
      <Fragment key={s.start}>
        {before}
        <span className="eva-at-chip">{text.slice(s.start, s.end)}</span>
      </Fragment>
    )
  })
  return (
    <>
      {parts}
      {text.slice(at)}
    </>
  )
}

/** A chat room's own rows: Isaac's message as the chat's user bubble, the room's notes as quiet lines. */
function ChatRoomOwnRow({ msg, room }: { msg: RoomMessage; room: Room }) {
  if (msg.author === ROOM_SYSTEM) {
    return (
      <div className="eva-room-sys" data-testid={`room-msg-${msg.id}`} data-author={msg.author}>
        {msg.text}
      </div>
    )
  }
  return (
    <div className="eva-room-isaac" data-testid={`room-msg-${msg.id}`} data-author={msg.author}>
      <div className="eva-turn-user">
        <div className="eva-bubble">
          <MentionText text={msg.text} room={room} />
        </div>
      </div>
    </div>
  )
}

/** Who is taking a turn, at the end of the log: their faces, "Astra is typing" and the dots. */
function RoomPresence({ room }: { room: Room }) {
  const groups = presenceGroups(room)
  if (groups.length === 0) return null
  const members = room.chat?.setup.members ?? []
  return (
    <div className="eva-rooms-typing" data-testid="room-presence" aria-live="polite">
      {groups.map((g) => (
        <span key={g.label} className="eva-rooms-presence" data-state={g.state}>
          {g.ids.map((id) => {
            const m = members.find((x) => x.id === id)
            return m ? (
              <MemberFace
                key={id}
                member={m}
                className="eva-room-member-face eva-room-presence-face"
              />
            ) : null
          })}
          {g.state === 'reading' ? (
            <IconFileSearch size={14} stroke={1.5} aria-hidden />
          ) : g.state === 'thinking' ? (
            <IconBrain size={14} stroke={1.5} aria-hidden />
          ) : null}
          <span>{g.label}</span>
          {g.state === 'typing' ? <TypingDots label={g.label} size="inline" /> : null}
        </span>
      ))}
    </div>
  )
}

export function RoomFeed({ room }: { room: Room }) {
  const viewport = useRef<HTMLDivElement>(null)
  const [following, setFollowing] = useState(true)
  const groups = useMemo(() => groupMessages(room.messages), [room.messages])
  const summary = room.phase === 'resolved' ? room.messages.find((m) => m.kind === 'summary') : null
  const members = room.chat?.setup.members

  useLayoutEffect(() => {
    const el = viewport.current
    if (el && following) el.scrollTop = el.scrollHeight
    // room.messages is a new array on every post, reaction or resolve; presence changes the
    // line under the feed.
  }, [room.messages, room.presence, following, room.id])

  const onScroll = (): void => {
    const el = viewport.current
    if (!el) return
    const gap = el.scrollHeight - el.scrollTop - el.clientHeight
    const atBottom = gap <= FOLLOW_SLACK_PX
    if (atBottom !== following) setFollowing(atBottom)
  }

  return (
    <div className="eva-rooms-log">
      <div ref={viewport} className="eva-rooms-feed" data-testid="room-feed" onScroll={onScroll}>
        {summary ? (
          <div className="eva-rooms-pinned" data-testid="room-pinned">
            <div className="eva-room-summary-head">
              <IconPin size={14} stroke={1.5} aria-hidden />
              Pinned decision
              <span className="eva-rooms-pinned-by">
                by {authorOf(room.agents, summary.author).name}
              </span>
            </div>
            <Markdown text={mentionMarkdown(summary.text, room.agents)} />
          </div>
        ) : null}
        {groups.map((g) =>
          g.messages.map((m, i) =>
            members && (m.author === ISAAC || m.author === ROOM_SYSTEM) ? (
              <ChatRoomOwnRow key={m.id} msg={m} room={room} />
            ) : (
              <RoomMessageRow
                key={m.id}
                roomId={room.id}
                msg={m}
                agents={room.agents}
                continuation={i > 0}
                council={room.council}
                member={members?.find((x) => x.id === m.author)}
              />
            ),
          ),
        )}
        <RoomPresence room={room} />
      </div>
      {following ? null : (
        <button
          type="button"
          className="eva-rooms-jump"
          data-testid="room-jump"
          onClick={() => setFollowing(true)}
        >
          <IconArrowDown size={14} stroke={1.5} aria-hidden />
          Jump to latest
        </button>
      )}
    </div>
  )
}
