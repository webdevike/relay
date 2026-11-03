import { useCallback, useEffect, useMemo, useState } from 'react'
import { notifications } from '@mantine/notifications'
import type { LinearTicket, ReviewPr, ReviewRow, SlackRow } from '@evaos/contract'
import { placeOf, type Place } from '@evaos/shell-core'
import { setReviewTitle } from '../eva/names-store'
import { invoke } from '../ipc'
import { useReplacePlace } from '../pages/place-host'
import { LinearDetail } from './LinearDetail'
import { SlackDetail } from './SlackDetail'
import { Detail, markDone } from './ReviewsPage'
import { reviewIdOf, reviewRefOfPlace, reviewTitleOf, type ReviewRef } from './review-place'
import {
  loadQueue,
  reviewItemOf,
  reviewsStore,
  useReviews,
  useReviewsSurface,
  type ReviewItem,
  type ReviewsState,
} from './reviews-store'
import './reviews.css'

/**
 * The item for `ref`: the queue's own row when it lists it, else (pull request, ticket) one made
 * from the reference, whose detail loads the rest. A Slack thread the queue does not list is null:
 * its link needs the row.
 */
export function resolveReviewRef(ref: ReviewRef, s: ReviewsState): ReviewItem | null {
  if (ref.kind === 'pr') return reviewItemOf(`https://github.com/${ref.repo}/pull/${ref.number}`, s)
  if (ref.kind === 'linear') return reviewItemOf(ref.key, s)
  const row = s.slack.queue?.rows.find(
    (r) => r.channel === ref.channel && r.threadTs === ref.threadTs,
  )
  return row ? { kind: 'slack', row } : null
}

/**
 * One review item as a place of its own (`review:pr:owner/repo#12`): the same detail the Reviews
 * page shows for its selection, in its own tab or pane, so several can be open at once. Back and
 * Done leave it for the Reviews page.
 */
export function ReviewPage({ place }: { place: Place }) {
  useReviewsSurface()
  const queue = useReviews((s) => s.queue)
  const linear = useReviews((s) => s.linear)
  const slack = useReviews((s) => s.slack)
  const page = place.page
  // The reference follows the place's key; the item is rebuilt when a queue changes, not on every
  // store write (a selector returning a fresh object would re-render forever).
  const ref = useMemo(() => reviewRefOfPlace({ ...place, page }), [place, page])
  const item = useMemo(
    () => (ref ? resolveReviewRef(ref, reviewsStore.getState()) : null),
    [ref, queue, linear, slack],
  )
  const queueLoaded = queue !== null
  const slackLoaded = slack.queue !== null
  const leave = useReplacePlace()
  const [now, setNow] = useState(Date.now())
  const [pr, setPr] = useState<{ pr: ReviewPr; at: number } | null>(null)
  const [prError, setPrError] = useState<string | null>(null)

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000)
    return () => clearInterval(t)
  }, [])

  // The tab is named by what the queue (or the loaded pull request) calls the item.
  const id = ref ? reviewIdOf(ref) : null
  const title = item ? reviewTitleOf(item) : null
  useEffect(() => {
    if (id && title) setReviewTitle(id, title)
  }, [id, title])
  useEffect(() => {
    if (id && pr) setReviewTitle(id, `#${pr.pr.number} ${pr.pr.title}`)
  }, [id, pr])

  const prRef = ref?.kind === 'pr' ? ref : null
  const loadPr = useCallback(async (r: { repo: string; number: number }) => {
    setPrError(null)
    const res = await invoke('reviews.pr', { repo: r.repo, number: r.number })
    if (res.ok) setPr({ pr: res.value, at: Date.now() })
    else setPrError(res.error.message)
  }, [])
  const prRepo = prRef?.repo
  const prNumber = prRef?.number
  useEffect(() => {
    if (prRepo !== undefined && prNumber !== undefined)
      void loadPr({ repo: prRepo, number: prNumber })
  }, [prRepo, prNumber, loadPr])

  const back = (): void => leave(placeOf('reviews'))

  const donePr = async (row: ReviewRow, p: ReviewPr): Promise<void> => {
    if (!(await markDone(p.url, Math.max(row.updatedAt, p.updatedAt)))) return
    notifications.show({ message: `Done: ${p.title}`, color: 'green' })
    back()
  }
  const doneTicket = async (row: { updatedAt: number }, t: LinearTicket): Promise<void> => {
    if (!(await markDone(t.url, Math.max(row.updatedAt, Date.now())))) return
    notifications.show({ message: `Done: ${t.key} ${t.title}`, color: 'green' })
    back()
  }
  const doneThread = async (row: SlackRow): Promise<void> => {
    if (!(await markDone(row.url, row.updatedAt))) return
    notifications.show({ message: `Done: ${row.channelName}`, color: 'green' })
    back()
  }

  let body
  if (ref === null) {
    body = (
      <div className="eva-rv-placeholder eva-rv-dim" data-testid="review-place-unknown">
        This review is not one the app can open.
      </div>
    )
  } else if (item?.kind === 'slack') {
    body = (
      <SlackDetail
        key={item.row.url}
        row={item.row}
        now={now}
        onBack={back}
        onDone={() => void doneThread(item.row)}
      />
    )
  } else if (item?.kind === 'linear') {
    const row = item.row
    body = (
      <LinearDetail
        key={row.key}
        row={row}
        now={now}
        onBack={back}
        onDone={(t) => void doneTicket(row, t)}
      />
    )
  } else if (item?.kind === 'pr' && pr) {
    const row = item.row
    body = (
      <Detail
        pr={pr.pr}
        fetchedAt={pr.at}
        now={now}
        onBack={back}
        onRefresh={() => {
          void loadPr(row)
          void loadQueue(true)
        }}
        onDone={() => void donePr(row, pr.pr)}
      />
    )
  } else {
    body = (
      <div className="eva-rv-placeholder eva-rv-dim" data-testid="review-place-loading">
        {prError
          ? `Couldn't load the pull request: ${prError}`
          : ref.kind === 'slack' && slackLoaded && item === null
            ? 'This Slack thread is no longer in your queue.'
            : ref.kind === 'slack' || queueLoaded
              ? 'Loading...'
              : 'Loading your reviews...'}
      </div>
    )
  }
  return (
    <div
      className="eva-rv"
      data-testid="review-place"
      data-review={ref ? reviewIdOf(ref) : undefined}
    >
      {body}
    </div>
  )
}
