import { Fragment, useEffect, useMemo, useState } from 'react'
import { SegmentedControl, TextInput } from '@mantine/core'
import {
  IconChevronDown,
  IconChevronRight,
  IconGitPullRequest,
  IconGitPullRequestDraft,
} from '@tabler/icons-react'
import type { LinearRow, ReviewRow } from '@evaos/contract'
import { SlackGroups } from './SlackDetail'
import { ago, prKey, queueGroups, type QueueGroup } from './review-model'
import {
  openPr,
  openThread,
  openTicket,
  readSlack,
  setView,
  useReviews,
  useReviewsSurface,
  type ReviewsView,
} from './reviews-store'
import { Avatar } from './review-ui'
import './reviews.css'

function QueueRow({
  row,
  subtitle,
  active,
  now,
}: {
  row: ReviewRow
  subtitle: string
  active: boolean
  now: number
}) {
  const Glyph = row.draft ? IconGitPullRequestDraft : IconGitPullRequest
  return (
    <button
      type="button"
      className="eva-rv-qrow"
      data-active={active || undefined}
      data-testid={`review-row-${row.number}`}
      onClick={() => openPr(row)}
      title={`${row.repo}#${row.number} ${row.title}`}
    >
      <span className="eva-rv-qrow-title">{row.title}</span>
      <span className="eva-rv-qrow-line eva-rv-dim">
        <Glyph size={14} className="eva-rv-qrow-icon" data-draft={row.draft || undefined} />
        <span className="eva-rv-qrow-sub">{subtitle}</span>
        <Avatar login={row.author} />
        <span>{ago(row.updatedAt, now)}</span>
      </span>
    </button>
  )
}

const VIEWS: Array<{ value: ReviewsView; label: string }> = [
  { value: 'for-me', label: 'For me' },
  { value: 'created', label: 'Created' },
]

/** Sidebar body for the Reviews sub-page: the review queue, Linear and Slack groups. */
export function ReviewsList() {
  useReviewsSurface()
  const queue = useReviews((s) => s.queue)
  const view = useReviews((s) => s.view)
  const selectedPr = useReviews((s) => s.selected)
  const ticket = useReviews((s) => s.ticket)
  const thread = useReviews((s) => s.thread)
  const linear = useReviews((s) => s.linear)
  const slack = useReviews((s) => s.slack)
  const queueDone = useReviews((s) => s.queue?.done)
  const doneLocal = useReviews((s) => s.doneLocal)
  const done = useMemo(() => ({ ...queueDone, ...doneLocal }), [queueDone, doneLocal])
  const [now, setNow] = useState(Date.now())
  const [closed, setClosed] = useState<Record<string, boolean>>({ completed: true })

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000)
    return () => clearInterval(t)
  }, [])

  const selected = ticket ? `linear:${ticket.key}` : selectedPr ? prKey(selectedPr) : null
  const groups: QueueGroup[] = queue ? queueGroups(queue, view) : []
  // Linear tickets that want Isaac, under For me, before the finished reviews.
  const tickets = linear.rows?.filter(
    (r) => !(done[r.url] !== undefined && r.updatedAt <= done[r.url]!),
  )
  const linearGroup =
    view === 'for-me' ? (
      <div className="eva-rv-group" data-testid="review-linear-group">
        <button
          type="button"
          className="eva-rv-group-head"
          onClick={() => setClosed({ ...closed, linear: !closed.linear })}
        >
          Linear <span className="eva-rv-dim">{tickets ? tickets.length : ''}</span>
          {closed.linear ? <IconChevronRight size={12} /> : <IconChevronDown size={12} />}
        </button>
        {closed.linear ? null : linear.error ? (
          <div className="eva-rv-dim eva-rv-pad">Couldn&apos;t read Linear: {linear.error}</div>
        ) : !tickets ? (
          <div className="eva-rv-dim eva-rv-pad">Loading...</div>
        ) : tickets.length === 0 ? (
          <div className="eva-rv-dim eva-rv-pad">Nothing here.</div>
        ) : (
          tickets.map((r) => (
            <button
              key={r.key}
              type="button"
              className="eva-rv-qrow"
              data-active={selected === `linear:${r.key}` || undefined}
              data-unread={r.unread || undefined}
              data-testid={`review-ticket-${r.key}`}
              onClick={() => openTicket(r)}
              title={`${r.key} ${r.title}`}
            >
              <span className="eva-rv-qrow-title">{r.title}</span>
              <span className="eva-rv-qrow-line eva-rv-dim">
                <span className="eva-rv-mono eva-rv-qrow-key">{r.key}</span>
                <span className="eva-rv-qrow-sub">
                  {r.actor} {r.reason}
                </span>
                <Avatar login={r.actor} />
                <span>{ago(r.updatedAt, now)}</span>
              </span>
            </button>
          ))
        )}
        {closed.linear ? null : (
          <TextInput
            size="xs"
            className="eva-rv-open-ticket"
            placeholder="Open a ticket: ENG-1234"
            data-testid="review-open-ticket"
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return
              const m = /\b([A-Z][A-Z0-9]*-\d+)\b/.exec(e.currentTarget.value.toUpperCase())
              if (!m) return
              const key = m[1]!
              e.currentTarget.value = ''
              openTicket(
                tickets?.find((r) => r.key === key) ?? {
                  key,
                  title: key,
                  url: `https://linear.app/issue/${key}`,
                  reason: '',
                  actor: '',
                  updatedAt: 0,
                  unread: false,
                } satisfies LinearRow,
              )
            }}
          />
        )}
      </div>
    ) : null
  const slackGroups =
    view === 'for-me' ? (
      <SlackGroups
        slack={slack}
        done={done}
        selected={thread?.url ?? null}
        onOpen={openThread}
        onRefresh={() => void readSlack()}
        now={now}
      />
    ) : null
  return (
    <div className="eva-rv-queue" data-testid="review-queue">
      <SegmentedControl
        size="xs"
        fullWidth
        value={view}
        onChange={(v) => setView(v as ReviewsView)}
        data={VIEWS}
        className="eva-rv-queue-view"
      />
      {queue === null ? <div className="eva-rv-dim eva-rv-pad">Loading...</div> : null}
      {groups.map((g) => (
        <Fragment key={g.id}>
          {g.id === 'completed' ? linearGroup : null}
          {g.id === 'completed' ? slackGroups : null}
          <div className="eva-rv-group">
            <button
              type="button"
              className="eva-rv-group-head"
              onClick={() => setClosed({ ...closed, [g.id]: !closed[g.id] })}
            >
              {g.label} <span className="eva-rv-dim">{g.count}</span>
              {closed[g.id] ? <IconChevronRight size={12} /> : <IconChevronDown size={12} />}
            </button>
            {closed[g.id] ? null : g.rows.length === 0 ? (
              <div className="eva-rv-dim eva-rv-pad">Nothing here.</div>
            ) : (
              g.rows.map((r) => (
                <QueueRow
                  key={prKey(r)}
                  row={r}
                  subtitle={g.subtitle}
                  active={selected === prKey(r)}
                  now={now}
                />
              ))
            )}
          </div>
        </Fragment>
      ))}
      {queue === null && view === 'for-me' ? linearGroup : null}
      {queue === null ? slackGroups : null}
    </div>
  )
}
