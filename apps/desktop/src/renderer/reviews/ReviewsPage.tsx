import { useCallback, useEffect, useState } from 'react'
import { notifications } from '@mantine/notifications'
import type { ReviewPr, ReviewRow, SlackRow } from '@evaos/contract'
import type { Place } from '@evaos/shell-core'
import { invoke } from '../ipc'
import { useReplacePlace } from '../pages/place-host'
import { ticketPlace } from '../tickets/ticket-place'
import { SlackDetail } from './SlackDetail'
import { ReviewsList } from './ReviewsList'
import { PrView } from './PrView'
import { nextAfter, prKey, queueGroups } from './review-model'
import { fail } from './review-ui'
import { loadQueue, reviewsStore, useReviews, useReviewsSurface } from './reviews-store'
import './reviews.css'

/**
 * Marks an item Done on the host and in the store; null (after a toast) when it fails. Shared by
 * the page and the places that show one item.
 */
export async function markDone(
  url: string,
  updatedAt: number,
): Promise<Record<string, number> | null> {
  const r = await invoke('reviews.done', { url, updatedAt, done: true })
  if (!r.ok) {
    fail("Couldn't mark it done", r.error.message)
    return null
  }
  reviewsStore.setState((s) => ({
    doneLocal: r.value,
    queue: s.queue ? { ...s.queue, done: r.value } : s.queue,
  }))
  return r.value
}

/**
 * A Linear issue a link asked Reviews to open goes on to its ticket page, in this page's own tab
 * (the Board's ticket page is the one Linear ticket view).
 */
function useTicketAsk(): void {
  const ask = useReviews((s) => s.ticketAsk)
  const replace = useReplacePlace()
  useEffect(() => {
    if (!ask || reviewsStore.getState().ticketAsk !== ask) return
    reviewsStore.setState({ ticketAsk: null })
    replace(ticketPlace(ask.key))
  }, [ask, replace])
}

/** Reviews: the pull request or Slack thread picked in the sidebar queue (Guide, Diff, Comments). */
export function ReviewsPage(_: { place: Place }) {
  useReviewsSurface()
  useTicketAsk()
  const queue = useReviews((s) => s.queue)
  const error = useReviews((s) => s.error)
  const view = useReviews((s) => s.view)
  const selected = useReviews((s) => s.selected)
  const thread = useReviews((s) => s.thread)
  const slack = useReviews((s) => s.slack)
  const [pr, setPr] = useState<{ key: string; pr: ReviewPr; at: number } | null>(null)
  const [prError, setPrError] = useState<string | null>(null)
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000)
    return () => clearInterval(t)
  }, [])

  const loadPr = useCallback(async (row: ReviewRow): Promise<boolean> => {
    setPrError(null)
    const r = await invoke('reviews.pr', { repo: row.repo, number: row.number })
    if (r.ok) setPr({ key: prKey(row), pr: r.value, at: Date.now() })
    else setPrError(r.error.message)
    return r.ok
  }, [])

  useEffect(() => {
    if (selected && pr?.key !== prKey(selected)) void loadPr(selected)
  }, [selected, pr, loadPr])

  const done = async (): Promise<void> => {
    if (!queue || !pr || !selected) return
    if (!(await markDone(pr.pr.url, Math.max(selected.updatedAt, pr.pr.updatedAt)))) return
    const next = nextAfter(queueGroups(reviewsStore.getState().queue ?? queue, view), pr.key)
    reviewsStore.setState({ selected: next })
    if (!next) setPr(null)
    notifications.show({ message: `Done: ${pr.pr.title}`, color: 'green' })
  }

  // Done holds a thread back until someone writes in it again.
  const doneThread = async (row: SlackRow): Promise<void> => {
    const marks = await markDone(row.url, row.updatedAt)
    if (!marks) return
    const rows = slack.queue?.rows ?? []
    const at = rows.findIndex((x) => x.url === row.url)
    const rest = rows.filter((x) => x.url !== row.url && !(marks[x.url]! >= x.updatedAt))
    reviewsStore.setState({ thread: rest[Math.min(Math.max(at, 0), rest.length - 1)] ?? null })
    notifications.show({ message: `Done: ${row.channelName}`, color: 'green' })
  }

  const shown = selected && pr?.key === prKey(selected) ? pr : null
  return (
    <div className="eva-rv" data-testid="reviews-page">
      {thread ? (
        <SlackDetail
          key={thread.url}
          row={thread}
          now={now}
          onBack={() => reviewsStore.setState({ thread: null })}
          onDone={() => void doneThread(thread)}
        />
      ) : error ? (
        <div className="eva-rv-placeholder eva-rv-error">Couldn't read GitHub: {error}</div>
      ) : shown ? (
        <PrView
          pr={shown.pr}
          fetchedAt={shown.at}
          now={now}
          onBack={() => {
            reviewsStore.setState({ selected: null })
            setPr(null)
          }}
          onRefresh={() => {
            if (selected) void loadPr(selected)
            void loadQueue(true)
          }}
          onReload={() => (selected ? loadPr(selected) : Promise.resolve(false))}
          onDone={() => void done()}
        />
      ) : selected || prError ? (
        <div className="eva-rv-placeholder eva-rv-dim">
          {prError ? `Couldn't load the pull request: ${prError}` : 'Loading the pull request...'}
        </div>
      ) : (
        <ReviewsList variant="page" />
      )}
    </div>
  )
}
