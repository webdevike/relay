import { Fragment, useEffect, useMemo, useState } from 'react'
import { SegmentedControl, TextInput } from '@mantine/core'
import {
  IconChevronDown,
  IconChevronRight,
  IconGitPullRequest,
  IconGitPullRequestDraft,
  IconSearch,
} from '@tabler/icons-react'
import type { ReviewRow, SlackRow } from '@evaos/contract'
import { SlackGroups } from './SlackDetail'
import { ago, prKey, queueGroups, type QueueGroup } from './review-model'
import {
  openReviewItem,
  readSlack,
  reviewItemOf,
  setView,
  useReviews,
  useReviewsSurface,
  type ReviewsView,
} from './reviews-store'
import {
  SOURCE_FILTERS,
  itemId,
  linearId,
  linearMatches,
  openLabel,
  prId,
  prMatches,
  queryWords,
  shortPrId,
  slackId,
  slackMatches,
  sourceOf,
  type SourceFilter,
} from './queue-search'
import { Avatar, SourceMark, useLocal } from './review-ui'
import { ReviewRowMenu, rowHandlers, type RowMenuState } from './ReviewRowMenu'
import { reviewIdOf, reviewIdOfPlace } from './review-place'
import { activePlace, useTabs } from '../tabs/tabs-store'
import { rowPills, rowStatusKey, useRowStatus, type RowStatus } from './row-status'
import './reviews.css'

function QueueRow({
  row,
  subtitle,
  active,
  now,
  onMenu,
  page = false,
  status,
}: {
  row: ReviewRow
  subtitle: string
  active: boolean
  now: number
  onMenu: (m: RowMenuState) => void
  /** The page's list: one line per row with status pills (CI, Approve ready), no group subtitle. */
  page?: boolean
  status?: RowStatus | undefined
}) {
  const Glyph = row.draft ? IconGitPullRequestDraft : IconGitPullRequest
  return (
    <button
      type="button"
      className="eva-rv-qrow"
      data-active={active || undefined}
      data-testid={`review-row-${row.number}`}
      {...rowHandlers({ kind: 'pr', row }, onMenu)}
      title={`${row.repo}#${row.number} ${row.title}`}
    >
      <span className="eva-rv-qrow-title">{row.title}</span>
      <span className="eva-rv-qrow-line eva-rv-dim">
        <SourceMark source="github" />
        <span className="eva-rv-mono eva-rv-qrow-key">{shortPrId(row)}</span>
        {page ? (
          <span className="eva-rv-qrow-pills">
            {rowPills(row, status).map((p) => (
              <span key={p.label} className="eva-rv-pill" data-tone={p.tone} data-testid={p.testId}>
                {p.label}
              </span>
            ))}
          </span>
        ) : (
          <>
            <Glyph size={14} className="eva-rv-qrow-icon" data-draft={row.draft || undefined} />
            <span className="eva-rv-qrow-sub">{subtitle}</span>
          </>
        )}
        {page ? <span>{row.author}</span> : <Avatar login={row.author} />}
        <span>{ago(row.updatedAt, now)}</span>
      </span>
    </button>
  )
}

const VIEWS: Array<{ value: ReviewsView; label: string }> = [
  { value: 'created', label: 'Created' },
  { value: 'for-me', label: 'For me' },
]

/**
 * Sidebar body for the Reviews sub-page: the review queue, Linear and Slack groups, a source
 * filter, and a search across them that offers to open a typed key or link the queue lacks.
 */
export function ReviewsList({ variant = 'sidebar' }: { variant?: 'sidebar' | 'page' }) {
  const page = variant === 'page'
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
  const [source, setSource] = useLocal<SourceFilter>('eva.reviews.source', 'all')
  const [query, setQuery] = useState('')

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000)
    return () => clearInterval(t)
  }, [])

  // The typed key or link as an item (re-read when the queues change), and the rows it matches.
  const words = queryWords(query)
  const searching = words.length > 0
  const target = useMemo(
    () => (searching ? reviewItemOf(query) : null),
    [searching, query, queue, linear, slack],
  )
  const targetId = target ? itemId(target) : null
  const shows = (s: SourceFilter) => source === 'all' || source === s

  // What is open: the place of a review tab, else the Reviews page's selection.
  const here = useTabs(activePlace)
  const activeId =
    reviewIdOfPlace(here) ??
    (ticket
      ? `linear:${ticket.key}`
      : selectedPr
        ? `pr:${selectedPr.repo}#${selectedPr.number}`
        : thread
          ? reviewIdOf({ kind: 'slack', channel: thread.channel, threadTs: thread.threadTs })
          : null)
  const prActive = (r: ReviewRow): boolean => activeId === `pr:${r.repo}#${r.number}`
  const [menu, setMenu] = useState<RowMenuState | null>(null)
  const groups: QueueGroup[] = (queue && shows('github') ? queueGroups(queue, view) : [])
    .map((g) =>
      searching
        ? { ...g, rows: g.rows.filter((r) => prId(r) === targetId || prMatches(r, words)) }
        : g,
    )
    .filter((g) => !searching || g.rows.length > 0)
  // Linear tickets that want Isaac, under For me, before the finished reviews.
  const tickets = linear.rows?.filter(
    (r) =>
      !(done[r.url] !== undefined && r.updatedAt <= done[r.url]!) &&
      (!searching || linearId(r) === targetId || linearMatches(r, words)),
  )
  const slackMatch = searching
    ? (r: SlackRow) => slackId(r) === targetId || slackMatches(r, words)
    : undefined
  const slackRows = (slack.queue?.rows ?? []).filter(
    (r) =>
      !(done[r.url] !== undefined && r.updatedAt <= done[r.url]!) && (!slackMatch || slackMatch(r)),
  )
  const forMe = view === 'for-me'
  const showLinear = forMe && shows('linear') && (!searching || (tickets?.length ?? 0) > 0)
  const showSlack = forMe && shows('slack') && (!searching || slackRows.length > 0)
  const shownIds = new Set([
    ...groups.flatMap((g) => g.rows.map(prId)),
    ...(showLinear ? (tickets ?? []).map(linearId) : []),
    ...(showSlack ? slackRows.map(slackId) : []),
  ])
  const openItem = target && !shownIds.has(itemId(target)) ? target : null

  const linearGroup = showLinear ? (
    <div className="eva-rv-group" data-testid="review-linear-group">
      <button
        type="button"
        className="eva-rv-group-head"
        onClick={() => setClosed({ ...closed, linear: !closed.linear })}
      >
        Linear <span className="eva-rv-dim">{tickets ? tickets.length : ''}</span>
        {closed.linear ? <IconChevronRight size={12} /> : <IconChevronDown size={12} />}
      </button>
      {closed.linear && !searching ? null : linear.error ? (
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
            data-active={activeId === `linear:${r.key}` || undefined}
            data-unread={r.unread || undefined}
            data-testid={`review-ticket-${r.key}`}
            {...rowHandlers({ kind: 'linear', row: r }, setMenu)}
            title={`${r.key} ${r.title}`}
          >
            <span className="eva-rv-qrow-title">{r.title}</span>
            <span className="eva-rv-qrow-line eva-rv-dim">
              <SourceMark source="linear" />
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
    </div>
  ) : null
  const slackGroups = showSlack ? (
    <SlackGroups
      slack={slack}
      done={done}
      isActive={(r) =>
        activeId === reviewIdOf({ kind: 'slack', channel: r.channel, threadTs: r.threadTs })
      }
      rowProps={(r) => rowHandlers({ kind: 'slack', row: r }, setMenu)}
      onRefresh={() => void readSlack()}
      now={now}
      match={slackMatch}
    />
  ) : null
  // Enter opens a typed key or link (queued or not); the Open row offers one the queue lacks.
  const open = (): void => {
    if (target && openReviewItem(query)) setQuery('')
  }
  const empty =
    groups.length === 0 && !showLinear && !showSlack && !openItem && (searching || !forMe)
  // The page's empty state is only for a queue that is truly empty, not one still loading.
  const loaded = !!queue && (!showLinear || !!tickets) && (!slack.reading || !forMe)
  const pageEmpty =
    page &&
    !searching &&
    loaded &&
    groups.every((g) => g.rows.length === 0) &&
    (tickets?.length ?? 0) === 0 &&
    slackRows.length === 0
  // Rows of the live groups get CI and Approve-ready; finished ones do not.
  const status = useRowStatus(
    page ? groups.filter((g) => g.id !== 'completed').flatMap((g) => g.rows) : [],
  )
  return (
    <div
      className="eva-rv-queue"
      data-variant={variant}
      data-testid={page ? 'reviews-home' : 'review-queue'}
    >
      <TextInput
        size="xs"
        className="eva-rv-queue-search"
        placeholder="Search or open: ENG-1234, repo#12, link"
        aria-label="Search reviews"
        data-testid="review-search"
        leftSection={<IconSearch size={14} />}
        value={query}
        onChange={(e) => setQuery(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation()
            setQuery('')
          } else if (e.key === 'Enter') open()
        }}
      />
      <SegmentedControl
        size="xs"
        fullWidth
        value={view}
        onChange={(v) => setView(v as ReviewsView)}
        data={VIEWS}
        className="eva-rv-queue-view"
      />
      <SegmentedControl
        size="xs"
        fullWidth
        value={source}
        onChange={(v) => setSource(v as SourceFilter)}
        data={SOURCE_FILTERS}
        className="eva-rv-queue-view"
        data-testid="review-source-filter"
      />
      {openItem ? (
        <button
          type="button"
          className="eva-rv-qrow"
          data-testid="review-search-open"
          onClick={open}
          title={query.trim()}
        >
          <span className="eva-rv-qrow-line">
            <SourceMark source={sourceOf(openItem)} />
            <span className="eva-rv-qrow-title">{openLabel(openItem)}</span>
          </span>
        </button>
      ) : null}
      {queue === null && shows('github') && !searching ? (
        <div className="eva-rv-dim eva-rv-pad">Loading...</div>
      ) : null}
      {empty ? (
        <div className="eva-rv-dim eva-rv-pad" data-testid="review-search-empty">
          {searching
            ? 'No matches.'
            : page
              ? 'Nothing in this view.'
              : 'Linear and Slack are under For me.'}
        </div>
      ) : null}
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
              {g.label} <span className="eva-rv-dim">{searching ? g.rows.length : g.count}</span>
              {closed[g.id] ? <IconChevronRight size={12} /> : <IconChevronDown size={12} />}
            </button>
            {closed[g.id] && !searching ? null : g.rows.length === 0 ? (
              <div className="eva-rv-dim eva-rv-pad">Nothing here.</div>
            ) : (
              g.rows.map((r) => (
                <QueueRow
                  key={prKey(r)}
                  row={r}
                  subtitle={g.subtitle}
                  active={prActive(r)}
                  now={now}
                  onMenu={setMenu}
                  page={page}
                  status={page ? status[rowStatusKey(r)] : undefined}
                />
              ))
            )}
          </div>
        </Fragment>
      ))}
      {pageEmpty ? (
        <div className="eva-rv-dim eva-rv-pad" data-testid="reviews-home-empty">
          Your review queue is empty.
        </div>
      ) : null}
      {groups.some((g) => g.id === 'completed') ? null : (
        <>
          {linearGroup}
          {slackGroups}
        </>
      )}
      <ReviewRowMenu menu={menu} onClose={() => setMenu(null)} />
    </div>
  )
}
