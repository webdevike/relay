import { useEffect } from 'react'
import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import type { LinearRow, ReviewQueue, ReviewRow, SlackRow } from '@evaos/contract'
import { invoke } from '../ipc'
import type { SlackState } from './SlackDetail'

export type ReviewsView = 'for-me' | 'created'

/**
 * Reviews as two surfaces share it: the queue lives in the sliding sidebar, the selected item's
 * detail in the page. Selection is exclusive: at most one of a pull request, ticket or thread.
 */
export interface ReviewsState {
  queue: ReviewQueue | null
  error: string | null
  view: ReviewsView
  selected: ReviewRow | null
  ticket: LinearRow | null
  thread: SlackRow | null
  linear: { rows: LinearRow[] | null; error: string | null }
  slack: SlackState
  /** Done marks from the last Done here, so a ticket hides even when GitHub could not be read. */
  doneLocal: Record<string, number>
  /** Back to the queue stays there: the first PR opens by itself only once. */
  autoOpened: boolean
}

const initial = (): ReviewsState => ({
  queue: null,
  error: null,
  view: 'for-me',
  selected: null,
  ticket: null,
  thread: null,
  linear: { rows: null, error: null },
  slack: { queue: null, reading: false, error: null },
  doneLocal: {},
  autoOpened: false,
})

export const reviewsStore = createStore<ReviewsState>(initial)

export function useReviews<T>(selector: (s: ReviewsState) => T): T {
  return useStore(reviewsStore, selector)
}

const set = (p: Partial<ReviewsState>): void => reviewsStore.setState(p)

export async function loadQueue(refresh: boolean): Promise<void> {
  const r = await invoke('reviews.queue', { refresh })
  if (r.ok) set({ queue: r.value, error: null })
  else set({ error: r.error.message })
}

export async function loadLinear(refresh: boolean): Promise<void> {
  const r = await invoke('reviews.linearQueue', { refresh })
  set({ linear: r.ok ? { rows: r.value, error: null } : { rows: null, error: r.error.message } })
}

/** Slack is read through Astra's connector (tens of seconds): show the last read, then read again. */
export async function readSlack(): Promise<void> {
  reviewsStore.setState((s) => ({ slack: { ...s.slack, reading: true } }))
  const r = await invoke('reviews.slackQueue', { refresh: true })
  reviewsStore.setState((s) => ({
    slack: r.ok
      ? { queue: r.value, reading: false, error: null }
      : { ...s.slack, reading: false, error: r.error.message },
  }))
}

function loadAll(): void {
  void loadQueue(false)
  void loadLinear(false)
  void invoke('reviews.slackQueue', { refresh: false }).then((r) => {
    if (r.ok && r.value) {
      reviewsStore.setState((s) => (s.slack.queue ? s : { slack: { ...s.slack, queue: r.value } }))
    }
  })
  void readSlack()
}

export function setView(view: ReviewsView): void {
  set({ view, selected: null, ticket: null, thread: null, autoOpened: false })
}

export function openPr(row: ReviewRow): void {
  set({ ticket: null, thread: null, selected: row })
}

export function openTicket(row: LinearRow): void {
  set({ selected: null, thread: null, ticket: row })
}

export function openThread(row: SlackRow): void {
  set({ selected: null, ticket: null, thread: row })
}

let mounted = 0

/** Ref-counted: the first Reviews surface (sidebar queue or page) to mount reads everything. */
export function mountReviews(): () => void {
  if (mounted++ === 0) loadAll()
  let done = false
  return () => {
    if (done) return
    done = true
    mounted--
  }
}

export function useReviewsSurface(): void {
  useEffect(() => mountReviews(), [])
}

export function resetReviewsForTests(): void {
  mounted = 0
  reviewsStore.setState(initial(), true)
}
