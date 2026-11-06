// Spend or requests per bucket of a range. Recharts primitives with Mantine's tooltip, measured
// like ActivityChart (Mantine's own charts wrap ResponsiveContainer, which jsdom sizes at zero).
import { ChartTooltip } from '@mantine/charts'
import { useElementSize } from '@mantine/hooks'
import { Bar, BarChart, CartesianGrid, Tooltip, XAxis, YAxis } from 'recharts'
import type { StatsPoint, StatsRangeKey } from '@evaos/contract'

const GRID = 'color-mix(in srgb, var(--eva-c-border) 50%, transparent)'
const DIM = 'var(--eva-c-muted-foreground)'

export interface SeriesBar {
  key: 'costUsd' | 'ok' | 'failed'
  label: string
  color: string
}

const hourTick = new Intl.DateTimeFormat('en-US', { hour: 'numeric' })
const dayTick = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' })
const hourFull = new Intl.DateTimeFormat('en-US', { weekday: 'short', hour: 'numeric' })
const dayFull = new Intl.DateTimeFormat('en-US', {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
})

export function SeriesChart({
  points,
  range,
  bars,
  format,
  axis = format,
  height,
  label,
  testid,
}: {
  points: readonly StatsPoint[]
  range: StatsRangeKey
  bars: SeriesBar[]
  format: (v: number) => string
  /** The y axis' labels; `format` when omitted. */
  axis?: (v: number) => string
  height: number
  label: string
  testid: string
}) {
  const { ref, width } = useElementSize()
  const hourly = range === '24h'
  const rows = points.map((p) => ({
    at: p.at,
    costUsd: p.costUsd,
    ok: p.requests - p.failed,
    failed: p.failed,
  }))
  const w = width || 600
  const barSize = Math.max(2, Math.floor((w / Math.max(rows.length, 1)) * 0.6))
  return (
    <div ref={ref} role="img" aria-label={label} data-testid={testid} style={{ height }}>
      <BarChart
        width={w}
        height={height}
        data={rows}
        margin={{ top: 4, right: 0, bottom: 0, left: 0 }}
      >
        <CartesianGrid vertical={false} stroke={GRID} />
        <XAxis
          dataKey="at"
          tickFormatter={(at: number) => (hourly ? hourTick : dayTick).format(at)}
          tickLine={false}
          axisLine={false}
          interval="preserveStartEnd"
          minTickGap={24}
          tick={{ fontSize: 12, fill: DIM }}
        />
        <YAxis
          width={56}
          tickFormatter={axis}
          tickLine={false}
          axisLine={false}
          tickCount={3}
          tick={{ fontSize: 12, fill: DIM }}
        />
        {bars.map((b, i) => (
          <Bar
            key={b.key}
            dataKey={b.key}
            stackId="one"
            fill={b.color}
            barSize={barSize}
            radius={i === bars.length - 1 ? [2, 2, 0, 0] : 0}
            isAnimationActive={false}
          />
        ))}
        <Tooltip
          cursor={{ fill: 'color-mix(in srgb, var(--eva-c-border) 40%, transparent)' }}
          content={({ payload, label: at }) => (
            <ChartTooltip
              label={typeof at === 'number' ? (hourly ? hourFull : dayFull).format(at) : ''}
              payload={(payload ?? []).map((p) => ({
                name: String(p.dataKey),
                dataKey: String(p.dataKey),
                value: p.value as number,
                color: bars.find((b) => b.key === p.dataKey)?.color ?? DIM,
                payload: p.payload as Record<string, unknown>,
              }))}
              series={bars.map((b) => ({ name: b.key, label: b.label, color: b.color }))}
              valueFormatter={format}
            />
          )}
        />
      </BarChart>
    </div>
  )
}
