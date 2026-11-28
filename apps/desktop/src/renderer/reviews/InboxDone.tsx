import { Button, Tooltip } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { IconCheck } from '@tabler/icons-react'
import { placeOf } from '@evaos/shell-core'
import { historyJump, navHistoryStore } from '../navigation/nav-history'
import { useReplacePlace } from '../pages/place-host'
import { markDone } from './ReviewsPage'
import { inboxTicket, useReviews } from './reviews-store'

/** The history index of the Reviews page this tab came from (the entry just before), else null. */
export function reviewsBefore(): number | null {
  const h = navHistoryStore.getState()
  const here = h.entries[h.index]
  const prev = h.entries[h.index - 1]
  return here && prev?.tab === here.tab && prev.place.page === 'reviews' ? h.index - 1 : null
}

/**
 * Reviews' Done in a ticket page's header, while the ticket waits in the Reviews inbox: the same
 * `reviews.done` mark its inbox row got (held back until it changes), then on to the Reviews page,
 * as Done on a review always did. Nothing is written to Linear.
 */
export function InboxDone({ ticketKey, title }: { ticketKey: string; title: string }) {
  const row = useReviews((s) => inboxTicket(s, ticketKey))
  const replace = useReplacePlace()
  if (!row) return null
  const done = async (): Promise<void> => {
    if (!(await markDone(row.url, Math.max(row.updatedAt, Date.now())))) return
    notifications.show({ message: `Done: ${ticketKey} ${title}`, color: 'green' })
    const back = reviewsBefore()
    if (back === null) replace(placeOf('reviews'))
    else historyJump(back)
  }
  return (
    <Tooltip label="Clear it from your Reviews inbox until it changes" openDelay={300}>
      <Button
        size="xs"
        variant="default"
        leftSection={<IconCheck size={14} />}
        onClick={() => void done()}
        data-testid="review-done"
      >
        Done
      </Button>
    </Tooltip>
  )
}
