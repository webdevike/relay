import { Badge } from '@mantine/core'
import { useElementSize } from '@mantine/hooks'
import { useMemo, type ReactNode } from 'react'
import type { BoardWidget } from '@evaos/contract'
import type { Place } from '@evaos/shell-core'
import { WidgetBlock } from '../chat/widgets/Widget'
import { boardOf, boardSlugOf, useBoards } from './boards-store'
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

function Tile({ widget, stacked }: { widget: BoardWidget; stacked: boolean }) {
  // The spec draws like a ```ui fence; a tile that doesn't parse shows its JSON in place.
  const json = useMemo(() => JSON.stringify(widget.spec), [widget.spec])
  return (
    <div
      className="eva-board-tile"
      data-testid={`board-tile-${widget.id}`}
      style={{ gridColumn: `span ${stacked ? 12 : widget.span}` }}
    >
      <WidgetBlock json={json} />
    </div>
  )
}

/**
 * A Relay host dashboard (native boards::render): its title, workspace and last write, then its
 * tiles on a 12-column grid, left to right, each row wrapping when the next span does not fit.
 * Relay streams every write, so the page updates in place.
 */
export function BoardPage({ place }: { place: Place }) {
  const slug = boardSlugOf(place) ?? ''
  const data = useBoards((s) => s.data)
  const board = boardOf(data, slug)
  // Measured from the first render, so the grid stacks the moment the board arrives.
  const { ref, width } = useElementSize<HTMLDivElement>()
  const stacked = width > 0 && width < STACK_BELOW

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
          <h1 className="eva-board-title">{board.title}</h1>
          <div className="eva-board-meta">
            {board.workspace ? (
              <Badge size="sm" variant="light" color="gray" radius="sm" tt="none">
                {board.workspace}
              </Badge>
            ) : null}
            {board.updatedAt ? <span>Updated {updatedLabel(board.updatedAt)}</span> : null}
          </div>
        </div>
        {board.widgets.length === 0 ? (
          <p className="eva-board-dim">This dashboard has no widgets yet.</p>
        ) : (
          <div className="eva-board-grid" data-testid="board-grid">
            {board.widgets.map((w) => (
              <Tile key={w.id} widget={w} stacked={stacked} />
            ))}
          </div>
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
