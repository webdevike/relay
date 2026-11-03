import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { ActionIcon, Loader, SegmentedControl, TextInput, Tooltip } from '@mantine/core'
import {
  IconGitPullRequest,
  IconGitPullRequestDraft,
  IconRefresh,
  IconSearch,
} from '@tabler/icons-react'
import type { ReviewRow, SlackRow } from '@evaos/contract'
import { emojify } from '@relay/slack-emoji'
import { ListEmpty, ListRow, ListTime, ListView, rowTip, type ListGroup } from '../ui/list'
import { ago, agoPhrase, prKey, queueGroups } from './review-model'
import {
  openReviewItem,
  readSlack,
  reviewItemOf,
  setView,
  useReviews,
  useReviewsSurface,
  type ReviewItem,
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
  sidebarTitle,
  slackId,
  slackMatches,
  sourceOf,
  type SourceFilter,
} from './queue-search'
import { SourceMark, useLocal } from './review-ui'
import { ReviewRowMenu, activateReviewRow, type RowMenuState } from './ReviewRowMenu'
import { reviewIdOf, reviewIdOfPlace } from './review-place'
import { activePlace, useTabs } from '../tabs/tabs-store'
import { rowPills, rowStatusKey, useRowStatus } from './row-status'
import { RowMarks } from './RowMarks'
import './reviews.css'

const VIEWS: Array<{ value: ReviewsView; label: string }> = [
  { value: 'created', label: 'Created' },
  { value: 'for-me', label: 'For me' },
]

/** A queue row: a PR, a Linear ticket or a Slack thread, or the Open row for a typed key. */
type QueueItem = ReviewItem | { kind: 'open'; item: ReviewItem }

const isDone = (r: { url: string; updatedAt: number }, done: Record<string, number>): boolean =>
  done[r.url] !== undefined && r.updatedAt <= done[r.url]!

/**
 * The review queue, Linear and Slack groups, a source filter, and a search across them that
 * offers to open a typed key or link the queue lacks. The sidebar shows it compact (one line a
 * row); the Reviews page, with nothing selected, as two-line rows with live status pills.
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
  const [closed, setClosed] = useState<ReadonlySet<string>>(() => new Set(['completed']))
  const [source, setSource] = useLocal<SourceFilter>('eva.reviews.source', 'all')
  const [query, setQuery] = useState('')
  const [menu, setMenu] = useState<RowMenuState | null>(null)

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
  const queueRows = (queue && shows('github') ? queueGroups(queue, view) : [])
    .map((g) =>
      searching
        ? { ...g, rows: g.rows.filter((r) => prId(r) === targetId || prMatches(r, words)) }
        : g,
    )
    .filter((g) => !searching || g.rows.length > 0)
  // Linear tickets that want Isaac, under For me, before the finished reviews.
  const tickets = linear.rows?.filter(
    (r) => !isDone(r, done) && (!searching || linearId(r) === targetId || linearMatches(r, words)),
  )
  const slackRows = (slack.queue?.rows ?? []).filter(
    (r) => !isDone(r, done) && (!searching || slackId(r) === targetId || slackMatches(r, words)),
  )
  const forMe = view === 'for-me'
  const showLinear = forMe && shows('linear') && (!searching || (tickets?.length ?? 0) > 0)
  const showSlack = forMe && shows('slack') && (!searching || slackRows.length > 0)
  const shownIds = new Set([
    ...queueRows.flatMap((g) => g.rows.map(prId)),
    ...(showLinear ? (tickets ?? []).map(linearId) : []),
    ...(showSlack ? slackRows.map(slackId) : []),
  ])
  const openItem = target && !shownIds.has(itemId(target)) ? target : null
  // Rows of the live groups get CI and Approve-ready; finished ones do not.
  const status = useRowStatus(
    page ? queueRows.filter((g) => g.id !== 'completed').flatMap((g) => g.rows) : [],
  )

  const linearGroup: ListGroup<QueueItem> | null = showLinear
    ? {
        id: 'linear',
        label: 'Linear',
        testid: 'review-linear-group',
        count: tickets ? tickets.length : null,
        items: (tickets ?? []).map((row) => ({ kind: 'linear', row })),
        empty: linear.error
          ? `Couldn't read Linear: ${linear.error}`
          : !tickets
            ? 'Loading...'
            : 'Nothing here.',
      }
    : null
  // Mentions (DMs count: they are to him) and Replies, like the Slack design's Threads queue.
  const slackGroups: ListGroup<QueueItem>[] = showSlack
    ? [
        {
          id: 'slack-mentions',
          label: 'Slack mentions',
          testid: 'review-slack-mentions',
          rows: slackRows.filter((r) => r.kind !== 'reply'),
        },
        {
          id: 'slack-replies',
          label: 'Slack replies',
          testid: 'review-slack-replies',
          rows: slackRows.filter((r) => r.kind === 'reply'),
        },
      ]
        .filter((g) => !searching || g.rows.length > 0)
        .map(({ rows, ...g }, i) => ({
          ...g,
          count: slack.queue ? rows.length : null,
          items: rows.map((row) => ({ kind: 'slack', row })),
          // The queue is read once for both groups: its state shows on the first.
          empty:
            slack.queue === null
              ? i === 0
                ? slack.error
                  ? `Couldn't read Slack: ${slack.error}`
                  : 'Reading Slack...'
                : undefined
              : 'Nothing here.',
          intro:
            i === 0 && slack.queue && slack.error ? `Last read failed: ${slack.error}` : undefined,
          actions:
            i === 0 ? (
              slack.reading ? (
                <span
                  className="eva-rv-reading eva-rv-dim eva-rv-small"
                  data-testid="review-slack-reading"
                >
                  <Loader size={10} /> reading
                </span>
              ) : (
                <Tooltip
                  label={
                    slack.queue ? `Read ${agoPhrase(slack.queue.fetchedAt, now)}` : 'Read Slack'
                  }
                  openDelay={300}
                >
                  <ActionIcon
                    variant="subtle"
                    color="gray"
                    size="sm"
                    aria-label="Read Slack again"
                    onClick={() => void readSlack()}
                  >
                    <IconRefresh size={14} stroke={1.5} />
                  </ActionIcon>
                </Tooltip>
              )
            ) : undefined,
        }))
    : []

  // Enter opens a typed key or link (queued or not); the Open row offers one the queue lacks.
  const open = (): void => {
    if (target && openReviewItem(query)) setQuery('')
  }
  const empty =
    queueRows.length === 0 && !showLinear && !showSlack && !openItem && (searching || !forMe)
  // The page's empty state is only for a queue that is truly empty, not one still loading.
  const loaded = !!queue && (!showLinear || !!tickets) && (!slack.reading || !forMe)
  const pageEmpty =
    page &&
    !searching &&
    loaded &&
    queueRows.every((g) => g.rows.length === 0) &&
    (tickets?.length ?? 0) === 0 &&
    slackRows.length === 0
  const githubLoading = queue === null && shows('github') && !searching

  const groups: ListGroup<QueueItem>[] = []
  if (!pageEmpty) {
    if (openItem) groups.push({ id: 'open', items: [{ kind: 'open', item: openItem }] })
    for (const g of queueRows) {
      if (g.id === 'completed') {
        if (linearGroup) groups.push(linearGroup)
        groups.push(...slackGroups)
      }
      groups.push({
        id: g.id,
        label: g.label,
        count: searching ? g.rows.length : g.count,
        items: g.rows.map((row) => ({ kind: 'pr', row })),
        empty: 'Nothing here.',
      })
    }
    if (!queueRows.some((g) => g.id === 'completed')) {
      if (linearGroup) groups.push(linearGroup)
      groups.push(...slackGroups)
    }
    // GitHub is still being read while Linear and Slack already show.
    if (githubLoading && groups.length > 0) {
      groups.unshift({ id: 'github-loading', items: [], empty: 'Loading...' })
    }
  }
  const subtitle = new Map<string, string>(queueRows.map((g) => [g.id, g.subtitle]))

  const row = (item: QueueItem, group: ListGroup<QueueItem>): ReactNode => {
    if (item.kind === 'open') {
      return (
        <ListRow
          key="open"
          data-testid="review-search-open"
          tooltip={query.trim()}
          leading={<SourceMark source={sourceOf(item.item)} />}
          title={openLabel(item.item)}
          onActivate={open}
        />
      )
    }
    const handlers = {
      onActivate: (e: Parameters<typeof activateReviewRow>[1]) => activateReviewRow(item, e),
      middleClick: true,
      onMenu: (x: number, y: number) => setMenu({ item, x, y }),
    }
    if (item.kind === 'pr') {
      const r: ReviewRow = item.row
      const Glyph = r.draft ? IconGitPullRequestDraft : IconGitPullRequest
      return (
        <ListRow
          key={prKey(r)}
          data-testid={`review-row-${r.number}`}
          tooltip={rowTip(
            r.title,
            [shortPrId(r), page ? r.author : subtitle.get(group.id)].filter(Boolean).join(' · '),
          )}
          active={activeId === `pr:${r.repo}#${r.number}`}
          leading={
            <Glyph
              size={16}
              stroke={1.5}
              className="eva-rv-prglyph"
              data-draft={r.draft || undefined}
              aria-label={r.draft ? 'Draft pull request' : 'Pull request'}
            />
          }
          title={page ? r.title : sidebarTitle(r.title)}
          trailing={
            <>
              {page ? <RowMarks pills={rowPills(r, status[rowStatusKey(r)])} /> : null}
              <ListTime>{ago(r.updatedAt, now)}</ListTime>
            </>
          }
          {...handlers}
        />
      )
    }
    if (item.kind === 'linear') {
      const r = item.row
      return (
        <ListRow
          key={r.key}
          data-testid={`review-ticket-${r.key}`}
          data-unread={r.unread || undefined}
          tooltip={rowTip(`${r.key} ${r.title}`, `${r.actor} ${r.reason}`)}
          active={activeId === `linear:${r.key}`}
          leading={<SourceMark source="linear" />}
          title={r.title.includes(r.key) ? r.title : `${r.key} ${r.title}`}
          trailing={<ListTime>{ago(r.updatedAt, now)}</ListTime>}
          {...handlers}
        />
      )
    }
    const r: SlackRow = item.row
    const text = emojify(r.text)
    return (
      <ListRow
        key={r.url}
        data-testid="review-slack-row"
        data-thread={r.threadTs ? true : undefined}
        tooltip={rowTip(`${r.channelName}: ${text}`, r.author)}
        active={
          activeId === reviewIdOf({ kind: 'slack', channel: r.channel, threadTs: r.threadTs })
        }
        leading={<SourceMark source="slack" />}
        title={
          <>
            {`${r.channelName}${r.threadTs && r.kind === 'reply' ? ' thread' : ''}`}
            <span className="eva-list-sub">{text}</span>
          </>
        }
        trailing={<ListTime>{ago(r.updatedAt, now)}</ListTime>}
        {...handlers}
      />
    )
  }

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
      <ListView<QueueItem>
        density={page ? 'comfortable' : 'compact'}
        groups={groups}
        rowKey={(x) =>
          x.kind === 'open'
            ? 'open'
            : x.kind === 'pr'
              ? prKey(x.row)
              : x.kind === 'linear'
                ? x.row.key
                : x.row.url
        }
        renderRow={row}
        collapsed={closed}
        onCollapsedChange={(id, c) => {
          const next = new Set(closed)
          if (c) next.add(id)
          else next.delete(id)
          setClosed(next)
        }}
        forceOpen={searching}
        loading={githubLoading && groups.length === 0 ? { label: 'Loading reviews' } : false}
        empty={
          empty ? (
            <ListEmpty data-testid="review-search-empty">
              {searching
                ? 'No matches.'
                : page
                  ? 'Nothing in this view.'
                  : 'Linear and Slack are under For me.'}
            </ListEmpty>
          ) : pageEmpty ? (
            <ListEmpty data-testid="reviews-home-empty" title="Your review queue is empty">
              Pull requests, tickets and Slack threads you are asked to look at land here.
            </ListEmpty>
          ) : undefined
        }
      />
      <ReviewRowMenu menu={menu} onClose={() => setMenu(null)} />
    </div>
  )
}
