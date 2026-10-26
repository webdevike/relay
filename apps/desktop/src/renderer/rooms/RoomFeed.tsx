import { IconArrowDown, IconPin } from '@tabler/icons-react'
import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Markdown } from '../chat/markdown/Markdown'
import { RoomMessageRow, authorOf } from './RoomMessageRow'
import { groupMessages } from './rooms-store'
import type { Room } from './types'

/** Within this many px of the bottom counts as following. */
const FOLLOW_SLACK_PX = 24

/** "Skeptic is typing", "Skeptic and PM are typing", "Skeptic, PM and Ops are typing". */
export function typingLabel(room: Room): string | null {
  const names = room.typing.map((id) => authorOf(room.agents, id).name)
  if (names.length === 0) return null
  if (names.length === 1) return `${names[0]} is typing`
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]} are typing`
}

export function RoomFeed({ room }: { room: Room }) {
  const viewport = useRef<HTMLDivElement>(null)
  const [following, setFollowing] = useState(true)
  const groups = useMemo(() => groupMessages(room.messages), [room.messages])
  const summary =
    room.status === 'resolved' ? room.messages.find((m) => m.kind === 'summary') : null
  const tail = `${room.messages.length}:${room.typing.length}`

  useLayoutEffect(() => {
    const el = viewport.current
    if (el && following) el.scrollTop = el.scrollHeight
  }, [tail, following, room.id])

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
            <Markdown text={summary.text} />
          </div>
        ) : null}
        {groups.map((g) =>
          g.messages.map((m, i) => (
            <RoomMessageRow
              key={m.id}
              roomId={room.id}
              msg={m}
              agents={room.agents}
              continuation={i > 0}
            />
          )),
        )}
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
