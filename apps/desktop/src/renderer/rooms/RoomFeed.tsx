import { IconArrowDown, IconBrain, IconFileSearch, IconPin } from '@tabler/icons-react'
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ROOM_SYSTEM, isDecisionCard } from '@evaos/contract'
import { Markdown } from '../chat/markdown/Markdown'
import '../chat/chat.css'
import '../chat/composer/composer.css'
import { getPref, setPref, type Parse } from '../ui-prefs'
import { TypingDots } from '../ui/TypingDots'
import { catchUp, sinceIndex } from './decision-view'
import { RoomDecisionCard, SeatAskView } from './DecisionCards'
import { MemberFace } from './MemberStack'
import { MentionText } from './MentionText'
import { mentionMarkdown } from './mentions'
import { presenceGroups } from './presence'
import { RoomMessageRow, authorOf } from './RoomMessageRow'
import { CatchUpPill, SinceBlock } from './RoomKeepUp'
import { ISAAC_PERSON } from './roster'
import { groupMessages } from './rooms-store'
import { ISAAC, type Room, type RoomMessage } from './types'

/** Within this many px of the bottom counts as following. */
const FOLLOW_SLACK_PX = 24

/** The last message Isaac saw in each chat room, by room id: where "Since you left" goes. */
const SEEN_PREF = 'rooms.seen'
const parseSeen: Parse<Record<string, string>> = (v) =>
  v !== null && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(
        Object.entries(v).filter((e): e is [string, string] => typeof e[1] === 'string'),
      )
    : null

/** Isaac's text with its @mentions as the composer's chips. */
function RoomMentionText({ text, room }: { text: string; room: Room }) {
  return (
    <MentionText
      text={text}
      people={[...room.agents, { id: ISAAC_PERSON.id, name: ISAAC_PERSON.name }]}
    />
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
          <RoomMentionText text={msg.text} room={room} />
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
  const chat = room.chat !== undefined
  // Since you left: where the last visit stopped, read once when the room opens.
  const [since, setSince] = useState(() =>
    chat ? sinceIndex(room.messages, getPref(SEEN_PREF, {}, parseSeen)[room.id]) : null,
  )
  const [following, setFollowing] = useState(since === null)
  /** The index of the last message seen at the bottom of the feed during this visit. */
  const [seen, setSeen] = useState(room.messages.length - 1)
  const groups = useMemo(() => groupMessages(room.messages), [room.messages])
  const summary = room.phase === 'resolved' ? room.messages.find((m) => m.kind === 'summary') : null
  const members = room.chat?.setup.members
  const sinceId = since === null ? null : (room.messages[since]?.id ?? null)
  const fresh = chat && !following ? catchUp(room, seen + 1).fresh : 0

  useLayoutEffect(() => {
    const el = viewport.current
    if (el && following) el.scrollTop = el.scrollHeight
    // room.messages is a new array on every post, reaction or resolve; presence changes the
    // line under the feed.
  }, [room.messages, room.presence, following, room.id])

  // Back in a room where members talked: open at the "Since you left" block.
  useLayoutEffect(() => {
    if (since !== null)
      viewport.current
        ?.querySelector('[data-testid="room-since"]')
        ?.scrollIntoView({ block: 'start' })
    // Only when the room opens.
  }, [])

  useEffect(() => {
    if (following) setSeen(room.messages.length - 1)
  }, [following, room.messages])

  useEffect(() => {
    const id = room.messages[seen]?.id
    if (chat && id) setPref(SEEN_PREF, { ...getPref(SEEN_PREF, {}, parseSeen), [room.id]: id })
    // The id at `seen` only changes with `seen`: messages are appended.
  }, [seen, room.id, chat])

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
          g.messages.map((m, i) => (
            <Fragment key={m.id}>
              {m.id === sinceId ? (
                <SinceBlock room={room} from={since!} onDismiss={() => setSince(null)} />
              ) : null}
              {members && m.card?.type === 'ask' ? (
                <div className="eva-rooms-ask" data-testid={`room-msg-${m.id}`}>
                  <SeatAskView card={m.card} room={room} />
                </div>
              ) : members && (m.author === ISAAC || m.author === ROOM_SYSTEM) ? (
                <ChatRoomOwnRow msg={m} room={room} />
              ) : (
                <RoomMessageRow
                  roomId={room.id}
                  msg={m}
                  agents={room.agents}
                  continuation={i > 0}
                  council={room.council}
                  member={members?.find((x) => x.id === m.author)}
                  cardSlot={
                    isDecisionCard(m.card) ? (
                      <RoomDecisionCard card={m.card} room={room} />
                    ) : undefined
                  }
                />
              )}
            </Fragment>
          )),
        )}
        <RoomPresence room={room} />
      </div>
      {fresh > 0 ? (
        <CatchUpPill room={room} from={seen + 1} onLatest={() => setFollowing(true)} />
      ) : following ? null : (
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
