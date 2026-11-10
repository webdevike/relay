import { IconArrowDown, IconPin } from '@tabler/icons-react'
import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Markdown } from '../chat/markdown/Markdown'
import { mentionMarkdown } from './mentions'
import { RoomMessageRow, authorOf } from './RoomMessageRow'
import { groupMessages } from './rooms-store'
import type { Room } from './types'

/** Within this many px of the bottom counts as following. */
const FOLLOW_SLACK_PX = 24

export function RoomFeed({ room }: { room: Room }) {
  const viewport = useRef<HTMLDivElement>(null)
  const [following, setFollowing] = useState(true)
  const groups = useMemo(() => groupMessages(room.messages), [room.messages])
  const summary = room.phase === 'resolved' ? room.messages.find((m) => m.kind === 'summary') : null

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
          g.messages.map((m, i) => (
            <RoomMessageRow
              key={m.id}
              roomId={room.id}
              msg={m}
              agents={room.agents}
              continuation={i > 0}
              council={room.council}
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
