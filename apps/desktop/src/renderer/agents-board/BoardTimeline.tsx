import { useEffect, useState } from 'react'
import { Text } from '@mantine/core'
import { TicketsBoard, type TicketBoardFacts } from '@relay/protocol'
import { invoke, on } from '../ipc'
import { openPlace } from '../navigation/navigate'
import { ticketPlace } from '../tickets/ticket-place'
import { TimelineView } from './timeline/TimelineView'

interface TimelineTickets {
  tickets: TicketBoardFacts[]
  /** Why there is nothing to plan: no host tickets (its fallback line) or the read failed. */
  note: string | null
}

async function readTickets(): Promise<TimelineTickets> {
  const r = await invoke('tickets.board', {})
  if (!r.ok) return { tickets: [], note: r.error.message }
  if (r.value.source === 'fallback') return { tickets: [], note: r.value.message }
  const board = TicketsBoard.safeParse(r.value.board)
  if (!board.success)
    return { tickets: [], note: 'The Mini’s Relay Host sent tickets this app can’t read.' }
  return { tickets: board.data.tickets, note: null }
}

/** The host's synced tickets, read again on every `tickets.changed` (the newest read wins). */
function useTimelineTickets(): TimelineTickets | null {
  const [data, setData] = useState<TimelineTickets | null>(null)
  useEffect(() => {
    let latest = 0
    const load = (): void => {
      const ask = ++latest
      void readTickets().then((d) => {
        if (ask === latest) setData(d)
      })
    }
    load()
    const off = on('tickets.changed', load)
    return () => {
      latest = -1
      off()
    }
  }, [])
  return data
}

/**
 * The Board's Timeline view over the host's synced tickets. Without host sync (fallback) it shows
 * why, and the chart only reads: no drafts, no Apply, no re-plan.
 */
export function BoardTimeline() {
  const data = useTimelineTickets()
  if (!data)
    return (
      <div className="eva-ab-loading" data-testid="timeline-loading">
        Reading tickets
      </div>
    )
  return (
    <div className="rb-timeline-pane">
      {data.note ? (
        <Text size="xs" c="dimmed" className="rb-timeline-note" data-testid="timeline-fallback">
          {data.note}
        </Text>
      ) : null}
      <TimelineView
        tickets={data.tickets}
        onOpen={(key) => openPlace(ticketPlace(key))}
        readOnly={data.note !== null}
      />
    </div>
  )
}
