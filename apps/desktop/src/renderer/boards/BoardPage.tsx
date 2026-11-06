import { Badge } from '@mantine/core'
import { useElementSize } from '@mantine/hooks'
import { useMemo, type ReactNode } from 'react'
import type { BoardWidget } from '@evaos/contract'
import type { Place } from '@evaos/shell-core'
import { OpenUIQuery } from '../chat/widgets/actions'
import { OpenUIBlock, WidgetBlock } from '../chat/widgets/Widget'
import { boardOf, boardSlugOf, useBoards } from './boards-store'
import { liveQuery } from './live-query'
import './boards.css'

/** Below this content width every tile takes the full row (native boards::STACK_BELOW). */
export const STACK_BELOW = 900

/** "Oct 7, 3:04 PM" in local time, or the stamp as written when it is not a date. */
export function updatedLabel(stamp: string): string {
  const at = new Date(stamp)
  if (Number.isNaN(at.getTime())) return stamp
  return at.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

/**
 * One tile. A live tile (its `openui` source, on a host that answers queries) runs its Query
 * statements while on screen, refreshing on their own intervals; otherwise the spec draws like a
 * ```ui fence (for a live tile, the host's render of it at write time). A tile that doesn't parse
 * shows its source in place.
 */
function Tile({ widget, stacked, live }: { widget: BoardWidget; stacked: boolean; live: boolean }) {
  const json = useMemo(() => JSON.stringify(widget.spec), [widget.spec])
  const openui = live ? widget.openui : undefined
  return (
    <div
      className="eva-board-tile"
      data-testid={`board-tile-${widget.id}`}
      data-live={openui !== undefined || undefined}
      style={{ gridColumn: `span ${stacked ? 12 : widget.span}` }}
    >
      {openui !== undefined ? <OpenUIBlock code={openui} closed /> : <WidgetBlock json={json} />}
    </div>
  )
}

/**
 * A Relay host dashboard (native boards::render): its title, workspace and last write, then its
 * tiles on a 12-column grid, left to right, each row wrapping when the next span does not fit.
 * Relay streams every write, so the page updates in place; live tiles refresh their own data.
 */
export function BoardPage({ place }: { place: Place }) {
  const slug = boardSlugOf(place) ?? ''
  const data = useBoards((s) => s.data)
  const board = boardOf(data, slug)
  // Measured from the first render, so the grid stacks the moment the board arrives.
  const { ref, width } = useElementSize<HTMLDivElement>()
  const stacked = width > 0 && width < STACK_BELOW
  // Live tiles run only on a host that answers queries; an older one's tiles draw their spec.
  const live = data?.queries === true && board?.widgets.some((w) => w.openui !== undefined) === true

  let body: ReactNode = null
  if (data !== null && board === null) {
    body = (
      <div className="eva-board-empty" data-testid={`board-missing-${slug}`}>
        <h2 className="eva-board-empty-title">No such dashboard</h2>
        <p className="eva-board-dim">
          {data.relayUp
            ? `${slug} isn't on the Relay host.`
            : "Relay isn't running, so its dashboards can't be shown."}
        </p>
      </div>
    )
  } else if (board !== null) {
    body = (
      <>
        <div className="eva-board-head">
          <h1 className="eva-board-title" data-page-title>
            {board.title}
          </h1>
          <div className="eva-board-meta">
            {board.workspace ? (
              <Badge size="sm" variant="light" color="gray" radius="sm" tt="none">
                {board.workspace}
              </Badge>
            ) : null}
            {board.updatedAt ? <span>Updated {updatedLabel(board.updatedAt)}</span> : null}
            {live ? (
              <Badge size="sm" variant="light" color="green" radius="sm" tt="none">
                Live
              </Badge>
            ) : null}
          </div>
        </div>
        {board.widgets.length === 0 ? (
          <p className="eva-board-dim">This dashboard has no widgets yet.</p>
        ) : (
          <OpenUIQuery.Provider value={liveQuery}>
            <div className="eva-board-grid" data-testid="board-grid">
              {board.widgets.map((w) => (
                <Tile key={w.id} widget={w} stacked={stacked} live={live} />
              ))}
            </div>
          </OpenUIQuery.Provider>
        )}
      </>
    )
  }
  return (
    <div className="eva-board-col" data-testid={`board-${slug}`} ref={ref}>
      {body}
    </div>
  )
}
