import { BarChart, LineChart } from '@mantine/charts'
import { Stack, useComputedColorScheme } from '@mantine/core'
import type { ChartSpec } from '@evaos/chat-core/widget'
import { WidgetTitle } from './parts'

/**
 * Series colors when the spec names none (widgets.rs palette): blue, sand, sage, rose, slate,
 * a shade deeper in light mode so they hold on a pale surface.
 */
export const PALETTE = {
  dark: ['#7fa6de', '#d9b865', '#7fb89a', '#d98a8a', '#9a9a93'],
  light: ['#6b8fc4', '#c9a54e', '#6aa384', '#c87c7c', '#8a8a84'],
} as const

const CHART_H = 200

/** Recharts rows (one per point, keyed `s<n>` per series) and the matching Mantine series. */
export function chartData(spec: ChartSpec, palette: readonly string[]) {
  const length = Math.max(...spec.series.map((s) => s.points.length))
  const data = Array.from({ length }, (_, i) => {
    const row: Record<string, string | number> = { label: spec.labels?.[i] ?? String(i + 1) }
    spec.series.forEach((s, n) => {
      const point = s.points[i]
      if (point !== undefined) row[`s${n}`] = point
    })
    return row
  })
  const series = spec.series.map((s, n) => ({
    name: `s${n}`,
    label: s.name ?? (spec.series.length > 1 ? `Series ${n + 1}` : 'Value'),
    color: s.color ?? palette[n % palette.length]!,
  }))
  return { data, series }
}

export function ChartWidget({ spec }: { spec: ChartSpec }) {
  const scheme = useComputedColorScheme('light')
  const { data, series } = chartData(spec, PALETTE[scheme])
  const legend = series.length > 1
  const common = {
    h: CHART_H,
    data,
    dataKey: 'label',
    series,
    withLegend: legend,
    legendProps: { verticalAlign: 'bottom' as const, height: 28 },
    gridAxis: 'y' as const,
    tickLine: 'none' as const,
    strokeDasharray: '3 3',
  }
  return (
    <Stack gap="sm" data-testid="widget-chart">
      {spec.title !== undefined ? <WidgetTitle>{spec.title}</WidgetTitle> : null}
      {spec.kind === 'bar' ? (
        <BarChart {...common} type={spec.stacked ? 'stacked' : 'default'} />
      ) : (
        <LineChart {...common} curveType="monotone" withDots={data.length <= 24} />
      )}
    </Stack>
  )
}
