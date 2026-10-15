/*
 * Hatch spike decision (research OQ1, Pitfall 2): Path B.
 * Evidence: node_modules/@mantine/charts/esm/CompositeChart/CompositeChart.mjs
 * - line 164-170 maps referenceAreas through getThemeColor and forces a fill
 *   opacity of .2 plus a stroke, so a pattern fill cannot be shown as a plain hatch;
 * - bars take one series color, with no per-cell fill, so the accent "today" bar
 *   cannot be expressed;
 * - the chart is wrapped in ResponsiveContainer, which reports 0 size in jsdom.
 * So the chart uses Recharts primitives (ComposedChart) directly, styled with the
 * Mantine charts ChartTooltip. Path A was not adopted.
 */
import { useId } from 'react'
import { useElementSize } from '@mantine/hooks'
import { ChartTooltip } from '@mantine/charts'
import {
  Bar,
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  ReferenceArea,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import './activity-chart.css'

export interface ActivityRow {
  date: string
  tick: string
  count: number
  inWeek: boolean
  isToday: boolean
}

export interface ActivityChartProps {
  rows: ActivityRow[]
  name: string
  rangeLabel: '7 days' | '30 days' | '90 days'
  height: number
  testid?: string
  /** Fixed width in px; measured from the wrapper when omitted. */
  width?: number
}

const ACCENT = 'var(--eva-c-primary-background)'
const MUTED = 'color-mix(in srgb, var(--eva-c-muted-foreground) 40%, transparent)'
const HATCH_LINE = 'color-mix(in srgb, var(--eva-c-primary-background) 35%, transparent)'
const GRID = 'color-mix(in srgb, var(--eva-c-border) 50%, transparent)'
const DIM = 'var(--eva-c-muted-foreground)'

export function ActivityChart({
  rows,
  name,
  rangeLabel,
  height,
  testid,
  width,
}: ActivityChartProps) {
  const { ref, width: measured } = useElementSize()
  const patternId = useId()
  void patternId
  const w = width ?? (measured || 600)
  const total = rows.reduce((sum, r) => sum + r.count, 0)
  const weekRows = rows.filter((r) => r.inWeek)
  const first = weekRows[0]
  const last = weekRows[weekRows.length - 1]
  const barSize = Math.max(2, Math.floor((w / Math.max(rows.length, 1)) * 0.6))

  return (
    <div
      ref={ref}
      className="eva-activity-chart"
      role="img"
      aria-label={`Activity for ${name}: ${total} updates in ${rangeLabel}`}
      data-testid={testid}
      style={{ height }}
    >
      <ComposedChart
        width={w}
        height={height}
        data={rows}
        margin={{ top: 16, right: 4, bottom: 0, left: 4 }}
      >
        <defs>
          <pattern
            id="eva-hatch"
            patternUnits="userSpaceOnUse"
            width="4"
            height="4"
            patternTransform="rotate(45)"
          >
            <line x1="0" y1="0" x2="0" y2="4" stroke={HATCH_LINE} strokeWidth="1" />
          </pattern>
        </defs>
        <CartesianGrid vertical={false} stroke={GRID} />
        <XAxis
          dataKey="tick"
          tickLine={false}
          axisLine={false}
          interval="preserveStartEnd"
          tick={{ fontSize: 12, fill: DIM }}
        />
        <YAxis hide allowDecimals={false} />
        {first && last && (
          <ReferenceArea
            x1={first.tick}
            x2={last.tick}
            fill="url(#eva-hatch)"
            stroke="none"
            ifOverflow="visible"
            label={{ value: 'This week', position: 'insideTopLeft', fill: DIM, fontSize: 12 }}
          />
        )}
        <Bar
          dataKey="count"
          barSize={barSize}
          radius={2}
          minPointSize={1}
          isAnimationActive={false}
        >
          {rows.map((r) => (
            <Cell key={r.date} fill={r.isToday ? ACCENT : MUTED} />
          ))}
        </Bar>
        <Line
          type="monotone"
          dataKey="count"
          stroke={ACCENT}
          strokeWidth={2}
          dot={false}
          isAnimationActive={false}
        />
        <Tooltip
          content={({ payload, label }) => (
            <ChartTooltip
              label={String(label ?? '')}
              payload={(payload ?? [])
                .filter((p) => p.dataKey === 'count')
                .slice(0, 1)
                .map((p) => ({
                  name: 'count',
                  dataKey: 'count',
                  value: p.value as number,
                  color: ACCENT,
                  payload: p.payload as Record<string, unknown>,
                }))}
              series={[{ name: 'count', label: 'updates', color: ACCENT }]}
              valueFormatter={(v) => `${v} updates`}
            />
          )}
        />
      </ComposedChart>
      {total === 0 && <div className="eva-activity-chart-empty">No activity in this range</div>}
      <table className="eva-visually-hidden">
        <caption>{`Activity for ${name}`}</caption>
        <thead>
          <tr>
            <th>Date</th>
            <th>Updates</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.date}>
              <td>{r.date}</td>
              <td>{r.count}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
