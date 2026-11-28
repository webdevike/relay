import { useEffect, useLayoutEffect, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { IApi, IData } from '@svar-ui/react-gantt'
import { dateOfDay, type Day } from './plan-rules'
import type { DateLine } from './timeline-model'

type Scales = NonNullable<IData['_scales']>

export interface ChartArea {
  /** The x of a day's start in the chart's scrolling area. */
  xOf(day: Day): number
  /** Rows as shown (open summaries' children), for a ticket row's y. */
  rowTop(id: string): number | null
  rowHeight: number
}

/**
 * Portals `render(area)` into the chart's own scrolling `.wx-area` (SVAR-owned, found inside
 * `host`, our container), placed with the same scale math SVAR uses for bars:
 * `round(_scales.diff(date, _scales.start, lengthUnit) * cellWidth)`. Re-found whenever the
 * scale (zoom), the visible rows or the panel layout changes. This relies on SVAR's internal
 * `_scales`/`_tasks` state: the version is pinned (2.8.3) and an e2e check guards line x == bar edge.
 */
export function ChartOverlay({
  api,
  host,
  layoutKey,
  render,
}: {
  api: IApi
  host: HTMLElement
  layoutKey: string
  render: (area: ChartArea) => ReactNode
}) {
  const [scales, setScales] = useState<Scales | undefined>(() => api.getState()._scales)
  const [rows, setRows] = useState(() => api.getState()._tasks)
  const [node, setNode] = useState<HTMLElement | null>(null)
  useEffect(() => api.getReactiveState()._scales!.subscribe((s) => setScales(s as Scales)), [api])
  useEffect(() => api.getReactiveState()._tasks.subscribe((t) => setRows(t)), [api])
  useLayoutEffect(() => {
    setNode(host.querySelector<HTMLElement>('.wx-chart .wx-area'))
  }, [host, scales, layoutKey])
  if (!node || !scales) return null
  const { cellWidth = 1, cellHeight = 1 } = api.getState()
  const area: ChartArea = {
    xOf: (day) =>
      Math.round(scales.diff(dateOfDay(day), scales.start, scales.lengthUnit) * cellWidth),
    rowTop: (id) => {
      const i = rows.findIndex((t) => t.id === id)
      return i < 0 ? null : i * cellHeight
    },
    rowHeight: cellHeight,
  }
  return createPortal(render(area), node)
}

/** Milestone targets (end of the target day) and today: SVAR MIT ignores `markers`. */
export function DateLines({ lines, area }: { lines: readonly DateLine[]; area: ChartArea }) {
  return lines.map((l) => (
    <div
      key={l.id}
      className={`rb-line rb-line-${l.kind}`}
      data-line={l.id}
      style={{ left: area.xOf(l.at) }}
    >
      <span className="rb-line-label">{l.label}</span>
    </div>
  ))
}
