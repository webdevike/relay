import './background-row.css'
import { useId, useState, type ReactNode } from 'react'
import {
  IconActivityHeartbeat,
  IconBriefcase,
  IconChevronDown,
  IconFolder,
  IconHandClick,
  IconLayoutBoard,
  IconMail,
  IconMessageCircle,
  IconMoodSmile,
  IconPoint,
  IconPointer,
  IconRobot,
  type Icon,
} from '@tabler/icons-react'
import { openLink } from '../navigation/open-link'
import { openTargetOf } from '../navigation/open-target'
import { ago } from '../reviews/review-model'
import {
  type BackgroundIcon,
  type BackgroundMessage,
  type HeartbeatItem,
} from '@evaos/chat-core/background'
import { Markdown } from './markdown/Markdown'

const ICONS: Record<BackgroundIcon, Icon> = {
  robot: IconRobot,
  board: IconLayoutBoard,
  hand: IconHandClick,
  chat: IconMessageCircle,
  reaction: IconMoodSmile,
  pointer: IconPointer,
}

const SOURCE_ICONS: Record<string, Icon> = {
  gmail: IconMail,
  work: IconBriefcase,
  project: IconFolder,
}

const sourceIcon = (source: string): Icon => SOURCE_ICONS[source.toLowerCase()] ?? IconPoint
const sourceLabel = (source: string): string => source.charAt(0).toUpperCase() + source.slice(1)

function Chevron({ open }: { open: boolean }) {
  return (
    <IconChevronDown
      size={14}
      stroke={1.5}
      className="eva-bg-chevron"
      data-open={open}
      aria-hidden
    />
  )
}

/**
 * A comment Isaac left on a page or board, as a slim inline line like a system line (no card):
 * icon, "You commented on <element> · <where>", what he said, a tiny thumbnail and Show, which
 * opens the whole note (the page address and what was read of the element) in place.
 */
function CommentRow({
  m,
  comment,
  thumbs,
}: {
  m: Extract<BackgroundMessage, { kind: 'event' }>
  comment: { place: string; note: string }
  thumbs: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const bodyId = useId()
  const Glyph = ICONS[m.icon]
  return (
    <div className="eva-bg-comment" data-testid="background-event" data-open={open}>
      <div className="eva-bg-comment-line">
        <Glyph size={14} stroke={1.75} className="eva-bg-icon" aria-hidden />
        <span className="eva-bg-comment-what">
          You commented on{' '}
          <b data-testid="background-chip" title={m.chip ?? comment.place}>
            {m.chip ?? comment.place}
          </b>
          {m.chip ? ` · ${comment.place}` : ''}
        </span>
        <span className="eva-bg-comment-note" data-testid="background-note">
          {comment.note}
        </span>
        {thumbs}
        <button
          type="button"
          className="eva-bg-show"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen(!open)}
        >
          {open ? 'Hide' : 'Show'}
        </button>
      </div>
      {open ? (
        <div id={bodyId} className="eva-bg-body" data-testid="background-body">
          <Markdown text={m.text} />
        </div>
      ) : null}
    </div>
  )
}

/** A: one quiet line (icon, source and first sentence, time) that opens its full text in place. */
function EventRow({
  m,
  at,
}: {
  m: Extract<BackgroundMessage, { kind: 'event' }>
  at: number | undefined
}) {
  const [open, setOpen] = useState(false)
  const bodyId = useId()
  const Glyph = ICONS[m.icon]
  return (
    <div className="eva-bg-event" data-testid="background-event" data-open={open}>
      <button
        type="button"
        className="eva-bg-head"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen(!open)}
      >
        <Glyph size={14} stroke={1.75} className="eva-bg-icon" aria-hidden />
        <span className="eva-bg-summary">{m.summary}</span>
        {m.chip ? (
          <span className="eva-bg-chip" data-testid="background-chip" title={m.chip}>
            {m.chip}
          </span>
        ) : null}
        {at === undefined ? null : <span className="eva-bg-time">{ago(at, Date.now())}</span>}
        <Chevron open={open} />
      </button>
      {open ? (
        <div id={bodyId} className="eva-bg-body" data-testid="background-body">
          <Markdown text={m.text} />
        </div>
      ) : null}
    </div>
  )
}

function ItemLine({ item }: { item: HeartbeatItem }) {
  const Glyph = sourceIcon(item.source)
  return (
    <div className="eva-bg-item" data-testid="background-item">
      <Glyph size={13} stroke={1.75} className="eva-bg-icon" aria-hidden />
      <span className="eva-bg-item-title">{item.title}</span>
      {item.link ? (
        <a
          className="eva-bg-item-link"
          href={item.link}
          title={item.link}
          onClick={(e) => {
            e.preventDefault()
            openLink(item.link!, { target: openTargetOf(e) })
          }}
        >
          Open
        </a>
      ) : item.meta ? (
        <span className="eva-bg-item-meta">{item.meta}</span>
      ) : null}
    </div>
  )
}

/** C: a bordered chip row of per-source counts; opens a divided list of the items. */
function HeartbeatRow({
  m,
  at,
}: {
  m: Extract<BackgroundMessage, { kind: 'heartbeat' }>
  at: number | undefined
}) {
  const [open, setOpen] = useState(false)
  const listId = useId()
  return (
    <div className="eva-bg-beat" data-testid="background-heartbeat" data-open={open}>
      <button
        type="button"
        className="eva-bg-head"
        aria-expanded={open}
        aria-controls={listId}
        aria-label={`Heartbeat from ${m.from}, ${m.count} new`}
        onClick={() => setOpen(!open)}
      >
        <IconActivityHeartbeat size={14} stroke={1.75} className="eva-bg-icon" aria-hidden />
        <span className="eva-bg-pills">
          {m.sources.length === 0 ? (
            <span className="eva-bg-pill">Heartbeat {m.count}</span>
          ) : (
            m.sources.map((s) => (
              <span key={s.source} className="eva-bg-pill" data-testid="background-pill">
                {sourceLabel(s.source)} {s.count}
              </span>
            ))
          )}
        </span>
        {at === undefined ? null : <span className="eva-bg-time">{ago(at, Date.now())}</span>}
        <Chevron open={open} />
      </button>
      {open ? (
        <div id={listId} className="eva-bg-list" data-testid="background-list">
          {m.items.length === 0 ? (
            <div className="eva-bg-item">
              <span className="eva-bg-item-title">{m.text}</span>
            </div>
          ) : (
            m.items.map((item, i) => <ItemLine key={i} item={item} />)
          )}
        </div>
      ) : null}
    </div>
  )
}

/**
 * A background message in the thread: a one-line row (A), a heartbeat's chip row (C), or Isaac's
 * comment on a page or board as a slim inline line (`thumbs`: its screenshots, small).
 */
export function BackgroundRow({
  m,
  at,
  thumbs,
}: {
  m: BackgroundMessage
  at: number | undefined
  thumbs?: ReactNode
}) {
  if (m.kind === 'heartbeat') return <HeartbeatRow m={m} at={at} />
  if (m.comment) return <CommentRow m={m} comment={m.comment} thumbs={thumbs} />
  return <EventRow m={m} at={at} />
}
